const app = document.getElementById('app');
let dashboard = null;
let loadError = null;
let settingsOpen = false;
let loadTimer = null;

const levelMeta = {
  low: { label: 'Low', color: '#22c55e' },
  moderate: { label: 'Moderate', color: '#eab308' },
  high: { label: 'High', color: '#f97316' },
  critical: { label: 'Critical', color: '#ef4444' },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function post(type, payload = {}) {
  parent.postMessage({ type, ...payload }, '*');
}

function clearLoadTimer() {
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
}

function requestDashboard(type = 'ready') {
  loadError = null;
  clearLoadTimer();
  if (!dashboard) {
    render();
  }
  post(type);
  loadTimer = setTimeout(() => {
    if (!dashboard) {
      loadError = 'Timed out waiting for dashboard data from Reddit.';
      render();
    }
  }, 8_000);
}

function markOutcome(postId, outcome) {
  post(outcome === 'intervened' ? 'mark-intervened' : 'mark-false-alarm', { postId });
}

function unwrap(raw) {
  if (raw && raw.type === 'devvit-message' && raw.data && raw.data.message) {
    return raw.data.message;
  }
  return raw;
}

function humanTime(ms) {
  const delta = Date.now() - Number(ms || Date.now());
  if (delta < 45_000) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(ms).toISOString().slice(11, 16) + ' UTC';
}

function strongestReason(prediction) {
  const signals = prediction.signals || {};
  const meta = prediction.signalMeta || {};
  const values = [
    ['commentVelocity', signals.commentVelocity || 0],
    ['newAccountSurge', signals.newAccountSurge || 0],
    ['reportRate', signals.reportRate || 0],
    ['authorHistory', signals.authorHistory || 0],
    ['titleSensitivity', signals.titleSensitivity || 0],
  ].sort((a, b) => b[1] - a[1]);
  const top = values[0];
  if (!top || top[1] === 0) return 'No elevated signal yet; baseline still learning this community.';
  if (top[0] === 'commentVelocity') return `${meta.commentCount || 0} early comments, ${Number(meta.velocityRatio || 0).toFixed(1)}x baseline.`;
  if (top[0] === 'newAccountSurge') return `${Math.round(Number(meta.newAccountPct || 0) * 100)}% of early commenters appear infrequent.`;
  if (top[0] === 'reportRate') return `${meta.reportCount || 0} report(s) observed during the prediction window.`;
  if (top[0] === 'authorHistory') return `${meta.removalCount || 0} prior author removal(s) in this subreddit.`;
  return `${meta.titleMatchCount || 0} sensitive title marker(s).`;
}

function sortPredictions(a, b) {
  const rank = { low: 1, moderate: 2, high: 3, critical: 4 };
  return (
    (rank[b.signals?.level] || 0) - (rank[a.signals?.level] || 0) ||
    (b.signals?.total || 0) - (a.signals?.total || 0) ||
    (b.predictedAt || 0) - (a.predictedAt || 0)
  );
}

function chip(label, value, max, color) {
  return `<span class="chip">${label} <strong style="color:${color}">${value || 0}/${max}</strong></span>`;
}

function renderRow(prediction) {
  const level = prediction.signals?.level || 'low';
  const meta = levelMeta[level] || levelMeta.low;
  const outcome = prediction.outcome || 'pending';
  const resolved = outcome === 'intervened' || outcome === 'false_alarm';
  return `
    <article class="row">
      <div class="riskbar" style="background:${meta.color}"></div>
      <div class="row-body">
        <div class="row-main">
          <div>
            <div class="title">${escapeHtml(prediction.postTitle)}</div>
            <div class="meta">u/${escapeHtml(prediction.authorName)} <span aria-hidden="true">&middot;</span> ${humanTime(prediction.predictedAt)} <span aria-hidden="true">&middot;</span> ${escapeHtml(strongestReason(prediction))}</div>
          </div>
          <div class="score" style="color:${meta.color}">
            <strong>${prediction.signals?.total || 0}</strong>
            <span>${meta.label}</span>
          </div>
        </div>
        <div class="chips">
          ${chip('Vel', prediction.signals?.commentVelocity, 25, '#38bdf8')}
          ${chip('New', prediction.signals?.newAccountSurge, 25, '#a855f7')}
          ${chip('Rpt', prediction.signals?.reportRate, 20, '#ef4444')}
          ${chip('Hist', prediction.signals?.authorHistory, 20, '#f97316')}
          ${chip('Title', prediction.signals?.titleSensitivity, 10, '#eab308')}
          <span class="chip">${escapeHtml(outcome.replace('_', ' '))}</span>
        </div>
        ${
          resolved
            ? ''
            : `<div class="actions">
                <button class="btn-open" data-action="open" data-post-id="${escapeHtml(prediction.postId)}">Open</button>
                <button class="btn-warn" data-action="intervened" data-post-id="${escapeHtml(prediction.postId)}">Shield Intervened</button>
                <button class="btn-good" data-action="false-alarm" data-post-id="${escapeHtml(prediction.postId)}">False Alarm</button>
              </div>`
        }
      </div>
    </article>
  `;
}

function renderSection(label, predictions, emptyText) {
  return `
    <section class="section">
      <div class="section-head">${label} <span class="section-count">${predictions.length}</span></div>
      ${predictions.length ? predictions.map(renderRow).join('') : `<div class="empty">${emptyText}</div>`}
    </section>
  `;
}

function renderSettings(settings) {
  const safe = settings || {};
  const row = (label, value) => `<div class="setting-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
  return `
    <section class="settings ${settingsOpen ? 'open' : ''}">
      <div class="settings-head">
        <strong>Current Settings</strong>
        <span class="spacer"></span>
        <button class="btn-good" data-action="refresh">Refresh</button>
      </div>
      ${row('Alert threshold', `${safe.alertThreshold ?? 55}/100`)}
      ${row('Alert cooldown', `${safe.alertCooldownMinutes ?? 15} min`)}
      ${row('Prediction window', `${safe.predictionWindowMinutes ?? 5} min`)}
      ${row('Mute alerts', safe.muteAlerts ? 'On' : 'Off')}
      ${row('Watch all posts', safe.watchAllPosts === false ? 'Off' : 'On')}
      ${row('Auto-pin dashboard', safe.autoPinDashboard === false ? 'Off' : 'On')}
    </section>
  `;
}

function render() {
  if (!dashboard) {
    app.innerHTML = loadError
      ? `<div class="loading"><div><strong>Oracle dashboard could not load.</strong><br><span>${escapeHtml(loadError)}</span><br><br><button class="btn-secondary" data-action="refresh">Retry</button></div></div>`
      : '<div class="loading">Loading Oracle dashboard...</div>';
    return;
  }

  const predictions = dashboard.recentPredictions || [];
  const pending = predictions.filter((p) => p.outcome === 'pending');
  const needsAttention = pending.filter((p) => ['critical', 'high'].includes(p.signals?.level)).sort(sortPredictions);
  const watching = pending.filter((p) => ['moderate', 'low'].includes(p.signals?.level)).sort(sortPredictions);
  const resolved = predictions
    .filter((p) => ['intervened', 'false_alarm'].includes(p.outcome))
    .sort((a, b) => (b.outcomeUpdatedAt || b.predictedAt || 0) - (a.outcomeUpdatedAt || a.predictedAt || 0));
  const stats = dashboard.stats || {};
  const baseline = dashboard.baseline || {};

  app.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Live Signal Field</div>
        <div class="hero-title">Oracle is watching early thread motion</div>
        <div class="hero-subtitle">Velocity, reports, history, and title heat resolve into one intervention forecast.</div>
      </div>
      <svg class="signal-field" viewBox="0 0 360 132" aria-hidden="true">
        <defs>
          <radialGradient id="orbGradient" cx="50%" cy="42%" r="62%">
            <stop offset="0%" stop-color="#f5d0fe" />
            <stop offset="38%" stop-color="#a855f7" />
            <stop offset="75%" stop-color="#312e81" />
            <stop offset="100%" stop-color="#111827" />
          </radialGradient>
          <linearGradient id="threadGradient" x1="0" x2="1">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0" />
            <stop offset="42%" stop-color="#38bdf8" stop-opacity=".85" />
            <stop offset="68%" stop-color="#a855f7" />
            <stop offset="100%" stop-color="#22c55e" stop-opacity=".25" />
          </linearGradient>
          <filter id="glow" x="-45%" y="-45%" width="190%" height="190%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g class="grid-lines" stroke="#ffffff" stroke-width=".5" opacity=".16">
          <path d="M12 25 H348" />
          <path d="M12 51 H348" />
          <path d="M12 77 H348" />
          <path d="M12 103 H348" />
          <path d="M60 8 V124" />
          <path d="M132 8 V124" />
          <path d="M204 8 V124" />
          <path d="M276 8 V124" />
        </g>
        <path class="flow-line primary" d="M4 82 C54 12, 128 116, 188 58 S288 16, 352 72" fill="none" stroke="url(#threadGradient)" stroke-width="2.2" />
        <path class="flow-line secondary" d="M16 102 C82 54, 126 90, 176 34 S282 96, 348 32" fill="none" stroke="url(#threadGradient)" stroke-width="1.2" />
        <path class="flow-line tertiary" d="M0 54 C58 70, 82 22, 128 46 S232 118, 360 48" fill="none" stroke="#d8b4fe" stroke-width="1" />
        <g class="packet">
          <circle r="3.5" fill="#38bdf8" />
          <circle r="8" fill="none" stroke="#38bdf8" opacity=".35" />
        </g>
        <g class="packet alt">
          <circle r="3" fill="#22c55e" />
          <circle r="7" fill="none" stroke="#22c55e" opacity=".35" />
        </g>
        <g class="oracle-core" transform="translate(226 66)">
          <circle class="ring slow" r="54" fill="none" stroke="#a855f7" stroke-width="1" opacity=".46" />
          <circle class="ring" r="42" fill="none" stroke="#38bdf8" stroke-width="1.2" stroke-dasharray="9 15" opacity=".72" />
          <circle class="ring inner" r="29" fill="none" stroke="#d8b4fe" stroke-width="1" stroke-dasharray="3 8" opacity=".66" />
          <g class="orbit">
            <circle cx="0" cy="-42" r="3" fill="#f5d0fe" />
            <circle cx="36" cy="20" r="2.2" fill="#38bdf8" />
          </g>
          <path class="rune" d="M-7 -5 L0 -18 L7 -5 L0 18 Z" fill="none" stroke="#f5d0fe" stroke-width="1.2" opacity=".82" />
          <path class="rune cross" d="M-18 0 H18 M0 -18 V18" stroke="#38bdf8" stroke-width="1" opacity=".52" />
          <circle class="orb" r="22" fill="url(#orbGradient)" />
        </g>
        <g fill="#f5d0fe">
          <circle class="spark" style="--delay:-.3s" cx="92" cy="92" r="2.2" />
          <circle class="spark" style="--delay:-1.6s" cx="128" cy="36" r="1.6" />
          <circle class="spark" style="--delay:-2.4s" cx="174" cy="102" r="1.8" />
          <circle class="spark" style="--delay:-3.2s" cx="278" cy="92" r="2" />
          <circle class="spark" style="--delay:-4.1s" cx="312" cy="44" r="1.4" />
        </g>
        <g class="glyphs" stroke="#d8b4fe" stroke-width="1" opacity=".58">
          <path class="rune" d="M80 20 l7 7 l-7 7 l-7 -7 z" fill="none" />
          <path class="rune" d="M318 96 l8 0 l-4 -8 z" fill="none" />
          <path class="rune" d="M146 70 c6 -8 12 -8 18 0 c-6 8 -12 8 -18 0z" fill="none" />
        </g>
      </svg>
    </section>

    <div class="topline">
      <div class="brand"><span class="brand-orb" aria-hidden="true"></span><span>ORACLE</span></div>
      <div class="subtle">Intervention Queue</div>
      <div class="spacer"></div>
      <div class="subtle">${predictions.length} recent</div>
    </div>

    ${
      (baseline.totalPostsSampled || 0) < 10
        ? `<div class="warm"><strong>Baseline warming up</strong><span>${baseline.totalPostsSampled || 0}/10 sampled; velocity scoring gets smarter as history fills in.</span></div>`
        : ''
    }

    <section class="stats">
      <div class="stat"><span>Critical</span><strong style="color:var(--red)">${pending.filter((p) => p.signals?.level === 'critical').length}</strong></div>
      <div class="stat"><span>High</span><strong style="color:var(--orange)">${pending.filter((p) => p.signals?.level === 'high').length}</strong></div>
      <div class="stat"><span>Watching</span><strong style="color:var(--yellow)">${watching.length}</strong></div>
      <div class="stat"><span>Resolved</span><strong style="color:var(--green)">${resolved.length}</strong></div>
    </section>

    ${renderSettings(dashboard.settings)}
    ${renderSection('Needs Attention', needsAttention, 'No high-risk threads are pending.')}
    ${renderSection('Watching', watching, 'No low or moderate threads are pending.')}
    ${renderSection('Resolved', resolved, 'No outcomes marked yet.')}

    <footer class="footer">
      <span>Last updated: ${humanTime(Date.now())}</span>
      <div class="footer-actions">
        <span>Alerts ${stats.alertsSent || 0} / Intervened ${stats.intervenedCount || 0} / False alarms ${stats.falseAlarmCount || 0}</span>
        <button class="btn-secondary" data-action="settings">${settingsOpen ? 'Close settings' : 'Settings'}</button>
      </div>
    </footer>
  `;
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const postId = target.dataset.postId;
  if (action === 'settings') {
    settingsOpen = !settingsOpen;
    render();
    return;
  }
  if (action === 'refresh') {
    requestDashboard('refresh');
    return;
  }
  if (action === 'open') {
    post('open-thread', { postId });
    return;
  }
  if (action === 'intervened' || action === 'false-alarm') {
    markOutcome(postId, action === 'intervened' ? 'intervened' : 'false_alarm');
  }
});

addEventListener('message', (event) => {
  const message = unwrap(event.data);
  if (!message || message.type !== 'dashboard-data') return;
  clearLoadTimer();
  loadError = null;
  dashboard = message.data;
  render();
});

requestDashboard('ready');
setTimeout(() => {
  if (!dashboard) post('ready');
}, 600);
setTimeout(() => {
  if (!dashboard) post('ready');
}, 1_500);
