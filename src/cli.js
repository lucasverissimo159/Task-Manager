import { parseArgs } from 'node:util';

/**
 * A thin client over the dashboard server's REST API — deliberately *not* a
 * tool that opens the WAL files directly. TaskForge treats a queue's WAL as
 * single-writer (see README "Known limitations"); a CLI that read/wrote it
 * directly while the server was also running would race with it. Talking to
 * the running server over HTTP instead — the same way `redis-cli` or
 * `kubectl` talk to a running server rather than touching its files — sidesteps
 * that entirely.
 */
const BASE_URL = process.env.TASKFORGE_URL || 'http://localhost:4000';

function usage() {
  console.log(`
TaskForge CLI — talks to a running dashboard server (default ${BASE_URL})

Usage:
  node src/cli.js stats
  node src/cli.js jobs [--status <waiting|active|delayed|completed|dead|cancelled>]
  node src/cli.js cancel <jobId>
  node src/cli.js dlq:list
  node src/cli.js dlq:redrive <jobId>

Set TASKFORGE_URL to point at a different server.
`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === '--help' || command === '-h') return usage();

  try {
    if (command === 'stats') {
      const res = await fetch(`${BASE_URL}/api/stats`);
      console.table(await res.json());
    } else if (command === 'jobs') {
      const { values } = parseArgs({ args: rest, options: { status: { type: 'string' } } });
      const qs = values.status ? `?status=${encodeURIComponent(values.status)}` : '';
      const res = await fetch(`${BASE_URL}/api/jobs${qs}`);
      const jobs = await res.json();
      console.table(jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, attempts: `${j.attempts}/${j.maxAttempts}` })));
    } else if (command === 'cancel') {
      const [jobId] = rest;
      if (!jobId) {
        console.error('Usage: node src/cli.js cancel <jobId>');
        process.exitCode = 1;
        return;
      }
      const res = await fetch(`${BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
      const body = await res.json();
      console.log(body.cancelled ? `Cancelled: ${jobId}` : `Could not cancel ${jobId} (not found, already active/completed/dead)`);
    } else if (command === 'dlq:list') {
      const res = await fetch(`${BASE_URL}/api/dlq`);
      const jobs = await res.json();
      console.table(jobs.map((j) => ({ id: j.id, name: j.name, error: j.error })));
    } else if (command === 'dlq:redrive') {
      const [jobId] = rest;
      if (!jobId) {
        console.error('Usage: node src/cli.js dlq:redrive <jobId>');
        process.exitCode = 1;
        return;
      }
      const res = await fetch(`${BASE_URL}/api/dlq/${encodeURIComponent(jobId)}/redrive`, { method: 'POST' });
      const body = await res.json();
      console.log(body.redriven ? `Redriven: ${jobId}` : `Could not redrive ${jobId} (not found, or not dead)`);
    } else {
      usage();
    }
  } catch {
    console.error(`Could not reach TaskForge server at ${BASE_URL}. Is it running? (npm start)`);
    process.exitCode = 1;
  }
}

main();
