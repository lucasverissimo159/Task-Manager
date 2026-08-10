// Demonstrates *why* worker_threads matter: 20 CPU-bound jobs run across 4
// worker threads while the main thread keeps printing a heartbeat the whole
// time. Swap the handler for one that blocks the main thread instead, and
// the heartbeat visibly stalls — that comparison is the point of this file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../src/core/Queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const queue = new Queue('cpu-bound-demo', {
  concurrency: 4,
  dataDir: path.join(__dirname, '..', 'data', 'examples'),
});
queue.process('resize-image', path.join(__dirname, 'handlers', 'resizeImage.js'));

console.log('Dispatching 20 CPU-bound "resize image" jobs across 4 worker threads.');
console.log('Watch the heartbeat below stay steady — the main thread never blocks:\n');

const heartbeat = setInterval(() => process.stdout.write('.'), 100);
let done = 0;

const finishOne = () => {
  if (++done === 20) {
    clearInterval(heartbeat);
    console.log('\n\nAll 20 jobs finished. Stats:', queue.stats());
    queue.close().then(() => process.exit(0));
  }
};

queue.on('job:completed', finishOne);
queue.on('job:dead', finishOne);

for (let i = 0; i < 20; i++) queue.add('resize-image', { seq: i });
