// Simulates a CPU-bound task (real image resizing would spend its time in
// native decode/encode code) with a busy loop. This is the handler that
// actually benefits from running in a worker thread: dispatch several of
// these and the main thread's event loop stays responsive the whole time.
export default async function resizeImage(payload) {
  const start = Date.now();
  let x = 0;
  while (Date.now() - start < 40) x += Math.sqrt(x + 1);
  if (Math.random() < 0.05) throw new Error('Corrupted image buffer');
  return { width: 800, height: 600, seq: payload.seq };
}
