// Minimal library usage: register a handler, add jobs, listen for events.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../src/core/Queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const queue = new Queue('basic-usage-example', {
  concurrency: 2,
  dataDir: path.join(__dirname, '..', 'data', 'examples'),
});

queue.process('greet', path.join(__dirname, 'handlers', 'greet.js'));

queue.on('job:completed', (job) => console.log(`✔ ${job.name} #${job.id.slice(0, 8)} →`, job.result));
queue.on('job:retrying', (job) =>
  console.log(`↻ ${job.name} #${job.id.slice(0, 8)} retrying in ${job.nextDelayMs}ms (attempt ${job.attempts}/${job.maxAttempts})`),
);
queue.on('job:dead', (job) => console.log(`✘ ${job.name} #${job.id.slice(0, 8)} dead-lettered: ${job.error}`));

for (let i = 0; i < 10; i++) queue.add('greet', { name: `User${i}` });

setTimeout(async () => {
  console.log('\nFinal stats:', queue.stats());
  await queue.close();
  process.exit(0);
}, 4000);
