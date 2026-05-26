import { Devvit } from '@devvit/public-api';

import type { DashboardData, DashboardSettings, PredictionOutcome, PredictionRecord, RiskLevel } from './types.js';
import { humanTime, riskColor, riskEmoji, riskLabel, truncateText } from './utils.js';

export type DashboardActions = {
  onOpenThread?: (prediction: PredictionRecord) => void | Promise<void>;
  onMarkIntervened?: (prediction: PredictionRecord) => void | Promise<void>;
  onMarkFalseAlarm?: (prediction: PredictionRecord) => void | Promise<void>;
  onToggleSettings?: () => void | Promise<void>;
  onTriggerDemo?: () => void | Promise<void>;
  settingsOpen?: boolean;
};

function outcomeLabel(outcome: PredictionOutcome): string {
  switch (outcome) {
    case 'intervened':
      return 'Intervened';
    case 'false_alarm':
      return 'False Alarm';
    case 'unknown':
      return 'Unknown';
    case 'pending':
      return 'Pending';
  }
}

function outcomeColor(outcome: PredictionOutcome): string {
  switch (outcome) {
    case 'intervened':
      return '#ef4444';
    case 'false_alarm':
      return '#22c55e';
    case 'unknown':
    case 'pending':
      return '#8b8795';
  }
}

function levelRank(level: RiskLevel): number {
  switch (level) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'moderate':
      return 2;
    case 'low':
      return 1;
  }
}

function byRiskThenTime(a: PredictionRecord, b: PredictionRecord): number {
  const levelDelta = levelRank(b.signals.level) - levelRank(a.signals.level);
  if (levelDelta !== 0) {
    return levelDelta;
  }

  const scoreDelta = b.signals.total - a.signals.total;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return b.predictedAt - a.predictedAt;
}

function strongestReason(prediction: PredictionRecord): string {
  const signalValues = [
    { key: 'commentVelocity', label: 'velocity', value: prediction.signals.commentVelocity },
    { key: 'newAccountSurge', label: 'new-account surge', value: prediction.signals.newAccountSurge },
    { key: 'reportRate', label: 'report rate', value: prediction.signals.reportRate },
    { key: 'authorHistory', label: 'author history', value: prediction.signals.authorHistory },
    { key: 'titleSensitivity', label: 'title sensitivity', value: prediction.signals.titleSensitivity },
  ].sort((a, b) => b.value - a.value);

  const top = signalValues[0];
  if (!top || top.value === 0) {
    return 'No elevated signal yet; baseline still learning this community.';
  }

  if (top.key === 'commentVelocity') {
    return `${prediction.signalMeta.commentCount} early comments, ${prediction.signalMeta.velocityRatio.toFixed(
      1
    )}x the current baseline.`;
  }

  if (top.key === 'newAccountSurge') {
    return `${Math.round(prediction.signalMeta.newAccountPct * 100)}% of early commenters appear infrequent.`;
  }

  if (top.key === 'reportRate') {
    return `${prediction.signalMeta.reportCount} report(s) observed during the prediction window.`;
  }

  if (top.key === 'authorHistory') {
    return `${prediction.signalMeta.removalCount} prior author removal(s) in this subreddit.`;
  }

  return `${prediction.signalMeta.titleMatchCount} sensitive title marker(s): ${
    prediction.signalMeta.titleMatches.slice(0, 3).join(', ') || 'none'
  }.`;
}

function StatCard(props: { label: string; value: string | number; color: string }): JSX.Element {
  return (
    <vstack grow backgroundColor="#15111c" cornerRadius="small" padding="xsmall" alignment="center middle">
      <text size="xsmall" color="#8b8795" weight="bold" overflow="ellipsis">
        {props.label}
      </text>
      <text size="large" weight="bold" color={props.color}>
        {props.value}
      </text>
    </vstack>
  );
}

function SignalChip(props: { label: string; value: number; max: number; color: string }): JSX.Element {
  return (
    <hstack
      backgroundColor="#21172c"
      border="thin"
      borderColor="#30233d"
      cornerRadius="small"
      padding="xsmall"
      gap="small"
      alignment="middle"
    >
      <text size="xsmall" color="#a1a1aa">
        {props.label}
      </text>
      <text size="xsmall" weight="bold" color={props.value > 0 ? props.color : '#71717a'}>
        {props.value}/{props.max}
      </text>
    </hstack>
  );
}

function ActionButtons(props: { prediction: PredictionRecord; actions?: DashboardActions }): JSX.Element {
  if (!props.actions) {
    return <hstack />;
  }

  return (
    <hstack gap="small" alignment="middle">
      {props.actions.onOpenThread ? (
        <button
          size="small"
          appearance="secondary"
          icon="external"
          onPress={() => props.actions?.onOpenThread?.(props.prediction)}
        >
          Open
        </button>
      ) : null}
      {props.actions.onMarkIntervened ? (
        <button
          size="small"
          appearance="caution"
          icon="mod"
          onPress={() => props.actions?.onMarkIntervened?.(props.prediction)}
        >
          Intervened
        </button>
      ) : null}
      {props.actions.onMarkFalseAlarm ? (
        <button
          size="small"
          appearance="success"
          icon="checkmark"
          onPress={() => props.actions?.onMarkFalseAlarm?.(props.prediction)}
        >
          False Alarm
        </button>
      ) : null}
    </hstack>
  );
}

function PredictionRow(props: {
  prediction: PredictionRecord;
  rowKey: string;
  actions?: DashboardActions;
}): JSX.Element {
  const prediction = props.prediction;
  const color = riskColor(prediction.signals.level);
  const isResolved = prediction.outcome === 'intervened' || prediction.outcome === 'false_alarm';

  return (
    <hstack key={props.rowKey} width="100%" backgroundColor="#15111c" cornerRadius="small">
      <vstack width="6px" backgroundColor={color} />
      <vstack padding="xsmall" gap="small" grow>
        <hstack gap="small" alignment="middle" width="100%">
          <text size="medium">{riskEmoji(prediction.signals.level)}</text>
          <vstack grow gap="none">
            <text size="small" weight="bold" color="#f8fafc" overflow="ellipsis">
              {truncateText(prediction.postTitle, 56)}
            </text>
            <text size="xsmall" color="#a1a1aa" overflow="ellipsis">
              u/{prediction.authorName} · {humanTime(prediction.predictedAt)} · {strongestReason(prediction)}
            </text>
          </vstack>
          <vstack alignment="center middle" minWidth="54px">
            <text size="large" weight="bold" color={color}>
              {prediction.signals.total}
            </text>
            <text size="xsmall" color={color}>
              {riskLabel(prediction.signals.level)}
            </text>
          </vstack>
        </hstack>

        <hstack gap="small" alignment="middle" width="100%">
          <SignalChip label="Vel" value={prediction.signals.commentVelocity} max={25} color="#38bdf8" />
          <SignalChip label="New" value={prediction.signals.newAccountSurge} max={25} color="#a855f7" />
          <SignalChip label="Rpt" value={prediction.signals.reportRate} max={20} color="#ef4444" />
          <SignalChip label="Hist" value={prediction.signals.authorHistory} max={20} color="#f97316" />
          <SignalChip label="Title" value={prediction.signals.titleSensitivity} max={10} color="#eab308" />
          <spacer />
          <text size="xsmall" color={outcomeColor(prediction.outcome)}>
            {outcomeLabel(prediction.outcome)}
          </text>
        </hstack>

        {!isResolved ? <ActionButtons prediction={prediction} actions={props.actions} /> : null}
      </vstack>
    </hstack>
  );
}

function EmptySection(props: { text: string }): JSX.Element {
  return (
    <vstack backgroundColor="#120f18" border="thin" borderColor="#21172c" cornerRadius="small" padding="xsmall">
      <text size="xsmall" color="#71717a">
        {props.text}
      </text>
    </vstack>
  );
}

function settingValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'On' : 'Off';
  }

  return String(value);
}

function SettingRow(props: { label: string; value: string | number | boolean }): JSX.Element {
  return (
    <hstack width="100%" alignment="middle" gap="small">
      <text size="xsmall" color="#a1a1aa" overflow="ellipsis">
        {props.label}
      </text>
      <spacer />
      <text size="xsmall" color="#f8fafc" weight="bold" overflow="ellipsis">
        {settingValue(props.value)}
      </text>
    </hstack>
  );
}

function SettingsPanel(props: { settings?: DashboardSettings; actions?: DashboardActions }): JSX.Element {
  const settings = props.settings ?? {
    alertThreshold: 55,
    alertCooldownMinutes: 15,
    predictionWindowMinutes: 5,
    muteAlerts: false,
    watchAllPosts: true,
    autoPinDashboard: true,
  };

  return (
    <vstack
      width="100%"
      backgroundColor="#120f18"
      border="thin"
      borderColor="#30233d"
      cornerRadius="small"
      padding="small"
      gap="small"
    >
      <hstack width="100%" alignment="middle" gap="medium">
        <text size="small" weight="bold" color="#d8b4fe">
          Current Settings
        </text>
        <spacer />
        {props.actions?.onTriggerDemo ? (
          <button size="small" appearance="primary" icon="play" onPress={() => props.actions?.onTriggerDemo?.()}>
            Trigger Demo
          </button>
        ) : null}
      </hstack>
      <SettingRow label="Alert threshold" value={`${settings.alertThreshold}/100`} />
      <SettingRow label="Alert cooldown" value={`${settings.alertCooldownMinutes} min`} />
      <SettingRow label="Prediction window" value={`${settings.predictionWindowMinutes} min`} />
      <SettingRow label="Mute alerts" value={settings.muteAlerts} />
      <SettingRow label="Watch all posts" value={settings.watchAllPosts} />
      <SettingRow label="Auto-pin dashboard" value={settings.autoPinDashboard} />
    </vstack>
  );
}

function QueueSection(props: {
  label: string;
  predictions: PredictionRecord[];
  emptyText: string;
  actions?: DashboardActions;
  limit: number;
}): JSX.Element {
  const visible = props.predictions.slice(0, props.limit);

  return (
    <vstack gap="small" width="100%">
      <hstack alignment="middle" width="100%">
        <text size="xsmall" weight="bold" color="#a1a1aa" overflow="ellipsis">
          {props.label}
        </text>
        <spacer />
        <text size="xsmall" color="#71717a">
          {props.predictions.length}
        </text>
      </hstack>
      {visible.length > 0 ? (
        <vstack gap="small" width="100%">
          {visible.map((prediction) => (
            <PredictionRow
              rowKey={`${props.label}-${prediction.postId}`}
              prediction={prediction}
              actions={props.actions}
            />
          ))}
        </vstack>
      ) : (
        <EmptySection text={props.emptyText} />
      )}
    </vstack>
  );
}

export function renderDashboard(data: DashboardData | null, actions?: DashboardActions): JSX.Element {
  if (!data) {
    return (
      <vstack alignment="center middle" padding="large" gap="medium" backgroundColor="#09070d" height="100%">
        <text size="xxlarge">🔮</text>
        <text size="medium" color="#8b8795">
          Loading predictions...
        </text>
      </vstack>
    );
  }

  const predictions = data.recentPredictions;
  const pending = predictions.filter((prediction) => prediction.outcome === 'pending');
  const needsAttention = pending
    .filter((prediction) => prediction.signals.level === 'critical' || prediction.signals.level === 'high')
    .sort(byRiskThenTime);
  const watching = pending
    .filter((prediction) => prediction.signals.level === 'moderate' || prediction.signals.level === 'low')
    .sort(byRiskThenTime);
  const resolved = predictions
    .filter((prediction) => prediction.outcome === 'intervened' || prediction.outcome === 'false_alarm')
    .sort((a, b) => (b.outcomeUpdatedAt ?? b.predictedAt) - (a.outcomeUpdatedAt ?? a.predictedAt));

  const criticalCount = pending.filter((prediction) => prediction.signals.level === 'critical').length;
  const highCount = pending.filter((prediction) => prediction.signals.level === 'high').length;
  const resolvedOutcomeCount = data.stats.intervenedCount + data.stats.falseAlarmCount;
  const settingsOpen = actions?.settingsOpen ?? false;

  if (predictions.length === 0) {
    return (
      <vstack alignment="center middle" padding="large" gap="medium" backgroundColor="#09070d" height="100%">
        <text size="xxlarge">🔮</text>
        <text size="xlarge" weight="bold" color="#a855f7">
          ORACLE
        </text>
        <text size="medium" color="#8b8795">
          No predictions yet.
        </text>
        <text size="small" color="#71717a" alignment="center" wrap>
          Use Predict Now on a post, or seed demo predictions from the subreddit menu.
        </text>
        {actions?.onToggleSettings ? (
          <button size="small" appearance="secondary" icon="settings" onPress={() => actions.onToggleSettings?.()}>
            Settings
          </button>
        ) : null}
        {settingsOpen ? <SettingsPanel settings={data.settings} actions={actions} /> : null}
      </vstack>
    );
  }

  return (
    <vstack padding="small" gap="small" width="100%" height="100%" backgroundColor="#09070d">
      <webview url="oracle-magic.html" width="100%" height="96px" />

      <hstack gap="small" alignment="middle" width="100%">
        <text size="large" weight="bold" color="#a855f7">
          🔮 ORACLE
        </text>
        <text size="small" color="#8b8795">
          Intervention Queue
        </text>
        <spacer />
        <text size="xsmall" color="#8b8795">
          {predictions.length} recent
        </text>
      </hstack>

      {data.baseline.totalPostsSampled < 10 ? (
        <hstack
          backgroundColor="#18121f"
          border="thin"
          borderColor="#3b2f4a"
          cornerRadius="small"
          padding="xsmall"
          gap="small"
          alignment="middle"
        >
          <text size="xsmall" weight="bold" color="#d8b4fe">
            Baseline warming up
          </text>
          <text size="xsmall" color="#a1a1aa" overflow="ellipsis">
            {data.baseline.totalPostsSampled}/10 sampled; velocity scoring gets smarter as history fills in.
          </text>
        </hstack>
      ) : null}

      <hstack gap="small" width="100%">
        <StatCard label="Critical" value={criticalCount} color="#ef4444" />
        <StatCard label="High" value={highCount} color="#f97316" />
        <StatCard label="Watching" value={watching.length} color="#eab308" />
        <StatCard label="Resolved" value={resolved.length} color="#22c55e" />
      </hstack>

      {resolvedOutcomeCount >= 5 && data.stats.accuracy !== null ? (
        <vstack backgroundColor="#15111c" cornerRadius="small" padding="small">
          <text size="xsmall" color="#8b8795">
            Accuracy
          </text>
          <hstack gap="small" alignment="middle">
            <text size="large" weight="bold" color="#a855f7">
              {data.stats.accuracy}%
            </text>
            <text size="xsmall" color="#8b8795">
              of marked alerts needed intervention
            </text>
          </hstack>
        </vstack>
      ) : null}

      {settingsOpen ? (
        <SettingsPanel settings={data.settings} actions={actions} />
      ) : (
        <vstack gap="small" width="100%">
          <QueueSection
            label="Needs Attention"
            predictions={needsAttention}
            emptyText="No high-risk threads are pending."
            actions={actions}
            limit={1}
          />
          <QueueSection
            label="Watching"
            predictions={watching}
            emptyText="No low or moderate threads are pending."
            actions={actions}
            limit={1}
          />
          {resolved.length > 0 ? (
            <QueueSection
              label="Resolved"
              predictions={resolved}
              emptyText="No outcomes marked yet."
              actions={actions}
              limit={1}
            />
          ) : null}
        </vstack>
      )}

      <hstack width="100%" alignment="middle">
        <text size="xsmall" color="#52525b">
          Last updated: {humanTime(Date.now())}
        </text>
        <spacer />
        {actions?.onToggleSettings ? (
          <button size="small" appearance="secondary" icon="settings" onPress={() => actions.onToggleSettings?.()}>
            {settingsOpen ? 'Close' : 'Settings'}
          </button>
        ) : null}
        <text size="xsmall" color="#52525b">
          Alerts {data.stats.alertsSent} · Intervened {data.stats.intervenedCount} · False alarms{' '}
          {data.stats.falseAlarmCount}
        </text>
      </hstack>
    </vstack>
  );
}
