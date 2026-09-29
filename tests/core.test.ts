import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { applyMatches, buildEvaluation, parseGuide, readMatches, splitNote, type Match } from '../src/core';
import { STARTER_GUIDE } from '../src/template';

const guide = parseGuide(STARTER_GUIDE);
const evaluation = buildEvaluation(guide);
function response() {
  return { answers: Object.fromEntries(Object.entries(evaluation.questions).map(([id, q]) => [id, q.type === 'noul'
    ? { type: 'noul', noul: id === 'p1_o0' ? 0.95 : 0.1 }
    : { type: 'choice', choice: 'o0', confidence: 0.9, probabilities: { none: 0.02, o0: 0.9, o1: 0.03, o2: 0.03, o3: 0.02 } }])) };
}
test('starter guide creates independent label questions and a choice with no-match', () => {
  assert.equal(guide.properties.length, 3);
  assert.equal(Object.keys(evaluation.questions).length, 6);
  assert.equal(evaluation.questions.p0!.type, 'choice');
  assert.ok(evaluation.questions.p0!.criteria.none);
  assert.equal(evaluation.questions.p1_o0!.type, 'noul');
  assert.match(JSON.stringify(evaluation.questions.p1_o0), /programming/);
});
test('accepts CRLF guides and rejects missing, ambiguous, duplicate, or mistyped guides', () => {
  assert.equal(parseGuide(STARTER_GUIDE.replace(/\n/g, '\r\n')).properties.length, 3);
  assert.throws(() => parseGuide('Just prose'), /exactly one/);
  assert.throws(() => parseGuide(STARTER_GUIDE + STARTER_GUIDE), /exactly one/);
  assert.throws(() => parseGuide(STARTER_GUIDE.replace('mode: single', 'mode: single\n    mode: multiple')), /unique/i);
  assert.throws(() => parseGuide(STARTER_GUIDE.replace('mode: single', 'mode: singel')), /single or multiple/);
  assert.throws(() => parseGuide(STARTER_GUIDE.replace('threshold: 0.8', 'threshhold: 0.8')), /Unknown field/);
  assert.throws(() => parseGuide(STARTER_GUIDE.replace('threshold: 0.8', 'threshold: .nan')), /between/);
  assert.throws(() => parseGuide(STARTER_GUIDE.replace('note-type:', '__proto__:')), /Invalid property/);
  assert.throws(() => parseGuide(STARTER_GUIDE.replace('actionable:', 'not a tag:')), /Invalid Obsidian tag/);
});
test('matches only accepted choices and labels', () => {
  const result = readMatches(evaluation, response());
  assert.deepEqual(result.map(match => match.values), [['idea'], ['programming'], []]);
  const uncertain = response();
  uncertain.answers.p0!.confidence = 0.6;
  assert.deepEqual(readMatches(evaluation, uncertain)[0]!.values, []);
  uncertain.answers.p0!.choice = 'none';
  uncertain.answers.p0!.confidence = 1;
  assert.deepEqual(readMatches(evaluation, uncertain)[0]!.values, []);
});
test('rejects a partial response, unknown choice, wrong types, and invalid distributions', () => {
  const missing = response(); delete missing.answers.p2_o1;
  assert.throws(() => readMatches(evaluation, missing), /missing or invalid/);
  const unknown = response(); unknown.answers.p0!.choice = 'new-invented-value';
  assert.throws(() => readMatches(evaluation, unknown), /invalid choice/);
  const invalid = response(); invalid.answers.p1_o0!.noul = 1.1;
  assert.throws(() => readMatches(evaluation, invalid), /invalid probability/);
  const distribution = response(); distribution.answers.p0!.probabilities!.o0 = 0.1;
  assert.throws(() => readMatches(evaluation, distribution), /probabilities/);
});
test('adds frontmatter without changing the Markdown body', () => {
  const body = '# Hello\n\nA programming idea.\n```yaml\nnot: frontmatter\n```\n';
  const result = applyMatches(body, readMatches(evaluation, response()), 'merge');
  assert.equal(result.changed, 2);
  assert.equal(splitNote(result.content).body, body);
  assert.deepEqual(parse(splitNote(result.content).yaml), { 'note-type': 'idea', topics: ['programming'] });
});
test('merge keeps single values, deduplicates lists, preserves other fields and comments', () => {
  const source = '---\n# Keep this comment\nnote-type: reference\ntopics: [design, programming]\ncreated: 2026-01-02\ncustom: true\n---\nBody\n';
  const result = applyMatches(source, readMatches(evaluation, response()), 'merge');
  assert.equal(result.content, source);
  const more: Match[] = [{ property: guide.properties[1]!, values: ['learning'] }];
  const updated = applyMatches(source, more, 'merge').content;
  assert.match(updated, /# Keep this comment/);
  const properties = parse(splitNote(updated).yaml);
  assert.equal(properties['note-type'], 'reference');
  assert.equal(properties.custom, true);
  assert.deepEqual(properties.topics, ['design', 'programming', 'learning']);
  assert.equal(splitNote(updated).body, 'Body\n');
});
test('replace updates only matching managed properties and keeps unmatched values', () => {
  const source = '---\nnote-type: reference\ntopics: [design]\ntags: [manual]\naliases: [Example]\n---\nBody';
  const updated = applyMatches(source, readMatches(evaluation, response()), 'replace').content;
  assert.deepEqual(parse(splitNote(updated).yaml), { 'note-type': 'idea', topics: ['programming'], tags: ['manual'], aliases: ['Example'] });
});
test('preserves BOM, CRLF, and notes with frontmatter only', () => {
  const source = '\uFEFF---\r\ncustom: yes\r\n---\r\n# Body\r\nText';
  const updated = applyMatches(source, readMatches(evaluation, response()), 'merge').content;
  assert.ok(updated.startsWith('\uFEFF---\r\n'));
  assert.equal(splitNote(updated).body, '# Body\r\nText');
  assert.ok(!updated.replace(/\r\n/g, '').includes('\n'));
  assert.equal(splitNote('---\na: b\n---').body, '');
  assert.equal(splitNote('Before\n---\na: b\n---\nAfter').body, 'Before\n---\na: b\n---\nAfter');
});
test('no matches are byte-identical; incompatible properties fail without partial writes', () => {
  const source = '---\nnote-type: reference\ntopics: 123\n---\nBody';
  assert.equal(applyMatches(source, [], 'merge').content, source);
  assert.throws(() => applyMatches(source, readMatches(evaluation, response()), 'merge'), /not text or a list/);
  assert.throws(() => applyMatches('---\nbroken: [\n---\nBody', [], 'merge'), /Note properties/);
  assert.throws(() => splitNote('---\nunclosed: true\nBody'), /unclosed/);
});
test('property matching respects Obsidian case-insensitivity', () => {
  const source = '---\nTopics: [manual]\n---\nBody';
  const updated = applyMatches(source, readMatches(evaluation, response()), 'merge').content;
  const properties = parse(splitNote(updated).yaml);
  assert.deepEqual(properties.Topics, ['manual', 'programming']);
  assert.equal(properties.topics, undefined);
});
