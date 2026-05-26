import type { Comment } from '@devvit/public-api';

import type {
  AuthorRecord,
  PredictionAnalysis,
  RiskLevel,
  SignalBreakdown,
  SignalMeta,
  SubredditBaseline,
} from './types.js';

const fiveMinMs = 5 * 60 * 1000;

const controversyMarkers = [
  'controversial',
  'unpopular opinion',
  'fight',
  'war',
  'versus',
  ' vs ',
  'debate',
  'hot take',
  'change my mind',
  'worst',
  'best',
  'overrated',
  'underrated',
];

const emotionalMarkers = [
  'please',
  'urgent',
  'need help',
  'rant',
  'venting',
  'frustrated',
  'angry',
  'hate',
  'disgusting',
  'outrage',
  'shocking',
  'insane',
  'unbelievable',
];

const questionBaitMarkers = [
  'why do',
  'why are',
  'why is',
  'how can',
  'should i',
  'am i wrong',
  'is it wrong',
  'am i bad',
  'aita',
];

const allTitleMarkers = [...controversyMarkers, ...emotionalMarkers, ...questionBaitMarkers];

type ComputeRiskParams = {
  postId: string;
  postTitle: string;
  authorName: string;
  comments: Comment[];
  reportCount: number;
  baseline: SubredditBaseline;
  authorRecord: AuthorRecord;
  postSubmittedAt: number;
};

function getRiskLevel(score: number): RiskLevel {
  if (score <= 25) {
    return 'low';
  }
  if (score <= 50) {
    return 'moderate';
  }
  if (score <= 74) {
    return 'high';
  }
  return 'critical';
}

function zeroAnalysis(): PredictionAnalysis {
  const signals: SignalBreakdown = {
    commentVelocity: 0,
    newAccountSurge: 0,
    reportRate: 0,
    authorHistory: 0,
    titleSensitivity: 0,
    total: 0,
    level: 'low',
  };

  const meta: SignalMeta = {
    commentCount: 0,
    baselineAvg: 0,
    velocityRatio: 0,
    uniqueAuthors: 0,
    likelyNewAccounts: 0,
    newAccountPct: 0,
    reportCount: 0,
    removalCount: 0,
    titleMatchCount: 0,
    titleMatches: [],
  };

  return { signals, meta };
}

export async function computeRiskScore(params: ComputeRiskParams): Promise<PredictionAnalysis> {
  try {
    const commentCount = params.comments.length;
    let velocityRatio = 0;
    let commentVelocity = 0;

    if (params.baseline.totalPostsSampled >= 5 && params.baseline.avgCommentsPer5Min > 0) {
      velocityRatio = commentCount / params.baseline.avgCommentsPer5Min;
      commentVelocity = Math.min(25, Math.max(0, (velocityRatio - 1) * 25));
    }

    const earlyComments = params.comments.filter((comment) => {
      const createdAtMs = comment.createdAt?.getTime();
      if (!createdAtMs) {
        return false;
      }

      return createdAtMs - params.postSubmittedAt <= fiveMinMs;
    });

    const authorCommentCount: Record<string, number> = {};
    for (const comment of earlyComments) {
      const authorName = comment.authorName || 'unknown';
      authorCommentCount[authorName] = (authorCommentCount[authorName] ?? 0) + 1;
    }

    const uniqueAuthors = Object.keys(authorCommentCount).length;
    const likelyNewAccounts = Object.values(authorCommentCount).filter((count) => count === 1).length;
    const newAccountPct = uniqueAuthors > 0 ? likelyNewAccounts / uniqueAuthors : 0;
    const newAccountSurge = Math.min(25, newAccountPct * 0.5 * 100);

    const reportRate = Math.min(20, (Math.max(0, params.reportCount) / Math.max(commentCount, 1)) * 40);

    const removalCount = Math.max(0, params.authorRecord.removalCount);
    const authorHistory = removalCount === 0 ? 0 : removalCount === 1 ? 8 : removalCount === 2 ? 14 : 20;

    const title = ` ${params.postTitle.toLowerCase()} `;
    const titleMatches = allTitleMarkers.filter((marker) => title.includes(marker));
    const titleSensitivity = Math.min(10, titleMatches.length * 2);

    const total = Math.min(
      100,
      Math.round(commentVelocity + newAccountSurge + reportRate + authorHistory + titleSensitivity)
    );

    return {
      signals: {
        commentVelocity: Math.round(commentVelocity),
        newAccountSurge: Math.round(newAccountSurge),
        reportRate: Math.round(reportRate),
        authorHistory,
        titleSensitivity: Math.round(titleSensitivity),
        total,
        level: getRiskLevel(total),
      },
      meta: {
        commentCount,
        baselineAvg: params.baseline.avgCommentsPer5Min,
        velocityRatio,
        uniqueAuthors,
        likelyNewAccounts,
        newAccountPct,
        reportCount: Math.max(0, params.reportCount),
        removalCount,
        titleMatchCount: titleMatches.length,
        titleMatches,
      },
    };
  } catch (e) {
    console.error('[Oracle] computeRiskScore failed:', e);
    return zeroAnalysis();
  }
}
