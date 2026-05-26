import type { RedisClient } from '@devvit/public-api';

import type {
  AuthorRecord,
  OracleStats,
  PredictionOutcome,
  PredictionRecord,
  SubredditBaseline,
} from './types.js';
import { normalizeAuthorName } from './utils.js';

const BASELINE_KEY = 'oracle:baseline';
const RECENT_KEY = 'oracle:recent';
const STATS_KEY = 'oracle:stats';

const defaultBaseline: SubredditBaseline = {
  avgCommentsPer5Min: 0,
  totalPostsSampled: 0,
  lastUpdated: 0,
};

const defaultStats: OracleStats = {
  totalPredictions: 0,
  alertsSent: 0,
  intervenedCount: 0,
  falseAlarmCount: 0,
};

function authorKey(authorName: string): string {
  return `oracle:author:${normalizeAuthorName(authorName).toLowerCase()}`;
}

function predictionKey(postId: string): string {
  return `oracle:prediction:${postId}`;
}

async function readJson<T>(redis: RedisClient, key: string, fallback: T): Promise<T> {
  try {
    const raw = await redis.get(key);
    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`[Oracle] Failed to read ${key}:`, e);
    return fallback;
  }
}

async function writeJson<T>(redis: RedisClient, key: string, value: T): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value));
  } catch (e) {
    console.error(`[Oracle] Failed to write ${key}:`, e);
  }
}

export async function getBaseline(redis: RedisClient): Promise<SubredditBaseline> {
  return readJson(redis, BASELINE_KEY, defaultBaseline);
}

export async function updateBaseline(redis: RedisClient, commentCount: number): Promise<void> {
  try {
    const baseline = await getBaseline(redis);
    const cappedSamples = Math.min(Math.max(0, baseline.totalPostsSampled), 199);
    const newTotal = Math.min(cappedSamples + 1, 200);
    const weightedTotal = baseline.avgCommentsPer5Min * cappedSamples + Math.max(0, commentCount);
    const next: SubredditBaseline = {
      avgCommentsPer5Min: newTotal === 0 ? 0 : weightedTotal / newTotal,
      totalPostsSampled: newTotal,
      lastUpdated: Date.now(),
    };

    await writeJson(redis, BASELINE_KEY, next);
  } catch (e) {
    console.error('[Oracle] updateBaseline failed:', e);
  }
}

export async function getAuthorRecord(redis: RedisClient, authorName: string): Promise<AuthorRecord> {
  const normalized = normalizeAuthorName(authorName);
  return readJson(redis, authorKey(normalized), {
    authorName: normalized,
    removalCount: 0,
    lastSeen: 0,
  });
}

export async function incrementAuthorRemoval(redis: RedisClient, authorName: string): Promise<void> {
  try {
    const normalized = normalizeAuthorName(authorName);
    if (normalized === 'unknown') {
      return;
    }

    const record = await getAuthorRecord(redis, normalized);
    await writeJson(redis, authorKey(normalized), {
      ...record,
      authorName: normalized,
      removalCount: record.removalCount + 1,
      lastSeen: Date.now(),
    });
  } catch (e) {
    console.error('[Oracle] incrementAuthorRemoval failed:', e);
  }
}

export async function savePrediction(redis: RedisClient, prediction: PredictionRecord): Promise<void> {
  try {
    const key = predictionKey(prediction.postId);
    const existing = await readJson<PredictionRecord | null>(redis, key, null);

    await writeJson(redis, key, prediction);

    const recent = await readJson<string[]>(redis, RECENT_KEY, []);
    const nextRecent = [prediction.postId, ...recent.filter((postId) => postId !== prediction.postId)].slice(0, 50);
    await writeJson(redis, RECENT_KEY, nextRecent);

    const stats = await getStats(redis);
    if (!existing) {
      stats.totalPredictions += 1;
      if (prediction.alertSent) {
        stats.alertsSent += 1;
      }
    } else if (!existing.alertSent && prediction.alertSent) {
      stats.alertsSent += 1;
    } else if (existing.alertSent && !prediction.alertSent) {
      stats.alertsSent = Math.max(0, stats.alertsSent - 1);
    }

    await writeJson(redis, STATS_KEY, stats);
  } catch (e) {
    console.error('[Oracle] savePrediction failed:', e);
  }
}

export async function getRecentPredictions(redis: RedisClient): Promise<PredictionRecord[]> {
  try {
    const recent = await readJson<string[]>(redis, RECENT_KEY, []);
    const predictions: PredictionRecord[] = [];

    for (const postId of recent) {
      const prediction = await readJson<PredictionRecord | null>(redis, predictionKey(postId), null);
      if (prediction) {
        predictions.push(prediction);
      }
    }

    return predictions;
  } catch (e) {
    console.error('[Oracle] getRecentPredictions failed:', e);
    return [];
  }
}

export async function deletePrediction(redis: RedisClient, postId: string): Promise<void> {
  try {
    const key = predictionKey(postId);
    const prediction = await readJson<PredictionRecord | null>(redis, key, null);
    await redis.del(key);

    const recent = await readJson<string[]>(redis, RECENT_KEY, []);
    await writeJson(
      redis,
      RECENT_KEY,
      recent.filter((recentPostId) => recentPostId !== postId)
    );

    if (prediction) {
      const stats = await getStats(redis);
      stats.totalPredictions = Math.max(0, stats.totalPredictions - 1);
      if (prediction.alertSent) {
        stats.alertsSent = Math.max(0, stats.alertsSent - 1);
      }
      if (prediction.outcome === 'intervened') {
        stats.intervenedCount = Math.max(0, stats.intervenedCount - 1);
      }
      if (prediction.outcome === 'false_alarm') {
        stats.falseAlarmCount = Math.max(0, stats.falseAlarmCount - 1);
      }
      await writeJson(redis, STATS_KEY, stats);
    }
  } catch (e) {
    console.error('[Oracle] deletePrediction failed:', e);
  }
}

export async function getStats(redis: RedisClient): Promise<OracleStats> {
  return readJson(redis, STATS_KEY, defaultStats);
}

export async function updatePredictionOutcome(
  redis: RedisClient,
  postId: string,
  outcome: Extract<PredictionOutcome, 'intervened' | 'false_alarm'>
): Promise<void> {
  try {
    const key = predictionKey(postId);
    const prediction = await readJson<PredictionRecord | null>(redis, key, null);
    if (!prediction) {
      return;
    }

    const previousOutcome = prediction.outcome;
    prediction.outcome = outcome;
    prediction.outcomeUpdatedAt = Date.now();
    await writeJson(redis, key, prediction);

    const stats = await getStats(redis);
    if (previousOutcome === 'intervened') {
      stats.intervenedCount = Math.max(0, stats.intervenedCount - 1);
    }
    if (previousOutcome === 'false_alarm') {
      stats.falseAlarmCount = Math.max(0, stats.falseAlarmCount - 1);
    }
    if (outcome === 'intervened') {
      stats.intervenedCount += 1;
    }
    if (outcome === 'false_alarm') {
      stats.falseAlarmCount += 1;
    }

    await writeJson(redis, STATS_KEY, stats);
  } catch (e) {
    console.error('[Oracle] updatePredictionOutcome failed:', e);
  }
}
