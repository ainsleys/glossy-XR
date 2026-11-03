// node --test: the room's string table (shared/strings.js). Every language has
// the same keys and the same {variables}, nothing is empty, t() formats and
// falls back to English, and no Turkish string is waiting for a reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, TR_UNREVIEWED, LANGS, t, num, plural } from '../../shared/strings.js';

const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every language has exactly the keys of en', () => {
  const en = Object.keys(STRINGS.en);
  for (const lang of LANGS) {
    const have = Object.keys(STRINGS[lang]);
    const missing = en.filter((k) => !have.includes(k)), extra = have.filter((k) => !en.includes(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${lang}: missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`);
  }
});

test('no string is empty', () => {
  for (const lang of LANGS) {
    const empty = Object.entries(STRINGS[lang]).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
    assert.deepEqual(empty, [], `${lang}: empty ${empty.join(', ')}`);
  }
});

test('every {variable} of an en string appears in the other languages, and no other', () => {
  for (const lang of LANGS) {
    const wrong = Object.keys(STRINGS.en).filter((k) => STRINGS[lang][k] !== undefined && JSON.stringify(vars(STRINGS.en[k])) !== JSON.stringify(vars(STRINGS[lang][k])));
    assert.deepEqual(wrong, [], `${lang}: variables differ from en in ${wrong.map((k) => `${k} (en ${vars(STRINGS.en[k])}, ${lang} ${vars(STRINGS[lang][k])})`).join('; ')}`);
  }
});

test('t() fills variables, picks the language, and falls back to English for a missing key or language', () => {
  assert.equal(t('status.savedOn', { dur: '1.2s', object: 'pot' }), 'saved 1.2s on pot');
  assert.equal(t('status.savedOn', { dur: '1,2 sn', object: 'pot' }, 'tr'), STRINGS.tr['status.savedOn'].replace('{dur}', '1,2 sn').replace('{object}', 'pot'));
  assert.equal(t('status.noConsent', {}, 'tr'), STRINGS.tr['status.noConsent']);
  assert.equal(t('status.noConsent', {}, 'xx'), STRINGS.en['status.noConsent']);
  STRINGS.tr['test.only'] = undefined; STRINGS.en['test.only'] = 'english {n}';
  try { assert.equal(t('test.only', { n: 3 }, 'tr'), 'english 3'); } finally { delete STRINGS.tr['test.only']; delete STRINGS.en['test.only']; }
  assert.equal(t('status.saved', {}), 'saved {dur}');                    // an unfilled variable stays visible
  assert.equal(num(1.25, 1, 'en'), '1.3');
  assert.equal(num(1.25, 1, 'tr'), '1,3');
  assert.equal(num(1234.5, 1, 'en'), '1234.5');                         // no grouping, as toFixed
  assert.equal(plural('list.daysAgo', 1), 'list.daysAgo.one');
  assert.equal(plural('list.daysAgo', 3), 'list.daysAgo.other');
});

test('every key in TR_UNREVIEWED is a Turkish key', () => {
  const unknown = [...TR_UNREVIEWED].filter((k) => !(k in STRINGS.tr));
  assert.deepEqual(unknown, [], `not in STRINGS.tr: ${unknown.join(', ')}`);
});

test('every Turkish string has been read by a Turkish speaker (TR_UNREVIEWED is empty)', () => {
  assert.deepEqual([...TR_UNREVIEWED], [], `not yet read by a Turkish speaker: ${[...TR_UNREVIEWED].join(', ')}`);
});
