import { JevError } from './client';

export type Outcome = 'updated' | 'unchanged' | 'skipped';
export interface BatchProgress {
  total: number; processed: number; updated: number; unchanged: number; skipped: number;
  failures: { path: string; message: string }[];
  current: string; done: boolean; stopped: boolean;
}
export async function runBatch<T extends { path: string }>(
  files: T[], signal: AbortSignal,
  classify: (file: T) => Promise<Outcome>,
  progress: (state: BatchProgress) => void,
): Promise<BatchProgress> {
  const state: BatchProgress = { total: files.length, processed: 0, updated: 0, unchanged: 0, skipped: 0, failures: [], current: '', done: false, stopped: false };
  const report = () => progress({ ...state, failures: [...state.failures] });
  report();
  for (const file of files) {
    if (signal.aborted) break;
    state.current = file.path;
    report();
    let fatal = false;
    try { state[await classify(file)]++; }
    catch (error) {
      if (signal.aborted) break;
      state.failures.push({ path: file.path, message: error instanceof Error ? error.message : 'Could not classify this note.' });
      fatal = error instanceof JevError && error.stopBatch;
    }
    state.processed++;
    report();
    if (fatal) { state.stopped = true; break; }
  }
  state.stopped ||= signal.aborted;
  state.current = '';
  state.done = true;
  report();
  return state;
}
