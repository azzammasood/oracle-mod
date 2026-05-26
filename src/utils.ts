import type { OracleStats, PredictionRecord, RiskLevel } from './types.js';

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function normalizeAuthorName(authorName: string | undefined | null): string {
  const clean = (authorName ?? '').trim();
  if (!clean || clean === '[deleted]') {
    return 'unknown';
  }

  return clean.replace(/^u\//i, '');
}

export function humanTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 45_000) {
    return 'just now';
  }

  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }

  return new Date(ms).toISOString().slice(11, 16) + ' UTC';
}

export function computeAccuracy(stats: OracleStats): number | null {
  const total = stats.intervenedCount + stats.falseAlarmCount;
  if (total < 5) {
    return null;
  }

  return Math.round((stats.intervenedCount / total) * 100);
}

export function riskEmoji(level: RiskLevel): string {
  switch (level) {
    case 'critical':
      return '🔴';
    case 'high':
      return '🟠';
    case 'moderate':
      return '🟡';
    case 'low':
      return '🟢';
  }
}

export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'critical':
      return 'Critical';
    case 'high':
      return 'High';
    case 'moderate':
      return 'Moderate';
    case 'low':
      return 'Low';
  }
}

export function riskColor(level: RiskLevel): string {
  switch (level) {
    case 'critical':
      return '#ef4444';
    case 'high':
      return '#f97316';
    case 'moderate':
      return '#eab308';
    case 'low':
      return '#22c55e';
  }
}

export function isOracleDashboardPrediction(prediction: PredictionRecord): boolean {
  return (
    prediction.authorName.toLowerCase() === 'oracle-mod' ||
    prediction.postTitle.toLowerCase().includes('oracle dashboard')
  );
}
