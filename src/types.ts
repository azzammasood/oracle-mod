export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical';

export type PredictionOutcome = 'pending' | 'intervened' | 'false_alarm' | 'unknown';

export interface SignalBreakdown {
  commentVelocity: number;
  newAccountSurge: number;
  reportRate: number;
  authorHistory: number;
  titleSensitivity: number;
  total: number;
  level: RiskLevel;
}

export interface SignalMeta {
  commentCount: number;
  baselineAvg: number;
  velocityRatio: number;
  uniqueAuthors: number;
  likelyNewAccounts: number;
  newAccountPct: number;
  reportCount: number;
  removalCount: number;
  titleMatchCount: number;
  titleMatches: string[];
}

export interface PredictionRecord {
  postId: string;
  postTitle: string;
  postPermalink: string;
  authorName: string;
  subredditName: string;
  predictedAt: number;
  submittedAt: number;
  signals: SignalBreakdown;
  signalMeta: SignalMeta;
  alertSent: boolean;
  outcome: PredictionOutcome;
  outcomeUpdatedAt: number | null;
}

export interface SubredditBaseline {
  avgCommentsPer5Min: number;
  totalPostsSampled: number;
  lastUpdated: number;
}

export interface AuthorRecord {
  authorName: string;
  removalCount: number;
  lastSeen: number;
}

export interface OracleStats {
  totalPredictions: number;
  alertsSent: number;
  intervenedCount: number;
  falseAlarmCount: number;
}

export interface DashboardData {
  recentPredictions: PredictionRecord[];
  stats: OracleStats & {
    accuracy: number | null;
  };
  baseline: SubredditBaseline;
  settings?: DashboardSettings;
}

export interface DashboardSettings {
  alertThreshold: number;
  alertCooldownMinutes: number;
  predictionWindowMinutes: number;
  muteAlerts: boolean;
  watchAllPosts: boolean;
  autoPinDashboard: boolean;
}

export interface PredictionAnalysis {
  signals: SignalBreakdown;
  meta: SignalMeta;
}

export interface OracleJobData {
  [key: string]: string | number;
  postId: string;
  postTitle: string;
  authorName: string;
  subredditName: string;
  postSubmittedAt: number;
  permalink: string;
}
