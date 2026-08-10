// Demonstrates retries + exponential backoff + a rate limiter protecting a
// flaky downstream API, and jobs that exhaust all attempts landing in the DLQ.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../src/core/Queue.js';
import { RetryPolicy } from '../src/core/RetryPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const queue = new Queue('flaky-api-demo', {
  concurrency: 3,
  dataDir: path.join(__dirname, '..', 'data', 'examples'),
  retryPolicy: new RetryPolicy({ baseDelayMs: 200, maxDelayMs: 3000, jitter: 0.4 }),
  rateLimit: { capacity: 5, refillPerSecond: 3 }, // be polite to the "upstream" API
});
queue.process('call-flaky-api', path.join(__dirname, 'handlers', 'callFlakyApi.js'));

queue.on('job:retrying', (j) => console.log(`↻ #${j.id.slice(0, 8)} failed (${j.error}) — retry in ${j.nextDelayMs}ms`));
queue.on('job:completed', (j) => console.log(`✔ #${j.id.slice(0, 8)} succeeded on attempt ${j.attempts}`));
queue.on('job:dead', (j) => console.log(`✘ #${j.id.slice(0, 8)} exhausted retries — moved to the dead-letter queue`));

for (let i = 0; i < 15; i++) queue.add('call-flaky-api', { seq: i }, { maxAttempts: 4 });

setTimeout(async () => {
  console.log('\nDead-letter queue:', queue.dlq.list().map((j) => j.id));
  console.log('Final stats:', queue.stats());
  await queue.close();
  process.exit(0);
}, 6000);
