import { JevError } from './client';

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export function normalizeConcurrency(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(1, Math.min(MAX_CONCURRENCY, value)) : DEFAULT_CONCURRENCY;
}
export type Outcome = 'updated' | 'unchanged' | 'skipped';
export interface BatchProgress {
  total: number; processed: number; updated: number; unchanged: number; skipped: number;
  failures: { path: string; message: string }[];
  active: { path: string; status: string }[];
  remaining: string[];
  done: boolean; stopped: boolean;
}
export async function runBatch<T extends { path: string }>(
  files: T[], signal: AbortSignal,
  classify: (file: T, signal: AbortSignal, onStatus: (status: string) => void) => Promise<Outcome>,
  progress: (state: BatchProgress) => void,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<BatchProgress> {
  const state: BatchProgress = { total: files.length, processed: 0, updated: 0, unchanged: 0, skipped: 0, failures: [], active: [], remaining: [], done: false, stopped: false };
  const active = new Map<number, { path: string; status: string }>();
  const completed = new Set<number>();
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const report = () => progress({ ...state, active: [...active.values()].map(item => ({ ...item })), failures: [...state.failures], remaining: [...state.remaining] });
  let cursor = 0;
  async function worker() {
    while (!controller.signal.aborted) {
      const index = cursor++;
      const file = files[index];
      if (!file) return;
      const path = file.path;
      active.set(index, { path, status: 'Classifying…' });
      report();
      try {
        const outcome = await classify(file, controller.signal, status => {
          if (controller.signal.aborted || !active.has(index)) return;
          active.set(index, { path, status });
          report();
        });
        state[outcome]++;
        completed.add(index);
        state.processed++;
      } catch (error) {
        if (!controller.signal.aborted) {
          state.failures.push({ path, message: error instanceof Error ? error.message : 'Could not classify this note.' });
          state.processed++;
          // Authentication and credit failures require user action; cancel sibling workers too.
          if (error instanceof JevError && error.stopBatch) { state.stopped = true; stop(); }
        }
      } finally {
        active.delete(index);
        report();
      }
    }
  }
  try {
    report();
    await Promise.all(Array.from({ length: Math.min(files.length, normalizeConcurrency(concurrency)) }, worker));
    state.stopped ||= signal.aborted;
    state.remaining = files.filter((_, index) => !completed.has(index)).map(file => file.path);
    state.done = true;
    report();
    return { ...state, active: [] };
  } finally { signal.removeEventListener('abort', stop); }
}
