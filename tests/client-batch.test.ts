import test from 'node:test';
import assert from 'node:assert/strict';
import { askJev, JevError, type TransportResponse } from '../src/client';
import { buildEvaluation, parseGuide } from '../src/core';
import { runBatch } from '../src/batch';
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
test('long retry-after stops without retrying early', async () => {
  let calls = 0;
  await assert.rejects(askJev(async () => { calls++; return { status: 429, headers: { 'Retry-After': '90' }, json: null }; }, 'key', '', '', evaluation, new AbortController().signal), /longer pause/);
  assert.equal(calls, 1);
});
test('timeout and cancellation discard late network results', async () => {
  await assert.rejects(askJev(() => new Promise(() => {}), 'key', '', '', evaluation, new AbortController().signal, { timeoutMs: 5 }), /timed out/);
  const controller = new AbortController();
  let finish!: (response: TransportResponse) => void;
  const pending = askJev(() => new Promise(resolve => { finish = resolve; }), 'key', '', '', evaluation, controller.signal);
  await Promise.resolve();
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
  }, () => {});
  assert.equal(state.processed, 3);
  assert.equal(state.updated, 1);
  assert.equal(state.skipped, 1);
  assert.equal(state.failures[0]!.path, 'b');
  assert.equal(state.done, true);
});
test('cancelled batches do not start another note', async () => {
  const controller = new AbortController();
  const visited: string[] = [];
  const state = await runBatch([{ path: 'a' }, { path: 'b' }], controller.signal, async file => { visited.push(file.path); controller.abort(); return 'updated'; }, () => {});
  assert.deepEqual(visited, ['a']);
  assert.equal(state.updated, 1);
  assert.equal(state.stopped, true);
});
test('fatal provider errors stop the run after one note', async () => {
  const state = await runBatch([{ path: 'a' }, { path: 'b' }], new AbortController().signal, async () => { throw new JevError('Invalid API key', true); }, () => {});
  assert.equal(state.processed, 1);
  assert.equal(state.failures.length, 1);
  assert.equal(state.stopped, true);
});
