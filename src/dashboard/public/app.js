// Vanilla JS dashboard client: polls the REST API and renders the DOM /
// canvas directly. No framework, no build step — open index.html served by
// the Node server and it just runs.

const STATS_INTERVAL_MS = 1000;
const JOBS_INTERVAL_MS = 1000;
const DLQ_INTERVAL_MS = 2000;
const THROUGHPUT_HISTORY_LEN = 60;

const state = {
  statusFilter: '',
  knownJobIds: new Set(),
  throughputHistory: [],
};

const liveIndicator = document.getElementById('live-indicator');
const liveLabel = document.getElementById('live-label');

function setLive(ok) {
  liveIndicator.classList.toggle('is-down', !ok);
  liveLabel.textContent = ok ? 'live' : 'disconnected';
}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Stats: pipeline counts, readouts, throughput chart
// ---------------------------------------------------------------------------

function renderStats(stats) {
  for (const key of ['waiting', 'delayed', 'active', 'completed', 'dead']) {
    document.getElementById(`count-${key}`).textContent = stats.counts[key] ?? 0;
  }
  document.getElementById('readout-throughput').textContent = stats.throughputPerSecond.toFixed(2);
  document.getElementById('readout-p50').textContent = stats.p50;
  document.getElementById('readout-p95').textContent = stats.p95;
  document.getElementById('readout-p99').textContent = stats.p99;

  state.throughputHistory.push(stats.throughputPerSecond);
  if (state.throughputHistory.length > THROUGHPUT_HISTORY_LEN) state.throughputHistory.shift();
  drawThroughputChart();
}

const canvas = document.getElementById('throughput-chart');
const ctx = canvas.getContext('2d');

function drawThroughputChart() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssHeight = 140;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = `${cssHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const data = state.throughputHistory;
  const max = Math.max(1, ...data);
  const padding = { top: 10, bottom: 18, left: 4, right: 4 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  // grid
  ctx.strokeStyle = 'rgba(107, 98, 85, 0.25)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padding.top + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(cssWidth - padding.right, y);
    ctx.stroke();
  }

  if (data.length < 2) return;

  const stepX = plotW / (THROUGHPUT_HISTORY_LEN - 1);
  const offsetX = plotW - stepX * (data.length - 1);
  const points = data.map((v, i) => ({
    x: padding.left + offsetX + i * stepX,
    y: padding.top + plotH - (v / max) * plotH,
  }));

  // filled area under the line
  const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
  grad.addColorStop(0, 'rgba(232, 114, 44, 0.35)');
  grad.addColorStop(1, 'rgba(232, 114, 44, 0)');
  ctx.beginPath();
  ctx.moveTo(points[0].x, padding.top + plotH);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, padding.top + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = '#e8722c';
  ctx.lineWidth = 2;
  ctx.stroke();

  // current-value dot
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb347';
  ctx.fill();
}

window.addEventListener('resize', drawThroughputChart);

// ---------------------------------------------------------------------------
// Job manifest table
// ---------------------------------------------------------------------------

const jobsBody = document.getElementById('jobs-body');

function renderJobs(jobs) {
  if (jobs.length === 0) {
    jobsBody.innerHTML = '<tr><td colspan="5" class="empty">no jobs match this filter</td></tr>';
    return;
  }

  const seenThisRender = new Set();
  jobsBody.innerHTML = jobs
    .map((job) => {
      seenThisRender.add(job.id);
      const isNew = !state.knownJobIds.has(job.id) && state.knownJobIds.size > 0;
      const updated = job.finishedAt ?? job.startedAt ?? job.createdAt;
      return `<tr class="${isNew ? 'is-new' : ''}">
        <td class="job-id">${job.id.slice(0, 8)}</td>
        <td>${escapeHtml(job.name)}</td>
        <td class="job-status status-${job.status}">${job.status}</td>
        <td>${job.attempts}/${job.maxAttempts}</td>
        <td>${formatTime(updated)}</td>
      </tr>`;
    })
    .join('');

  state.knownJobIds = seenThisRender;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatTime(ms) {
  if (!ms) return '–';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false });
}

document.getElementById('status-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.statusFilter = btn.dataset.status;
  state.knownJobIds = new Set(); // avoid a flash-storm when switching filters
  loadJobs();
});

async function loadJobs() {
  try {
    const qs = state.statusFilter ? `?status=${encodeURIComponent(state.statusFilter)}` : '';
    const jobs = await getJSON(`/api/jobs${qs}`);
    renderJobs(jobs);
  } catch {
    /* handled by the stats poller's connectivity indicator */
  }
}

// ---------------------------------------------------------------------------
// Scrap bin (dead-letter queue)
// ---------------------------------------------------------------------------

const scrapList = document.getElementById('scrap-list');

function renderDlq(jobs) {
  if (jobs.length === 0) {
    scrapList.innerHTML = '<li class="empty">nothing scrapped yet</li>';
    return;
  }
  scrapList.innerHTML = jobs
    .map(
      (job) => `<li class="scrap-item" data-id="${job.id}">
        <span class="scrap-name">${escapeHtml(job.name)} · #${job.id.slice(0, 8)}</span>
        <span class="scrap-error">${escapeHtml(job.error ?? 'unknown error')}</span>
        <button class="redrive-btn" data-id="${job.id}">Redrive</button>
      </li>`,
    )
    .join('');
}

scrapList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.redrive-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Redriving…';
  try {
    await getJSON(`/api/dlq/${encodeURIComponent(btn.dataset.id)}/redrive`, { method: 'POST' });
    await loadDlq();
    await loadJobs();
  } catch {
    btn.disabled = false;
    btn.textContent = 'Redrive';
  }
});

async function loadDlq() {
  try {
    renderDlq(await getJSON('/api/dlq'));
  } catch {
    /* connectivity indicator covers this */
  }
}

// ---------------------------------------------------------------------------
// Polling loops
// ---------------------------------------------------------------------------

async function pollStats() {
  try {
    renderStats(await getJSON('/api/stats'));
    setLive(true);
  } catch {
    setLive(false);
  }
}

pollStats();
loadJobs();
loadDlq();
setInterval(pollStats, STATS_INTERVAL_MS);
setInterval(loadJobs, JOBS_INTERVAL_MS);
setInterval(loadDlq, DLQ_INTERVAL_MS);
