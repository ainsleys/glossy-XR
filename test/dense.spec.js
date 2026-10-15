// A crowded room: 200 clips seeded straight into the store, across three
// periods plus timeless ones, with replies. Checks the viewer keeps the room
// readable (only the nearest markers draw in full, nothing is removed), that
// frame time stays sane, and that the year slider filters by period.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { API, markerCount, listAnnotations, aimCamera } from './helpers.js';
import { seedDense, PERIODS } from '../scripts/seed-dense.mjs';

const DATA = path.resolve('.test-data');                       // the suite's server runs with GLOSSY_DATA=.test-data

test('a crowded room thins to the nearest markers and filters by year', async ({ page, request }) => {
  const { project, count } = seedDense({ dataDir: DATA, name: 'dense-' + Date.now(), count: 200, seed: 7 });
  expect(count).toBe(200);
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`/?project=${project.id}`);
  await page.waitForFunction((id) => window.__glossy?.project?.id === id, project.id);
  await expect.poll(() => markerCount(page), { timeout: 20_000 }).toBe(200);
  const all = await listAnnotations(request, project.id);
  expect(all.filter((a) => a.parent).length).toBeGreaterThan(10);
  expect(new Set(all.map((a) => JSON.stringify(a.period))).size).toBe(PERIODS.length);

  // thinning: nothing hidden, at most MAX_FULL drawn in full, and the nearest one is among them
  await aimCamera(page, [0, 1.6, 0], [0, 1.6, -3]);
  await page.waitForTimeout(400);                               // a few frames so the ranking runs
  const full = await page.evaluate(() => window.__glossy.fullIds());
  const visible = await page.evaluate(() => window.__glossy.visibleIds());
  expect(visible).toHaveLength(200);
  expect(full.length).toBeGreaterThan(5);
  expect(full.length).toBeLessThanOrEqual(45);                  // MAX_FULL plus hovered/playing/very-near allowances
  expect(full).toContain(await page.evaluate(() => window.__glossy.nearestId()));
  // list shows everything (newest first), replies nested under parents that are present
  await expect(page.locator('#annList li')).toHaveCount(200);
  expect(await page.locator('#annList li.reply').count()).toBe(all.filter((a) => a.parent).length);

  // frame time with 200 markers on software GL: logged, and sanity-bounded
  const ms = await page.evaluate(() => new Promise((res) => { const t = []; let last = performance.now(); let n = 0; const tick = () => { const now = performance.now(); t.push(now - last); last = now; if (++n < 60) requestAnimationFrame(tick); else res(t.slice(10).reduce((a, b) => a + b, 0) / (t.length - 10)); }; requestAnimationFrame(tick); }));
  console.log('mean frame ms with 200 markers (SwiftShader):', ms.toFixed(1));
  expect(ms).toBeLessThan(250);

  // time: untick "all periods" and move the year
  const expectAt = (year) => all.filter((a) => !a.period || (parseInt(a.period.from) <= year && year <= parseInt(a.period.to))).map((a) => a.id).sort();
  await page.uncheck('#timeAll');
  await expect(page.locator('#year')).toBeEnabled();
  expect(await page.getAttribute('#year', 'min')).toBe('1950');
  expect(await page.getAttribute('#year', 'max')).toBe('2026');
  for (const year of [1955, 1980, 1995, 2010]) {
    await page.locator('#year').fill(String(year));
    await page.locator('#year').dispatchEvent('input');
    const want = expectAt(year);
    await expect.poll(() => page.evaluate(() => window.__glossy.visibleIds().sort())).toEqual(want);
    await expect(page.locator('#annList li')).toHaveCount(want.length);
    const covering = PERIODS.filter((p) => p && parseInt(p.from) <= year && year <= parseInt(p.to)).map((p) => p.label);
    await expect(page.locator('#yearLabel')).toHaveText(`${year} · ${covering.length ? covering.join(', ') : 'between periods'} · ${want.length}/200`);
  }
  // period bands under the slider: one per distinct period, placed on the slider's scale
  const bands = page.locator('#periodBands span');
  await expect(bands).toHaveCount(3);
  await expect(bands.nth(0)).toHaveText('orchard years');
  expect(await bands.nth(0).evaluate((e) => e.style.left)).toBe('0%');
  expect(parseFloat(await bands.nth(2).evaluate((e) => e.style.left))).toBeCloseTo((2000 - 1950) / 76 * 100, 0);
  // colour says when: the three periods differ from each other and from timeless grey
  const hexByPeriod = await page.evaluate(() => {
    const out = {};
    for (const m of window.__glossy.markers.values()) out[m.record.period ? m.record.period.label : 'timeless'] ??= m.mesh.material.color.getHSL({});
    return out;
  });
  expect(new Set(Object.values(hexByPeriod).map((c) => c.h.toFixed(2))).size).toBe(4);
  expect(hexByPeriod.timeless.s).toBeLessThan(0.1);                       // grey
  expect(hexByPeriod['orchard years'].h).toBeLessThan(hexByPeriod['summer house'].h);   // amber → blue with time
  expect(hexByPeriod['summer house'].h).toBeLessThan(hexByPeriod.museum.h);
  expect(expectAt(1995).length).toBeLessThan(expectAt(1955).length);   // 1995 falls between periods: only timeless clips remain
  // hidden markers are not aim targets
  await expect.poll(() => page.evaluate(() => { const g = window.__glossy; const hid = [...g.markers.values()].find((m) => !m.mesh.visible); g.camera.lookAt(hid.mesh.position); g.camera.updateMatrixWorld(true); return g.aimMarker(g.camera) === hid.record.id; })).toBe(false);
  // back to all
  await page.check('#timeAll');
  await expect.poll(() => page.evaluate(() => window.__glossy.visibleIds().length)).toBe(200);
  await expect(page.locator('#year')).toBeDisabled();
  await page.screenshot({ path: 'test-results/dense-room.png' });
});
