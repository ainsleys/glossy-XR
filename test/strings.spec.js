// The room in the project's interface language (shared/strings.js): a project
// with uiLanguage 'tr' shows Turkish consent, visitor help, status and headset
// hints; ?lang= overrides it for one page and survives the URL rewrite on open;
// a PATCH of uiLanguage redraws an open page. Expected text is read from the
// table, never written here, so rewording a string does not break the test.
import { test, expect } from '@playwright/test';
import { API, lockPointer, status } from './helpers.js';
import { STRINGS, t } from '../shared/strings.js';

const TR = STRINGS.tr, EN = STRINGS.en;

async function newProject(request, name, patch) {
  const p = await (await request.post(`${API}/api/projects`, { data: { name } })).json();
  if (patch) expect((await request.patch(`${API}/api/projects/${p.id}`, { data: patch })).ok()).toBeTruthy();
  return p;
}
async function open(page, id, query = '') {
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`/?project=${id}${query}`);
  await page.waitForFunction((id) => window.__glossy?.project?.id === id, id);
}

test('a Turkish project speaks Turkish to a visitor; ?lang=en overrides it; a PATCH of uiLanguage redraws the page', async ({ page, request }) => {
  const project = await newProject(request, 'strings-tr', { uiLanguage: 'tr' });
  expect((await (await request.get(`${API}/api/projects/${project.id}`)).json()).uiLanguage).toBe('tr');
  expect((await request.patch(`${API}/api/projects/${project.id}`, { data: { uiLanguage: 'de' } })).status()).toBe(400);   // en or tr only

  await open(page, project.id, '&mode=visitor');
  await expect(page.locator('#consentText')).toHaveText(TR['consent.plain']);
  await expect(page.locator('#visitorHelp')).toHaveText(TR['html.visitorHelp']);
  await expect(page.locator('label[for=author]')).toHaveText(TR['html.yourName']);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('tr');

  // a hold without consent is refused, and says why in Turkish
  await page.fill('#author', 'Ayşe');
  await page.locator('#author').dispatchEvent('change');
  await lockPointer(page);
  await page.mouse.down(); await page.mouse.up();
  await expect.poll(() => status(page), { timeout: 10_000 }).toBe(TR['status.noConsent']);
  await expect(page.locator('#hint')).toHaveText(TR['hint.idle']);

  // the operator switches the project to English: the open page redraws
  await request.patch(`${API}/api/projects/${project.id}`, { data: { uiLanguage: 'en' } });
  await expect.poll(() => page.locator('#consentText').textContent()).toBe(EN['consent.plain']);
  await expect(page.locator('#visitorHelp')).toHaveText(EN['html.visitorHelp']);

  // back to Turkish, but this page asks for English: the override wins and is kept in the URL and the visitor link
  await request.patch(`${API}/api/projects/${project.id}`, { data: { uiLanguage: 'tr' } });
  await open(page, project.id, '&lang=en');
  await expect(page.locator('#consentText')).toHaveText(EN['consent.plain']);
  expect(new URL(page.url()).searchParams.get('lang')).toBe('en');
  expect(await page.locator('#visitorLink').getAttribute('href')).toMatch(/[?&]lang=en(&|$)/);

  // and the other way: an English project opened with ?lang=tr
  const english = await newProject(request, 'strings-en');
  await open(page, english.id, '&lang=tr');
  await expect(page.locator('#consentText')).toHaveText(TR['consent.plain']);
  expect(new URL(page.url()).searchParams.get('lang')).toBe('tr');
});

test.describe('headset', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ path: 'node_modules/iwer/build/iwer.js' });
    await page.addInitScript(() => {
      const dev = new IWER.XRDevice(IWER.metaQuest3);
      dev.installRuntime({ forceInstall: true });
      dev.position.set(0, 1.6, 0.6);
      window.__xr = dev;
    });
  });

  test('the headset panel of a Turkish project carries the Turkish hint', async ({ page, request }) => {
    const project = await newProject(request, 'strings-xr', { uiLanguage: 'tr', script: { questions: [{ text: 'Yazın aile nerede yemek yerdi?' }] } });
    await open(page, project.id, '&mode=visitor');
    await page.fill('#author', 'Ayşe');
    await page.locator('#author').dispatchEvent('change');
    await page.check('#consent');
    await page.locator('#VRButton').click();
    await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
    // a visitor with controllers and a question: "squeeze: hear the question · hold the trigger to answer"
    const hint = t('hint.squeezeThen', { act: TR['hint.answerTrigger'] }, 'tr');
    await expect.poll(() => page.evaluate(() => window.__glossy.xrPanel.text), { timeout: 15_000 }).toContain(hint);
    expect(await page.evaluate(() => window.__glossy.xrPanel.text)).toContain('1/1 · Yazın aile nerede yemek yerdi?');
  });
});
