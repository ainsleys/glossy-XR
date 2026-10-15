// The review page: the same project read at a desk. Search over transcripts,
// seek by word, a plan that points at the same clips, and the reviewer's
// edits: period, a linked photograph (which becomes an asset at the clip's
// anchor), consent, a second transcription, erasure. Then the room opens on
// a clip the reviewer picked.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { API, listAnnotations, markerCount } from './helpers.js';
import { seedDense } from '../scripts/seed-dense.mjs';

const DATA = path.resolve('.test-data');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('review page: search, seek by word, period, photo link, consent, erase', async ({ page, request }) => {
  const { project } = seedDense({ dataDir: DATA, name: 'review-' + Date.now(), count: 30, seed: 3 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`/review.html?project=${project.id}`);
  await page.waitForFunction((id) => window.__review?.project?.id === id && window.__review.records.size === 30, project.id);
  await expect(page.locator('article')).toHaveCount(30);
  await expect(page.locator('#plan circle')).toHaveCount(30);
  const all = await listAnnotations(request, project.id);
  const getOne = async (id) => (await listAnnotations(request, project.id)).find((a) => a.id === id);

  // search: accent- and case-insensitive, matching clips lit in the list and on the plan
  // pick the most frequent thing-word in this fixture so the search has several hits but not all
  const freq = new Map();
  for (const a of all) for (const w of new Set(a.transcript.toLowerCase().match(/[a-z]{5,}/g) || [])) freq.set(w, (freq.get(w) || 0) + 1);
  const word = [...freq.entries()].filter(([, n]) => n < all.length / 2).sort((x, y) => y[1] - x[1])[0][0];
  const expected = all.filter((a) => a.transcript.toLowerCase().includes(word));
  expect(expected.length).toBeGreaterThan(2);
  await page.fill('#search', word.toUpperCase());
  await expect(page.locator('article:not(.dim)')).toHaveCount(expected.length);
  await expect(page.locator('#plan circle:not(.dim)')).toHaveCount(expected.length);
  expect(await page.locator('.text .hit').count()).toBeGreaterThanOrEqual(expected.length);
  await expect(page.locator('#count')).toHaveText(`${expected.length} of 30 clips`);
  await page.fill('#search', '');
  await expect(page.locator('article.dim')).toHaveCount(0);

  // seek by word: clicking a word starts the clip at that word and selects it in the list and on the plan
  const target = all.find((a) => !a.parent && a.transcription.words?.length > 3);
  const card = page.locator(`article[data-id="${target.id}"]`);
  const w = card.locator('.text .w').nth(2);
  const s = Number(await w.getAttribute('data-s'));
  expect(s).toBeGreaterThan(0);
  await w.click();
  await expect(card).toHaveClass(/sel/);
  await expect(page.locator(`#plan circle[data-id="${target.id}"]`)).toHaveClass(/sel/);
  await expect.poll(() => page.evaluate(() => window.__review.audio.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(s - 0.05);
  await expect(page.locator('#player')).toHaveClass(/on/);

  // period: set after the fact, shown on the card, offered as a filter
  await card.locator('.from').fill('1931'); await card.locator('.to').fill('1939'); await card.locator('.label').fill('the mill years');
  await card.locator('.savePeriod').click();
  await expect(card.locator('.head .period')).toHaveText('the mill years');
  expect((await getOne(target.id)).period).toEqual({ from: '1931', to: '1939', label: 'the mill years' });
  const chip = page.locator('#filters button', { hasText: 'the mill years' });
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(page.locator('article:not(.dim)')).toHaveCount(1);
  await chip.click();
  await expect(page.locator('article:not(.dim)')).toHaveCount(30);

  // photo: becomes an image asset standing at the clip's anchor, and the record links to it
  await card.locator('input.photo').setInputFiles({ name: 'loom.png', mimeType: 'image/png', buffer: PNG });
  await expect(card.locator('.links img')).toHaveCount(1);
  const linked = await getOne(target.id);
  expect(linked.links).toHaveLength(1);
  expect(linked.links[0]).toMatchObject({ kind: 'image', title: 'loom.png' });
  const proj = await (await request.get(`${API}/api/projects/${project.id}`)).json();
  const asset = proj.assets.find((a) => a.id === linked.links[0].asset);
  expect(asset.type).toBe('image');
  expect(asset.options.mode).toBe('plane');
  expect(Math.hypot(asset.transform.x - target.anchor.x, asset.transform.z - target.anchor.z)).toBeLessThan(0.15);
  expect(asset.transform.y).toBeCloseTo(target.anchor.y + 0.3, 2);          // hung just above the mark
  const exported = await (await request.get(`${API}/api/projects/${project.id}/export`)).json();
  expect(exported.contributions.find((c) => c.id === target.id).links).toHaveLength(1);
  // in the EDM export the period is a TimeSpan and the photo a view of the clip
  const edmOf = async () => (await request.get(`${API}/api/projects/${project.id}/export?format=edm`)).json();
  const choId = `${API}/api/projects/${project.id}/annotations/${target.id}`;
  let edm = await edmOf();
  const cho = edm['@graph'].find((n) => n['@id'] === choId);
  const span = edm['@graph'].find((n) => n['@id'] === cho['dcterms:temporal']);
  expect(span).toMatchObject({ '@type': 'edm:TimeSpan', 'skos:prefLabel': 'the mill years', 'edm:begin': '1931', 'edm:end': '1939' });
  expect(edm['@graph'].find((n) => n['edm:aggregatedCHO'] === choId)['edm:hasView']).toEqual([`${API}${linked.links[0].url}`]);
  await card.locator('.unlink').click();
  await expect(card.locator('.links img')).toHaveCount(0);
  expect((await getOne(target.id)).links).toHaveLength(0);

  // consent withdrawn, language set for the next transcription
  await card.locator('.consent').uncheck();
  await expect.poll(async () => (await getOne(target.id)).consent).toBe(false);
  await expect(card.locator('.head')).toContainText('consent withdrawn');
  edm = await edmOf();                                       // a withdrawn clip leaves the EDM export, and the project node says so
  expect(edm['@graph'].find((n) => n['@id'] === choId)).toBeUndefined();
  expect(edm['@graph'].find((n) => n['@id'] === `${API}/api/projects/${project.id}`)['glossy:withheldForConsent']).toBe(1);
  await card.locator('.lang').selectOption('en');
  await card.locator('.retranscribe').click();
  await expect.poll(async () => (await getOne(target.id)).language).toBe('en');

  // erase asks twice, then the clip is gone from the list, the plan and the store
  await card.locator('.erase').click();
  await expect(card.locator('.erase')).toHaveText('erase?');
  await card.locator('.erase').click();
  await expect(page.locator(`article[data-id="${target.id}"]`)).toHaveCount(0);
  await expect(page.locator(`#plan circle[data-id="${target.id}"]`)).toHaveCount(0);
  await expect.poll(async () => (await listAnnotations(request, project.id)).length).toBe(29);
});

test('the room opens standing in front of a clip picked on the review page', async ({ page, request }) => {
  const { project } = seedDense({ dataDir: DATA, name: 'focus-' + Date.now(), count: 20, seed: 5 });
  const all = await listAnnotations(request, project.id);
  const target = all.find((a) => !a.parent);
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`/?project=${project.id}&focus=${target.id}`);
  await page.waitForFunction((id) => window.__glossy?.project?.id === id, project.id);
  await expect.poll(() => markerCount(page)).toBe(20);
  const d = await page.evaluate((a) => { const c = window.__glossy.camera.position; return Math.hypot(c.x - a.x, c.z - a.z); }, target.anchor);
  expect(d).toBeGreaterThan(0.7);
  expect(d).toBeLessThan(1.3);                                              // inside the approach distance: the status previews this clip
  await expect.poll(() => page.evaluate(() => window.__glossy.nearId)).toBe(target.id);
  // the list row of that clip is marked and the status names its author once the camera settles on it
  await expect(page.locator('#annList li.hot')).toHaveAttribute('data-id', target.id);
  await expect(page.locator('#reviewLink')).toHaveAttribute('href', `/review.html?project=${project.id}`);
});
