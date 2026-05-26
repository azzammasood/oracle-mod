import type { RedditAPIClient, RedisClient } from '@devvit/public-api';

import type { PredictionRecord } from './types.js';
import { humanTime, riskEmoji, riskLabel } from './utils.js';

const LAST_ALERT_KEY = 'oracle:lastAlert';

function dominantSignal(prediction: PredictionRecord): keyof PredictionRecord['signals'] {
  const signals = prediction.signals;
  const entries: Array<[keyof PredictionRecord['signals'], number]> = [
    ['commentVelocity', signals.commentVelocity],
    ['newAccountSurge', signals.newAccountSurge],
    ['reportRate', signals.reportRate],
    ['authorHistory', signals.authorHistory],
    ['titleSensitivity', signals.titleSensitivity],
  ];

  return entries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'commentVelocity';
}

function narrativeSummary(prediction: PredictionRecord): string {
  const signal = dominantSignal(prediction);
  const { signals, signalMeta } = prediction;

  if (signal === 'commentVelocity' && signals.commentVelocity > 15) {
    return `This thread is growing ${signalMeta.velocityRatio.toFixed(1)}x faster than your subreddit baseline.`;
  }

  if (signal === 'newAccountSurge' && signals.newAccountSurge > 15) {
    return 'Over half the early commenters appear to be first-time or infrequent contributors, which can indicate external traffic.';
  }

  if (signal === 'authorHistory' && signals.authorHistory > 8) {
    const plural = signalMeta.removalCount === 1 ? '' : 's';
    return `This author has had ${signalMeta.removalCount} post${plural} removed in this subreddit previously.`;
  }

  if (signal === 'titleSensitivity' && signals.titleSensitivity > 4) {
    const plural = signalMeta.titleMatchCount === 1 ? '' : 's';
    return `The post title contains ${signalMeta.titleMatchCount} marker${plural} commonly associated with heated threads.`;
  }

  return 'Multiple signals are elevated simultaneously. Watch this thread closely.';
}

function suggestedActions(prediction: PredictionRecord): string {
  switch (prediction.signals.level) {
    case 'critical':
      return '• Open thread immediately\n• Consider locking if brigade behavior is confirmed\n• Check mod queue for reports';
    case 'high':
      return '• Monitor thread for the next 15 minutes\n• Check the report queue\n• Consider a sticky reminder if discussion is drifting';
    case 'moderate':
      return '• Keep an eye on this thread\n• No immediate action needed';
    case 'low':
      return '• No action needed';
  }
}

function buildAlertBody(prediction: PredictionRecord): string {
  const { signals, signalMeta } = prediction;
  const levelLabel = riskLabel(signals.level);
  const emoji = riskEmoji(signals.level);
  const minutesSincePost = Math.max(0, Math.round((prediction.predictedAt - prediction.submittedAt) / 60_000));
  const baseline = signalMeta.baselineAvg.toFixed(1);
  const newAccountPct = Math.round(signalMeta.newAccountPct * 100);
  const removalPlural = signalMeta.removalCount === 1 ? '' : 's';

  return `🔮 **Oracle Early Warning**
━━━━━━━━━━━━━━━━━━━━━━━━━

**Risk Score: ${signals.total}/100** — ${emoji} ${levelLabel}
**Thread:** [${prediction.postTitle}](${prediction.postPermalink})
**Author:** u/${prediction.authorName}
**Predicted at:** ${humanTime(prediction.predictedAt)} (${minutesSincePost} min after posting)

**Signal Breakdown:**
💬 Comment velocity:   ${signals.commentVelocity}/25 pts — ${signalMeta.commentCount} comments in 5 min (baseline: ${baseline} avg)
👤 New account surge:  ${signals.newAccountSurge}/25 pts — ${newAccountPct}% of commenters appear new or infrequent
🚨 Report rate:        ${signals.reportRate}/20 pts — ${signalMeta.reportCount} reports observed
📜 Author history:     ${signals.authorHistory}/20 pts — ${signalMeta.removalCount} prior removal${removalPlural} in this sub
🎯 Title sensitivity:  ${signals.titleSensitivity}/10 pts — ${signalMeta.titleMatchCount} marker(s): ${signalMeta.titleMatches.join(', ') || 'none'}

**Why Oracle flagged this:**
${narrativeSummary(prediction)}

**Suggested actions:**
${suggestedActions(prediction)}

━━━━━━━━━━━━━━━━━━━━━━━━━
*Oracle — sees the future of your threads.*
*To mark outcome: Mod Tools → Oracle → Mark as Intervened/False Alarm*`;
}

export async function maybeSendAlert(
  prediction: PredictionRecord,
  threshold: number,
  cooldownMs: number,
  reddit: RedditAPIClient,
  subredditName: string,
  redis: RedisClient
): Promise<boolean> {
  try {
    if (prediction.signals.total < threshold) {
      return false;
    }

    const lastAlertRaw = await redis.get(LAST_ALERT_KEY);
    const lastAlertTime = lastAlertRaw ? Number.parseInt(lastAlertRaw, 10) : 0;
    if (lastAlertTime && Date.now() - lastAlertTime < cooldownMs) {
      return false;
    }

    await reddit.modMail.createConversation({
      subredditName,
      subject: `🔮 Oracle Alert — Risk Score ${prediction.signals.total}/100 [${prediction.signals.level.toUpperCase()}]`,
      body: buildAlertBody(prediction),
      isAuthorHidden: true,
      to: null,
    });

    await redis.set(LAST_ALERT_KEY, Date.now().toString());
    return true;
  } catch (e) {
    console.error('[Oracle] maybeSendAlert failed:', e);
    return false;
  }
}
