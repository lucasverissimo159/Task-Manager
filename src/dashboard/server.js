import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../core/Queue.js';
import { RetryPolicy } from '../core/RetryPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HANDLERS_DIR = path.join(__dirname, '..', '..', 'examples', 'handlers');
const PORT = process.env.PORT || 4000;

// A live queue, pre-wired with three realistic job types and a steady trickle
// of synthetic traffic, so the dashboard is never empty on first load.
const queue = new Queue('demo', {
  concurrency: 4,
  retryPolicy: new RetryPolicy({ baseDelayMs: 400, maxDelayMs: 8000, jitter: 0.3 }),
  rateLimit: { capacity: 10, refillPerSecond: 8 },
});

queue.process('send-welcome-email', path.join(HANDLERS_DIR, 'sendWelcomeEmail.js'));
queue.process('resize-image', path.join(HANDLERS_DIR, 'resizeImage.js'));
queue.process('call-flaky-api', path.join(HANDLERS_DIR, 'callFlakyApi.js'));

queue.on('recovered', ({ jobsRestored, walEntriesReplayed }) => {
  console.log(`[wal] restored ${jobsRestored} job(s) from disk (${walEntriesReplayed} log entries replayed)`);
});

const JOB_TYPES = ['send-welcome-email', 'resize-image', 'call-flaky-api'];
let seq = 0;
const trafficTimer = setInterval(() => {
  const name = JOB_TYPES[Math.floor(Math.random() * JOB_TYPES.length)];
  queue.add(name, { seq: seq++ }, { priority: Math.random() < 0.15 ? 10 : 0 });
}, 350);

// ---------------------------------------------------------------------------
// A small HTTP server, hand-rolled on node:http — no framework. Static files
// for the dashboard UI, plus a handful of read (and one write) REST routes.
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/stats') return sendJSON(res, 200, queue.stats());

  if (url.pathname === '/api/jobs') {
    return sendJSON(res, 200, queue.listJobs({ status: url.searchParams.get('status') || undefined, limit: 100 }));
  }

  if (url.pathname === '/api/dlq') return sendJSON(res, 200, queue.dlq.list());

  if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
    const jobId = decodeURIComponent(url.pathname.split('/')[3]);
    return sendJSON(res, 200, { cancelled: queue.cancel(jobId) });
  }

  if (req.method === 'POST' && /^\/api\/dlq\/[^/]+\/redrive$/.test(url.pathname)) {
    const jobId = decodeURIComponent(url.pathname.split('/')[3]);
    return sendJSON(res, 200, { redriven: queue.dlq.redrive(jobId) });
  }

  // Static files, defaulting "/" to index.html. Path is resolved and checked
  // to stay inside PUBLIC_DIR so a crafted "../../" can't escape it.
  const requestedPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`TaskForge dashboard → http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down (draining in-flight jobs, compacting the log)...');
  clearInterval(trafficTimer);
  server.close();
  await queue.close();
  process.exit(0);
});
