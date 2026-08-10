import { parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

/**
 * Lives inside a worker thread. A worker thread cannot receive a JavaScript
 * closure from the main thread (only structured-cloneable data crosses that
 * boundary) — so, like real job systems (Sidekiq workers, Celery tasks),
 * TaskForge handlers are plain modules on disk, dynamically imported by
 * *path*, not functions passed in memory. That constraint is what actually
 * buys the isolation: a handler that segfaults, leaks memory, or spins the
 * CPU forever only takes down its own worker thread, never the process
 * running the dashboard or the rest of the queue.
 */
const handlerCache = new Map();

async function loadHandler(handlerPath) {
  if (!handlerCache.has(handlerPath)) {
    const mod = await import(pathToFileURL(handlerPath).href);
    handlerCache.set(handlerPath, mod.default ?? mod.handler);
  }
  return handlerCache.get(handlerPath);
}

parentPort.on('message', async (msg) => {
  if (msg.type !== 'run') return;
  const { job, handlerPath } = msg;
  const start = performance.now();
  try {
    const handler = await loadHandler(handlerPath);
    if (typeof handler !== 'function') {
      throw new Error(`Handler module at ${handlerPath} has no default export function`);
    }
    const result = await handler(job.payload, job);
    parentPort.postMessage({
      type: 'result',
      jobId: job.id,
      ok: true,
      result,
      durationMs: performance.now() - start,
    });
  } catch (err) {
    parentPort.postMessage({
      type: 'result',
      jobId: job.id,
      ok: false,
      error: { message: err?.message ?? String(err) },
      durationMs: performance.now() - start,
    });
  }
});
