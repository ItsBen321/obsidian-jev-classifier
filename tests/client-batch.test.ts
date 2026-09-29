import test from 'node:test';
import assert from 'node:assert/strict';
import { askJev, checkCancelled, JevError, RequestCooldown, retryAfterMs, wait, type TransportResponse } from '../src/client';
import { buildEvaluation, parseGuide } from '../src/core';
import { normalizeConcurrency, runBatch, type BatchProgress } from '../src/batch';
import { STARTER_GUIDE } from '../src/template';

const evaluation = buildEvaluation(parseGuide(STARTER_GUIDE));
const ok: TransportResponse = { status: 200, headers: {}, json: { answers: {} } };
test('sends all independent questions in one request and separates title and content', async () => {
  let calls = 0;
  await askJev(async (body, key) => {
    calls++;
    const request = JSON.parse(body);
    assert.equal(key, 'test-key');
    assert.equal(request.model, 'jev-latest');
    assert.deepEqual(request.state, { note: { title: 'Title', content: 'Text' } });
    assert.equal(Object.keys(request.questions).length, 6);
    return ok;
  }, 'test-key', 'Title', 'Text', evaluation, new AbortController().signal);
  assert.equal(calls, 1);
});
test('retries rate limits with a bounded number of attempts', async () => {
  let calls = 0;
  await askJev(async () => ++calls < 3 ? { status: 429, headers: {}, json: null } : ok, 'key', '', '', evaluation, new AbortController().signal, { backoffMs: 1 });
  assert.equal(calls, 3);
});
test('auth failures stop a batch and do not leak provider bodies', async () => {
  await assert.rejects(askJev(async () => ({ status: 401, headers: {}, json: { secret: 'private text' } }), 'secret-key', '', '', evaluation, new AbortController().signal), error => error instanceof JevError && error.stopBatch && !error.message.includes('private') && !error.message.includes('secret-key'));
});
test('long retry-after waits and remains cancellable instead of failing the batch', async () => {
  let calls = 0;
  const controller = new AbortController();
  const pending = askJev(async () => { calls++; return { status: 429, headers: { 'Retry-After': '90' }, json: null }; }, 'key', '', '', evaluation, controller.signal, {
    onRetry: notice => { assert.ok(notice.delayMs >= 90_000); setTimeout(() => controller.abort(), 5); },
  });
  await assert.rejects(pending, /Stopped/);
  assert.equal(calls, 1);
});
test('timeout and cancellation discard late network results', async () => {
  await assert.rejects(askJev(() => new Promise(() => {}), 'key', '', '', evaluation, new AbortController().signal, { timeoutMs: 5, backoffMs: 1, maxAttempts: 2 }), /timed out.*2 attempts/);
  const controller = new AbortController();
  let finish!: (response: TransportResponse) => void;
  const pending = askJev(() => new Promise(resolve => { finish = resolve; }), 'key', '', '', evaluation, controller.signal);
  await wait(1, controller.signal);
  controller.abort();
  await assert.rejects(pending, /Stopped/);
  finish(ok);
});
test('cancelling before the request starts avoids a network call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = askJev(async () => { calls++; return ok; }, 'key', '', '', evaluation, controller.signal);
  controller.abort();
  await assert.rejects(pending, /Stopped/);
  assert.equal(calls, 0);
});
test('batch runs sequentially and continues after individual failures', async () => {
  let inFlight = 0;
  const state = await runBatch([{ path: 'a' }, { path: 'b' }, { path: 'c' }], new AbortController().signal, async file => {
    inFlight++;
    assert.equal(inFlight, 1);
    await Promise.resolve();
    inFlight--;
    if (file.path === 'b') throw new Error('Bad note');
    return file.path === 'c' ? 'skipped' : 'updated';
  }, () => {}, 1);
  assert.equal(state.processed, 3);
  assert.equal(state.updated, 1);
  assert.equal(state.skipped, 1);
  assert.equal(state.failures[0]!.path, 'b');
  assert.equal(state.done, true);
});
test('cancelled batches do not start another note', async () => {
  const controller = new AbortController();
  const visited: string[] = [];
  const state = await runBatch([{ path: 'a' }, { path: 'b' }], controller.signal, async file => { visited.push(file.path); controller.abort(); return 'updated'; }, () => {}, 1);
  assert.deepEqual(visited, ['a']);
  assert.equal(state.updated, 1);
  assert.equal(state.stopped, true);
});
test('fatal provider errors stop the run after one note', async () => {
  const state = await runBatch([{ path: 'a' }, { path: 'b' }], new AbortController().signal, async () => { throw new JevError('Invalid API key', true); }, () => {}, 1);
  assert.equal(state.processed, 1);
  assert.equal(state.failures.length, 1);
  assert.equal(state.stopped, true);
});

test('network failures retry and report the attempt before recovering', async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await askJev(async () => {
    if (++calls < 3) throw new Error('network details containing private request data');
    return ok;
  }, 'key', '', '', evaluation, new AbortController().signal, { backoffMs: 1, onRetry: notice => {
    retries.push(notice.attempt);
    assert.ok(!notice.reason.includes('private'));
  } });
  assert.deepEqual(result, ok.json);
  assert.deepEqual(retries, [2, 3]);
});
test('a timeout can recover on retry and the late first answer is ignored', async () => {
  let calls = 0;
  let late!: (value: TransportResponse) => void;
  const result = await askJev(() => ++calls === 1 ? new Promise(resolve => { late = resolve; }) : Promise.resolve(ok), 'key', '', '', evaluation, new AbortController().signal, { backoffMs: 1, timeoutMs: 5 });
  assert.equal(calls, 2);
  assert.deepEqual(result, ok.json);
  late({ ...ok, json: 'stale response' });
});
test('server and rate-limit errors exhaust four attempts without stopping the vault', async () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) {
    let calls = 0;
    await assert.rejects(askJev(async () => { calls++; return { status, headers: {}, json: null }; }, 'key', '', '', evaluation, new AbortController().signal, { backoffMs: 1 }), error => error instanceof JevError && !error.stopBatch && error.message.includes('4 attempts'));
    assert.equal(calls, 4, `HTTP ${status}`);
  }
});
test('bad notes are not retried, and account errors require user action', async () => {
  for (const status of [401, 402, 403, 413, 422]) {
    let calls = 0;
    await assert.rejects(askJev(async () => { calls++; return { status, headers: {}, json: null }; }, 'key', '', '', evaluation, new AbortController().signal), error => error instanceof JevError && error.stopBatch === [401, 402, 403].includes(status));
    assert.equal(calls, 1);
  }
});
test('retry-after supports seconds and HTTP dates', () => {
  assert.equal(retryAfterMs({ 'Retry-After': '90' }), 90_000);
  assert.equal(retryAfterMs({ 'retry-after': 'Tue, 29 Sep 2026 12:01:00 GMT' }, Date.parse('2026-09-29T12:00:00Z')), 60_000);
  assert.equal(retryAfterMs({ 'Retry-After': 'invalid' }), 0);
  assert.equal(retryAfterMs({ 'Retry-After': '-1' }), 0);
});
test('a shared cooldown delays requests from other workers', async () => {
  const cooldown = new RequestCooldown();
  const controller = new AbortController();
  let calls = 0;
  cooldown.defer(60_000);
  const pending = askJev(async () => { calls++; return ok; }, 'key', '', '', evaluation, controller.signal, { cooldown });
  await wait(5, new AbortController().signal);
  controller.abort();
  await assert.rejects(pending, /Stopped/);
  assert.equal(calls, 0);
});
test('a rate-limit reply pauses the next worker before it sends its request', async () => {
  const cooldown = new RequestCooldown();
  const controller = new AbortController();
  let siblingCalls = 0;
  let sibling: Promise<unknown> | undefined;
  const first = askJev(async () => ({ status: 429, headers: { 'Retry-After': '90' }, json: null }), 'key', '', '', evaluation, controller.signal, {
    cooldown,
    onRetry: () => {
      sibling = askJev(async () => { siblingCalls++; return ok; }, 'key', '', '', evaluation, controller.signal, { cooldown }).catch(error => error);
      setTimeout(() => controller.abort(), 5);
    },
  });
  await assert.rejects(first, /Stopped/);
  const siblingError = await sibling;
  assert.ok(siblingError instanceof JevError);
  assert.equal(siblingCalls, 0);
});
test('parallel batch respects its limit, completes out of order, and exposes retry status', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const finished: string[] = [];
  const snapshots: BatchProgress[] = [];
  const files = Array.from({ length: 12 }, (_, i) => ({ path: String(i) }));
  const state = await runBatch(files, new AbortController().signal, async (file, signal, onStatus) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    assert.ok(inFlight <= 3);
    onStatus('Retry 2/4');
    await wait(file.path === '0' ? 20 : 1, signal);
    inFlight--;
    finished.push(file.path);
    return 'updated';
  }, snapshot => snapshots.push(snapshot), 3);
  assert.equal(maxInFlight, 3);
  assert.equal(state.updated, 12);
  assert.equal(state.processed, 12);
  assert.equal(new Set(finished).size, 12);
  assert.notEqual(finished[0], '0');
  assert.deepEqual(state.remaining, []);
  assert.ok(snapshots.some(snapshot => snapshot.active.some(item => item.status === 'Retry 2/4')));
  assert.deepEqual(snapshots.at(-1)!.active, []);
});
test('a failed request midway does not prevent later notes from finishing', async () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ path: String(i) }));
  const counts = new Map<string, number>();
  const state = await runBatch(files, new AbortController().signal, async (file, signal) => {
    await askJev(async () => {
      counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
      if (file.path === '10') throw new Error('offline');
      return ok;
    }, 'key', '', '', evaluation, signal, { backoffMs: 1 });
    return 'updated';
  }, () => {}, 4);
  assert.equal(state.processed, 20);
  assert.equal(state.updated, 19);
  assert.equal(state.stopped, false);
  assert.equal(counts.get('10'), 4);
  assert.deepEqual(state.remaining, ['10']);
  assert.equal(state.failures.length, 1);
  const retried: string[] = [];
  await runBatch(files.filter(file => state.remaining.includes(file.path)), new AbortController().signal, async file => { retried.push(file.path); return 'updated'; }, () => {});
  assert.deepEqual(retried, ['10']);
});
test('stop cancels every active worker and keeps unfinished notes available to retry', async () => {
  const controller = new AbortController();
  const files = Array.from({ length: 8 }, (_, i) => ({ path: String(i) }));
  const started: string[] = [];
  const pending = runBatch(files, controller.signal, async (file, signal) => {
    checkCancelled(signal);
    started.push(file.path);
    await wait(60_000, signal);
    return 'updated';
  }, () => {}, 3);
  controller.abort();
  const result = await pending;
  assert.equal(started.length, 3);
  assert.equal(result.processed, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(result.remaining.length, 8);
  assert.equal(result.stopped, true);
});
test('an account error cancels sibling workers and does not start queued notes', async () => {
  const files = Array.from({ length: 8 }, (_, i) => ({ path: String(i) }));
  const started: string[] = [];
  const result = await runBatch(files, new AbortController().signal, async (file, signal) => {
    started.push(file.path);
    if (file.path === '0') throw new JevError('Invalid API key', true);
    await wait(60_000, signal);
    return 'updated';
  }, () => {}, 3);
  assert.equal(started.length, 3);
  assert.equal(result.processed, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.remaining.length, 8);
  assert.equal(result.stopped, true);
});
test('concurrency settings are bounded and invalid saved values use the default', () => {
  assert.equal(normalizeConcurrency(undefined), 4);
  assert.equal(normalizeConcurrency(NaN), 4);
  assert.equal(normalizeConcurrency(0), 1);
  assert.equal(normalizeConcurrency(999), 16);
  assert.equal(normalizeConcurrency(1), 1);
});
