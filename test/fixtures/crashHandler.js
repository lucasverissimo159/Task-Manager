// Deliberately crashes the *worker thread itself* — not just the job — by
// throwing outside the try/catch workerRunner.js wraps around normal
// execution. This reproduces a genuine worker crash (segfault-like, OOM,
// a buggy native addon...), the exact case WorkerPool's crash-recovery
// path exists for, as opposed to an ordinary rejected/thrown job handler.
export default async function crash() {
  setImmediate(() => {
    throw new Error('simulated worker crash');
  });
  await new Promise(() => {}); // never resolves — the process dies before this matters
}
