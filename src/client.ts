import type { Evaluation } from './core';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export interface TransportResponse { status: number; headers: Record<string, string>; json: unknown }
export type Transport = (body: string, key: string) => Promise<TransportResponse>;
export class JevError extends Error {
  constructor(message: string, public readonly stopBatch = false, public readonly retryable = false) { super(message); }
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
/** A rate-limit response pauses new attempts across all workers in this run. */
export class RequestCooldown {
  private until = 0;
  defer(ms: number) { this.until = Math.max(this.until, Date.now() + ms); }
  async wait(signal: AbortSignal) {
    checkCancelled(signal);
    while (this.until > Date.now()) await wait(Math.min(this.until - Date.now(), 60_000), signal);
    checkCancelled(signal);
  }
}
export function retryAfterMs(headers: Record<string, string>, now = Date.now()): number {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}
export interface RetryNotice { attempt: number; maxAttempts: number; delayMs: number; reason: string }
export interface RequestOptions {
  timeoutMs?: number;
  backoffMs?: number;
  maxAttempts?: number;
  cooldown?: RequestCooldown;
  onRetry?: (notice: RetryNotice) => void;
}
async function request(transport: Transport, body: string, key: string, signal: AbortSignal, timeoutMs: number): Promise<TransportResponse> {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new JevError('Stopped.')));
    const timer = setTimeout(() => finish(() => reject(new JevError('Jev timed out.', false, true))), timeoutMs);
    function finish(action: () => void) {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      action();
    }
    signal.addEventListener('abort', abort, { once: true });
    // requestUrl cannot abort a network call; late responses are discarded by this promise.
    Promise.resolve().then(() => { checkCancelled(signal); return transport(body, key); }).then(
      response => finish(() => resolve(response)),
      error => finish(() => reject(error instanceof JevError ? error : new JevError('Could not reach Jev. Check your connection.', false, true))),
    );
  });
}
export async function askJev(
  transport: Transport, key: string, title: string, content: string,
  evaluation: Evaluation, signal: AbortSignal,
  options: RequestOptions = {},
): Promise<unknown> {
  const body = JSON.stringify({ model: 'jev-latest', state: { note: { title, content } }, questions: evaluation.questions });
  const maxAttempts = Number.isInteger(options.maxAttempts) ? Math.max(1, Math.min(10, options.maxAttempts!)) : 4;
  const cooldown = options.cooldown ?? new RequestCooldown();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await cooldown.wait(signal);
    const base = options.backoffMs ?? 1000;
    const backoff = Math.min(30_000, base * 2 ** attempt) + Math.floor(Math.random() * base * 0.25);
    let retryDelay = backoff;
    try {
      const response = await request(transport, body, key, signal, options.timeoutMs ?? 60_000);
      checkCancelled(signal);
      if (response.status >= 200 && response.status < 300) return response.json;
      if (response.status === 401 || response.status === 403) throw new JevError('Jev rejected the API key. Check it in plugin settings.', true);
      if (response.status === 402) throw new JevError('Your Jev account needs credits. Check your TypeSafe account.', true);
      if (response.status === 413 || response.status === 422) throw new JevError('Jev could not evaluate this note and guide. They may exceed the model limits; shorten the note or reduce the guide.');
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      const requestedDelay = retryAfterMs(response.headers);
      retryDelay = Math.max(requestedDelay, backoff);
      if (retryable && ([429, 503, 529].includes(response.status) || requestedDelay > 0)) cooldown.defer(retryDelay);
      throw new JevError(response.status === 429 ? 'Jev is rate limiting requests (HTTP 429).' : `Jev returned HTTP ${response.status}.`, false, retryable);
    } catch (error) {
      checkCancelled(signal);
      if (!(error instanceof JevError) || !error.retryable || error.stopBatch) throw error;
      if (attempt + 1 >= maxAttempts) throw new JevError(`${error.message} Failed after ${maxAttempts} attempts; this note can be retried later.`);
      options.onRetry?.({ attempt: attempt + 2, maxAttempts, delayMs: retryDelay, reason: error.message });
      // Longer server-requested waits continue through the shared cooldown on the next loop.
      await wait(Math.min(retryDelay, 60_000), signal);
    }
  }
  throw new JevError('Jev is unavailable.');
}
