import { Devvit, useAsync, useState } from '@devvit/public-api';
import type { Comment, Post, RedisClient, SettingsValues } from '@devvit/public-api';

import { maybeSendAlert } from './alerter.js';
import { renderDashboard } from './dashboard.js';
import { computeRiskScore } from './predictor.js';
import {
  getAuthorRecord,
  getBaseline,
  getRecentPredictions,
  getStats,
  deletePrediction,
  incrementAuthorRemoval,
  savePrediction,
  updateBaseline,
  updatePredictionOutcome,
} from './signalStore.js';
import type {
  DashboardData,
  DashboardSettings,
  OracleJobData,
  OracleStats,
  PredictionRecord,
  SignalBreakdown,
  SignalMeta,
} from './types.js';
import { computeAccuracy, isOracleDashboardPrediction, normalizeAuthorName, truncateText } from './utils.js';

Devvit.configure({
  redditAPI: true,
  redis: true,
});

Devvit.addSettings([
  {
    type: 'number',
    name: 'alert-threshold',
    label: 'Alert threshold (Risk Score 0-100)',
    helpText: "Oracle sends modmail when a thread's risk score meets or exceeds this. Default: 55",
    defaultValue: 55,
    onValidate: ({ value }) => {
      if (value !== undefined && (value < 10 || value > 100)) {
        return 'Choose a threshold from 10 to 100.';
      }
      return undefined;
    },
  },
  {
    type: 'number',
    name: 'alert-cooldown-minutes',
    label: 'Alert cooldown (minutes)',
    helpText: 'Minimum minutes between Oracle alerts. Prevents modmail spam. Default: 15',
    defaultValue: 15,
    onValidate: ({ value }) => {
      if (value !== undefined && (value < 1 || value > 120)) {
        return 'Choose a cooldown from 1 to 120 minutes.';
      }
      return undefined;
    },
  },
  {
    type: 'number',
    name: 'prediction-window-minutes',
    label: 'Prediction window (minutes)',
    helpText: 'How many minutes after posting Oracle samples the thread. Default: 5',
    defaultValue: 5,
    onValidate: ({ value }) => {
      if (value !== undefined && (value < 2 || value > 15)) {
        return 'Choose a prediction window from 2 to 15 minutes.';
      }
      return undefined;
    },
  },
  {
    type: 'boolean',
    name: 'mute-alerts',
    label: 'Mute all Oracle alerts',
    helpText: 'Silence modmail alerts. Predictions still run and are logged.',
    defaultValue: false,
  },
  {
    type: 'boolean',
    name: 'watch-all-posts',
    label: 'Watch all posts',
    helpText: 'If disabled, Oracle only runs when a moderator uses Predict Now.',
    defaultValue: true,
  },
  {
    type: 'boolean',
    name: 'auto-pin-dashboard',
    label: 'Auto-pin Oracle dashboard',
    helpText: 'Automatically sticky new Oracle Dashboard posts in subreddit sticky slot 2.',
    defaultValue: true,
  },
]);

function settingNumber(settings: SettingsValues, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === 'number' ? value : fallback;
}

function settingBoolean(settings: SettingsValues, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readDashboardSettings(settings: SettingsValues): DashboardSettings {
  return {
    alertThreshold: settingNumber(settings, 'alert-threshold', 55),
    alertCooldownMinutes: settingNumber(settings, 'alert-cooldown-minutes', 15),
    predictionWindowMinutes: settingNumber(settings, 'prediction-window-minutes', 5),
    muteAlerts: settingBoolean(settings, 'mute-alerts', false),
    watchAllPosts: settingBoolean(settings, 'watch-all-posts', true),
    autoPinDashboard: settingBoolean(settings, 'auto-pin-dashboard', true),
  };
}

function normalizePostId(postId: string): string {
  return postId.startsWith('t3_') ? postId : `t3_${postId}`;
}

function normalizeTimestamp(value: number | undefined): number {
  if (!value) {
    return Date.now();
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function permalinkToUrl(permalink: string | undefined): string {
  if (!permalink) {
    return 'https://reddit.com';
  }

  return permalink.startsWith('http') ? permalink : `https://reddit.com${permalink}`;
}

async function loadDashboardData(redis: RedisClient, settings?: SettingsValues): Promise<DashboardData> {
  const allRecentPredictions = await getRecentPredictions(redis);
  const oracleSelfPredictions = allRecentPredictions.filter(isOracleDashboardPrediction);
  for (const prediction of oracleSelfPredictions) {
    await deletePrediction(redis, prediction.postId);
  }

  const recentPredictions = allRecentPredictions.filter((prediction) => !isOracleDashboardPrediction(prediction));
  const stats = await getStats(redis);
  const baseline = await getBaseline(redis);
  return {
    recentPredictions,
    stats: { ...stats, accuracy: computeAccuracy(stats) },
    baseline,
    settings: settings ? readDashboardSettings(settings) : undefined,
  };
}

function makeSignals(values: Omit<SignalBreakdown, 'total' | 'level'>): SignalBreakdown {
  const total = Math.min(
    100,
    values.commentVelocity +
      values.newAccountSurge +
      values.reportRate +
      values.authorHistory +
      values.titleSensitivity
  );

  return {
    ...values,
    total,
    level: total <= 25 ? 'low' : total <= 50 ? 'moderate' : total <= 74 ? 'high' : 'critical',
  };
}

function makeMeta(values: Partial<SignalMeta>): SignalMeta {
  return {
    commentCount: values.commentCount ?? 0,
    baselineAvg: values.baselineAvg ?? 4,
    velocityRatio: values.velocityRatio ?? 1,
    uniqueAuthors: values.uniqueAuthors ?? 0,
    likelyNewAccounts: values.likelyNewAccounts ?? 0,
    newAccountPct: values.newAccountPct ?? 0,
    reportCount: values.reportCount ?? 0,
    removalCount: values.removalCount ?? 0,
    titleMatchCount: values.titleMatchCount ?? 0,
    titleMatches: values.titleMatches ?? [],
  };
}

async function seedDemoPredictions(redis: RedisClient, subredditName: string): Promise<void> {
  try {
    const now = Date.now();
    const baseUrl = `https://reddit.com/r/${subredditName}`;
    const demoPredictions: PredictionRecord[] = [
      {
        postId: 't3_oracle_demo_critical',
        postTitle: 'Hot take: why is this community defending the worst possible rule?',
        postPermalink: `${baseUrl}/new/`,
        authorName: 'heatedthread_demo',
        subredditName,
        predictedAt: now - 4 * 60_000,
        submittedAt: now - 9 * 60_000,
        signals: makeSignals({
          commentVelocity: 25,
          newAccountSurge: 22,
          reportRate: 16,
          authorHistory: 8,
          titleSensitivity: 8,
        }),
        signalMeta: makeMeta({
          commentCount: 46,
          baselineAvg: 6.2,
          velocityRatio: 7.4,
          uniqueAuthors: 27,
          likelyNewAccounts: 22,
          newAccountPct: 0.81,
          reportCount: 18,
          removalCount: 1,
          titleMatchCount: 4,
          titleMatches: ['hot take', 'why is', 'worst', 'defending'],
        }),
        alertSent: true,
        outcome: 'pending',
        outcomeUpdatedAt: null,
      },
      {
        postId: 't3_oracle_demo_high',
        postTitle: 'Unpopular opinion: this update is disgusting and needs to be reversed',
        postPermalink: `${baseUrl}/new/`,
        authorName: 'firsttimer_demo',
        subredditName,
        predictedAt: now - 11 * 60_000,
        submittedAt: now - 16 * 60_000,
        signals: makeSignals({
          commentVelocity: 18,
          newAccountSurge: 18,
          reportRate: 8,
          authorHistory: 0,
          titleSensitivity: 8,
        }),
        signalMeta: makeMeta({
          commentCount: 24,
          baselineAvg: 5.8,
          velocityRatio: 4.1,
          uniqueAuthors: 17,
          likelyNewAccounts: 13,
          newAccountPct: 0.76,
          reportCount: 5,
          titleMatchCount: 4,
          titleMatches: ['unpopular opinion', 'disgusting', 'needs', 'reversed'],
        }),
        alertSent: true,
        outcome: 'pending',
        outcomeUpdatedAt: null,
      },
      {
        postId: 't3_oracle_demo_watch',
        postTitle: 'Need help understanding a moderation decision from yesterday',
        postPermalink: `${baseUrl}/new/`,
        authorName: 'regular_demo',
        subredditName,
        predictedAt: now - 22 * 60_000,
        submittedAt: now - 27 * 60_000,
        signals: makeSignals({
          commentVelocity: 8,
          newAccountSurge: 5,
          reportRate: 0,
          authorHistory: 0,
          titleSensitivity: 4,
        }),
        signalMeta: makeMeta({
          commentCount: 9,
          baselineAvg: 6,
          velocityRatio: 1.5,
          uniqueAuthors: 6,
          likelyNewAccounts: 3,
          newAccountPct: 0.5,
          titleMatchCount: 2,
          titleMatches: ['need help', 'decision'],
        }),
        alertSent: false,
        outcome: 'pending',
        outcomeUpdatedAt: null,
      },
      {
        postId: 't3_oracle_demo_intervened',
        postTitle: 'Why are mods allowing this debate to continue?',
        postPermalink: `${baseUrl}/new/`,
        authorName: 'repeatremoval_demo',
        subredditName,
        predictedAt: now - 65 * 60_000,
        submittedAt: now - 70 * 60_000,
        signals: makeSignals({
          commentVelocity: 16,
          newAccountSurge: 10,
          reportRate: 12,
          authorHistory: 20,
          titleSensitivity: 6,
        }),
        signalMeta: makeMeta({
          commentCount: 19,
          baselineAvg: 5.5,
          velocityRatio: 3.5,
          uniqueAuthors: 12,
          likelyNewAccounts: 6,
          newAccountPct: 0.5,
          reportCount: 6,
          removalCount: 3,
          titleMatchCount: 3,
          titleMatches: ['why are', 'debate', 'mods'],
        }),
        alertSent: true,
        outcome: 'pending',
        outcomeUpdatedAt: null,
      },
      {
        postId: 't3_oracle_demo_false_alarm',
        postTitle: 'Best tips for keeping weekly discussion threads organized?',
        postPermalink: `${baseUrl}/new/`,
        authorName: 'helpful_demo',
        subredditName,
        predictedAt: now - 90 * 60_000,
        submittedAt: now - 95 * 60_000,
        signals: makeSignals({
          commentVelocity: 10,
          newAccountSurge: 0,
          reportRate: 0,
          authorHistory: 0,
          titleSensitivity: 2,
        }),
        signalMeta: makeMeta({
          commentCount: 12,
          baselineAvg: 6,
          velocityRatio: 2,
          uniqueAuthors: 8,
          likelyNewAccounts: 1,
          newAccountPct: 0.13,
          titleMatchCount: 1,
          titleMatches: ['best'],
        }),
        alertSent: false,
        outcome: 'pending',
        outcomeUpdatedAt: null,
      },
    ];

    for (const prediction of demoPredictions) {
      await savePrediction(redis, prediction);
    }

    await updatePredictionOutcome(redis, 't3_oracle_demo_intervened', 'intervened');
    await updatePredictionOutcome(redis, 't3_oracle_demo_false_alarm', 'false_alarm');
  } catch (e) {
    console.error('[Oracle] seedDemoPredictions failed:', e);
  }
}

type RedditContext = Pick<Devvit.Context, 'reddit'>;
type SchedulerContext = Pick<Devvit.Context, 'scheduler'>;
const DASHBOARD_WEBVIEW_ID = 'oracle-dashboard-webview';

function unwrapDashboardMessage(message: unknown): Record<string, unknown> {
  const candidate = message as {
    type?: string;
    data?: {
      message?: Record<string, unknown>;
    };
  };

  if (candidate?.type === 'devvit-message' && candidate.data?.message) {
    return candidate.data.message;
  }

  return (message ?? {}) as Record<string, unknown>;
}

async function isCurrentUserModerator(context: RedditContext, subredditName: string): Promise<boolean> {
  try {
    const currentUser = await context.reddit.getCurrentUser();
    if (!currentUser) {
      return false;
    }

    const moderators = await context.reddit.getModerators({ subredditName, limit: 100 }).all();
    return moderators.some(
      (moderator) =>
        moderator.id === currentUser.id ||
        moderator.username.toLowerCase() === currentUser.username.toLowerCase()
    );
  } catch (e) {
    console.error('[Oracle] isCurrentUserModerator failed:', e);
    return false;
  }
}

async function getCommentsForPost(context: RedditContext, postId: string): Promise<Comment[]> {
  try {
    return await context.reddit
      .getComments({
        postId,
        limit: 100,
        sort: 'new',
      })
      .all();
  } catch (e) {
    console.error('[Oracle] getCommentsForPost failed:', e);
    return [];
  }
}

async function getPostSafely(context: RedditContext, postId: string): Promise<Post | null> {
  try {
    return await context.reddit.getPostById(postId);
  } catch (e) {
    console.error('[Oracle] getPostSafely failed:', e);
    return null;
  }
}

async function schedulePrediction(context: SchedulerContext, data: OracleJobData, runAt: Date): Promise<void> {
  try {
    await context.scheduler.runJob<OracleJobData>({
      name: 'oracle-predict',
      data,
      runAt,
    });
    console.log(`[Oracle] Scheduled prediction for ${data.postId} at ${runAt.toISOString()}`);
  } catch (e) {
    console.error('[Oracle] schedulePrediction failed:', e);
  }
}

async function stickyDashboardPost(post: Post): Promise<boolean> {
  try {
    await post.sticky(2);
    console.log(`[Oracle] Dashboard pinned in sticky slot 2: ${post.id}`);
    return true;
  } catch (e) {
    console.error('[Oracle] stickyDashboardPost failed:', e);
    return false;
  }
}

Devvit.addSchedulerJob<OracleJobData>({
  name: 'oracle-predict',
  onRun: async (job, context) => {
    const jobData = job.data;
    if (!jobData) {
      console.error('[Oracle] oracle-predict missing job data');
      return;
    }

    try {
      const postId = normalizePostId(String(jobData.postId));
      const settings = await context.settings.getAll();
      const threshold = settingNumber(settings, 'alert-threshold', 55);
      const cooldownMs = settingNumber(settings, 'alert-cooldown-minutes', 15) * 60_000;
      const muteAlerts = settingBoolean(settings, 'mute-alerts', false);

      const post = await getPostSafely(context, postId);
      const comments = await getCommentsForPost(context, postId);
      const baseline = await getBaseline(context.redis);
      const authorName = normalizeAuthorName(post?.authorName ?? String(jobData.authorName));
      const authorRecord = await getAuthorRecord(context.redis, authorName);
      const postTitle = truncateText(post?.title ?? String(jobData.postTitle), 120);
      const reportCount = Math.max(0, post?.numberOfReports ?? 0);

      const analysis = await computeRiskScore({
        postId,
        postTitle,
        authorName,
        comments,
        reportCount,
        baseline,
        authorRecord,
        postSubmittedAt: Number(jobData.postSubmittedAt),
      });

      const prediction: PredictionRecord = {
        postId,
        postTitle,
        postPermalink: permalinkToUrl(post?.permalink ?? String(jobData.permalink)),
        authorName,
        subredditName: post?.subredditName ?? String(jobData.subredditName),
        predictedAt: Date.now(),
        submittedAt: Number(jobData.postSubmittedAt),
        signals: analysis.signals,
        signalMeta: analysis.meta,
        alertSent: false,
        outcome: 'pending',
        outcomeUpdatedAt: null,
      };

      if (!muteAlerts) {
        prediction.alertSent = await maybeSendAlert(
          prediction,
          threshold,
          cooldownMs,
          context.reddit,
          prediction.subredditName,
          context.redis
        );
      }

      await savePrediction(context.redis, prediction);
      await updateBaseline(context.redis, comments.length);
      console.log(`[Oracle] Prediction saved for ${postId}: ${prediction.signals.total}/100`);
    } catch (e) {
      console.error('[Oracle] oracle-predict job failed:', e);
    }
  },
});

Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    try {
      const settings = await context.settings.getAll();
      const watchAllPosts = settingBoolean(settings, 'watch-all-posts', true);
      if (!watchAllPosts || !event.post) {
        return;
      }

      const authorName = normalizeAuthorName(event.author?.name);
      const isOraclePost =
        authorName.toLowerCase() === context.appSlug.toLowerCase() ||
        event.post.title.toLowerCase().includes('oracle dashboard');
      if (isOraclePost) {
        return;
      }

      const windowMinutes = settingNumber(settings, 'prediction-window-minutes', 5);
      const runAt = new Date(Date.now() + windowMinutes * 60_000);
      await schedulePrediction(
        context,
        {
          postId: normalizePostId(event.post.id),
          postTitle: truncateText(event.post.title ?? '', 120),
          authorName,
          subredditName: event.subreddit?.name ?? context.subredditName ?? '',
          postSubmittedAt: normalizeTimestamp(event.post.createdAt),
          permalink: permalinkToUrl(event.post.permalink),
        },
        runAt
      );
    } catch (e) {
      console.error('[Oracle] PostSubmit handler failed:', e);
    }
  },
});

Devvit.addTrigger({
  event: 'PostDelete',
  onEvent: async (event, context) => {
    try {
      await incrementAuthorRemoval(context.redis, event.author?.name ?? '');
    } catch (e) {
      console.error('[Oracle] PostDelete handler failed:', e);
    }
  },
});

Devvit.addTrigger({
  event: 'ModAction',
  onEvent: async (event, context) => {
    try {
      const removalActions = new Set(['removelink', 'spamlink', 'remove_post', 'spam_post']);
      const action = (event.action ?? '').toLowerCase();
      if (!removalActions.has(action)) {
        return;
      }

      await incrementAuthorRemoval(context.redis, event.targetUser?.name ?? '');
    } catch (e) {
      console.error('[Oracle] ModAction handler failed:', e);
    }
  },
});

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async () => {
    try {
      console.log('[Oracle] App installed successfully');
    } catch (e) {
      console.error('[Oracle] AppInstall handler failed:', e);
    }
  },
});

Devvit.addMenuItem({
  label: '🔮 Create Oracle Dashboard',
  description: 'Create a live Oracle prediction dashboard post.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      const subreddit = await context.reddit.getCurrentSubreddit();
      const settings = await context.settings.getAll();
      const autoPinDashboard = settingBoolean(settings, 'auto-pin-dashboard', true);
      const dashData = await loadDashboardData(context.redis, settings);
      const dashboardPost = await context.reddit.submitPost({
        title: `🔮 Oracle Dashboard — ${subreddit.name}`,
        subredditName: subreddit.name,
        preview: renderDashboard(dashData),
        runAs: 'APP',
        textFallback: {
          text: 'Oracle Dashboard: open this post in Reddit to view recent thread risk predictions.',
        },
      });
      await (autoPinDashboard ? stickyDashboardPost(dashboardPost) : Promise.resolve(false));
      context.ui.showToast('Oracle dashboard created ✓');
    } catch (e) {
      console.error('[Oracle] Dashboard creation failed:', e);
      context.ui.showToast('Oracle: Could not create dashboard.');
    }
  },
});

Devvit.addMenuItem({
  label: '🔮 Predict Now',
  description: 'Schedule an Oracle prediction for this post in 30 seconds.',
  location: 'post',
  onPress: async (event, context) => {
    try {
      const post = await context.reddit.getPostById(event.targetId);
      if (!(await isCurrentUserModerator(context, post.subredditName))) {
        context.ui.showToast('Oracle is only available to moderators.');
        return;
      }

      await schedulePrediction(
        context,
        {
          postId: post.id,
          postTitle: truncateText(post.title, 120),
          authorName: normalizeAuthorName(post.authorName),
          subredditName: post.subredditName,
          postSubmittedAt: post.createdAt.getTime(),
          permalink: permalinkToUrl(post.permalink),
        },
        new Date(Date.now() + 30_000)
      );
      context.ui.showToast('🔮 Oracle prediction scheduled in 30 seconds.');
    } catch (e) {
      console.error('[Oracle] Predict Now failed:', e);
      context.ui.showToast('Oracle: prediction failed.');
    }
  },
});

Devvit.addMenuItem({
  label: '🔮 Mark as Intervened',
  description: 'Mark this post as an Oracle true positive.',
  location: 'post',
  onPress: async (event, context) => {
    try {
      const post = await context.reddit.getPostById(event.targetId);
      if (!(await isCurrentUserModerator(context, post.subredditName))) {
        context.ui.showToast('Oracle is only available to moderators.');
        return;
      }

      await updatePredictionOutcome(context.redis, event.targetId, 'intervened');
      context.ui.showToast('Oracle: marked as intervened ✓');
    } catch (e) {
      console.error('[Oracle] Mark as Intervened failed:', e);
      context.ui.showToast('Oracle: could not update outcome.');
    }
  },
});

Devvit.addMenuItem({
  label: '🔮 Mark as False Alarm',
  description: 'Mark this post as an Oracle false alarm.',
  location: 'post',
  onPress: async (event, context) => {
    try {
      const post = await context.reddit.getPostById(event.targetId);
      if (!(await isCurrentUserModerator(context, post.subredditName))) {
        context.ui.showToast('Oracle is only available to moderators.');
        return;
      }

      await updatePredictionOutcome(context.redis, event.targetId, 'false_alarm');
      context.ui.showToast('Oracle: marked as false alarm ✓');
    } catch (e) {
      console.error('[Oracle] Mark as False Alarm failed:', e);
      context.ui.showToast('Oracle: could not update outcome.');
    }
  },
});

Devvit.addMenuItem({
  label: '🔮 Oracle Stats',
  description: 'Show current Oracle prediction counts.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      const stats: OracleStats = await getStats(context.redis);
      const accuracy = computeAccuracy(stats);
      context.ui.showToast(
        `Oracle: ${stats.totalPredictions} predictions, ${stats.alertsSent} alerts${
          accuracy === null ? '' : `, ${accuracy}% accuracy`
        }`
      );
    } catch (e) {
      console.error('[Oracle] Oracle Stats failed:', e);
      context.ui.showToast('Oracle: could not load stats.');
    }
  },
});

Devvit.addMenuItem({
  label: '🔮 Seed Demo Predictions',
  description: 'Load realistic high-risk Oracle records for a polished demo.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      const subreddit = await context.reddit.getCurrentSubreddit();
      await seedDemoPredictions(context.redis, subreddit.name);
      context.ui.showToast('Oracle demo predictions seeded ✓');
    } catch (e) {
      console.error('[Oracle] Seed Demo Predictions failed:', e);
      context.ui.showToast('Oracle: could not seed demo predictions.');
    }
  },
});

Devvit.addCustomPostType({
  name: 'Oracle Dashboard',
  description: 'Recent Oracle thread toxicity predictions for moderators.',
  height: 'tall',
  render: (context) => {
    const [refreshKey, setRefreshKey] = useState(0);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const dashboard = useAsync<any>(
      async () => {
        const settings = await context.settings.getAll();
        return loadDashboardData(context.redis, settings) as Promise<any>;
      },
      {
        depends: refreshKey,
      }
    );

    if (dashboard.loading || !dashboard.data) {
      return renderDashboard(null);
    }

    const dashboardData = dashboard.data as unknown as DashboardData;

    return (
      <webview
        id={DASHBOARD_WEBVIEW_ID}
        key={`oracle-dashboard-${refreshKey}`}
        url="oracle-dashboard.html"
        width="100%"
        height="100%"
        onMessage={async (rawMessage) => {
          const message = unwrapDashboardMessage(rawMessage);
          const messageType = String(message.type ?? '');
          const postId = typeof message.postId === 'string' ? message.postId : '';

          if (messageType === 'ready') {
            context.ui.webView.postMessage(DASHBOARD_WEBVIEW_ID, {
              type: 'dashboard-data',
              data: dashboardData,
            } as any);
            return;
          }

          if (messageType === 'refresh') {
            const settings = await context.settings.getAll();
            const nextDashboardData = await loadDashboardData(context.redis, settings);
            context.ui.webView.postMessage(DASHBOARD_WEBVIEW_ID, {
              type: 'dashboard-data',
              data: nextDashboardData,
            } as any);
            return;
          }

          if (messageType === 'open-thread') {
            const prediction = dashboardData.recentPredictions.find((item) => item.postId === postId);
            if (prediction) {
              context.ui.navigateTo(prediction.postPermalink);
            }
            return;
          }

          if (messageType === 'mark-intervened' || messageType === 'mark-false-alarm') {
            await updatePredictionOutcome(
              context.redis,
              postId,
              messageType === 'mark-intervened' ? 'intervened' : 'false_alarm'
            );
            context.ui.showToast(
              messageType === 'mark-intervened' ? 'Oracle: marked as intervened' : 'Oracle: marked as false alarm'
            );
            setRefreshKey((current) => current + 1);
            return;
          }

          if (messageType === 'trigger-demo') {
            const subreddit = await context.reddit.getCurrentSubreddit();
            await seedDemoPredictions(context.redis, subreddit.name);
            context.ui.showToast('Oracle demo predictions seeded');
            setRefreshKey((current) => current + 1);
          }
        }}
      />
    );

    return renderDashboard(dashboardData, {
      onOpenThread: (prediction) => {
        context.ui.navigateTo(prediction.postPermalink);
      },
      onMarkIntervened: async (prediction) => {
        await updatePredictionOutcome(context.redis, prediction.postId, 'intervened');
        context.ui.showToast('Oracle: marked as intervened ✓');
        setRefreshKey((current) => current + 1);
      },
      onMarkFalseAlarm: async (prediction) => {
        await updatePredictionOutcome(context.redis, prediction.postId, 'false_alarm');
        context.ui.showToast('Oracle: marked as false alarm ✓');
        setRefreshKey((current) => current + 1);
      },
      settingsOpen,
      onToggleSettings: () => {
        setSettingsOpen((current) => !current);
      },
      onTriggerDemo: async () => {
        const subreddit = await context.reddit.getCurrentSubreddit();
        await seedDemoPredictions(context.redis, subreddit.name);
        context.ui.showToast('Oracle demo predictions seeded');
        setSettingsOpen(false);
        setRefreshKey((current) => current + 1);
      },
    });
  },
});

export default Devvit;
