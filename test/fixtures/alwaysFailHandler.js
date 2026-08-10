export default async function alwaysFail() {
  throw new Error('deliberate failure for testing retries/DLQ');
}
