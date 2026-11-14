// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const C = require('../chapters.js');

// Real News Hour chapter starts (seconds) from the Nov. 12, 2026 episode.
const starts = [0, 162, 664, 823, 1181, 1382, 1796, 2496, 3087];
const list = starts.map((s, i) => ({ start: s, title: 'Story ' + (i + 1) }));

test('clean drops bad entries and sorts', () => {
  const out = C.clean([{ start: 30, title: 'b' }, null, { start: 'x', title: 'c' }, { start: 0, title: 'a' }, { start: 5 }]);
  assert.deepStrictEqual(out.map((c) => c.title), ['a', 'b']);
  assert.deepStrictEqual(C.clean(undefined), []);
});

test('indexAt finds the chapter containing a time', () => {
  assert.strictEqual(C.indexAt(list, 0), 0);
  assert.strictEqual(C.indexAt(list, 161), 0);
  assert.strictEqual(C.indexAt(list, 162), 1);
  assert.strictEqual(C.indexAt(list, 2400), 6);          // about 40 minutes in
  assert.strictEqual(C.indexAt(list, 2495.7), 7);        // just shy of a start still counts
  assert.strictEqual(C.indexAt(list, 99999), 8);
  assert.strictEqual(C.indexAt([], 10), -1);
});

test('nextIndex stops at the last chapter', () => {
  assert.strictEqual(C.nextIndex(list, 0), 1);
  assert.strictEqual(C.nextIndex(list, 7), 8);
  assert.strictEqual(C.nextIndex(list, 8), -1);
  assert.strictEqual(C.nextIndex(list, -1), 0);
});

test('prevIndex restarts the story when well into it, else goes back one', () => {
  assert.strictEqual(C.prevIndex(list, 4, 90), 4);
  assert.strictEqual(C.prevIndex(list, 4, 2), 3);
  assert.strictEqual(C.prevIndex(list, 0, 2), 0);
  assert.strictEqual(C.prevIndex(list, 0, 60), 0);
});

test('from 40 minutes in, three Next presses land on the right stories', () => {
  let idx = C.indexAt(list, 2400);
  const seen = [];
  for (let i = 0; i < 3; i++) { idx = C.nextIndex(list, idx); if (idx >= 0) seen.push(list[idx].start); }
  assert.deepStrictEqual(seen, [2496, 3087]);
});
