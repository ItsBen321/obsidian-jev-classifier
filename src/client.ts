import type { Evaluation } from './core';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export interface TransportResponse { status: number; headers: Record<string, string>; json: unknown }
export type Transport = (body: string, key: string) => Promise<TransportResponse>;
export class JevError extends Error {
  constructor(message: string, public readonly stopBatch = false) { super(message); }
}
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new JevError('Stopped.');
}
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new JevError('Stopped.')); return; }
    const abort = () => { clearTimeout(timer); reject(new JevError('Stopped.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function request(transport: Transport, body: string, key: string, signal: AbortSignal, timeoutMs: number): Promise<TransportResponse> {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new JevError('Stopped.')));
    const timer = setTimeout(() => finish(() => reject(new JevError('Jev timed out. Try again later.', true))), timeoutMs);
    function finish(action: () => void) {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      action();
    }
    signal.addEventListener('abort', abort, { once: true });
    // requestUrl cannot abort a network call; late responses are discarded by this promise.
    Promise.resolve().then(() => { checkCancelled(signal); return transport(body, key); }).then(
      response => finish(() => resolve(response)),
      () => finish(() => reject(new JevError('Could not reach Jev. Check your connection and try again.', true))),
    );
  });
}
export async function askJev(
  transport: Transport, key: string, title: string, content: string,
  evaluation: Evaluation, signal: AbortSignal,
  options: { timeoutMs?: number; backoffMs?: number } = {},
): Promise<unknown> {
  const body = JSON.stringify({ model: 'jev-latest', state: { note: { title, content } }, questions: evaluation.questions });
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(transport, body, key, signal, options.timeoutMs ?? 60_000);
    checkCancelled(signal);
    if (response.status >= 200 && response.status < 300) return response.json;
    if ([429, 502, 503, 529].includes(response.status) && attempt < 2) {
      const retryAfter = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
      const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
      const delay = retryAfter === undefined ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (delay > 30_000) throw new JevError('Jev requested a longer pause. Retry this run later.', true);
      await wait(Math.max(Number.isFinite(delay) ? delay : 0, (options.backoffMs ?? 1000) * 2 ** attempt), signal);
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new JevError('Jev rejected the API key. Check it in plugin settings.', true);
    if (response.status === 402) throw new JevError('Your Jev account needs credits. Check your TypeSafe account.', true);
    if (response.status === 413 || response.status === 422) throw new JevError('Jev could not evaluate this note and guide. They may exceed the model limits; shorten the note or reduce the guide.');
    if (response.status === 429) throw new JevError('Jev is rate limiting requests. Retry this run later.', true);
    throw new JevError(`Jev returned HTTP ${response.status}. Try again later.`, true);
  }
  throw new JevError('Jev is unavailable.', true);
}
