// Optional browser QA. Uses an existing Playwright installation; no runtime dependencies.
// PLAYWRIGHT_MODULE = absolute path to playwright/index.mjs
// BROWSER_EXECUTABLE = optional path to a Chromium-family executable
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStaticServer } from './serve.mjs';

const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  : await import('playwright');
const artifactDir = new URL('../artifacts/', import.meta.url);
await mkdir(artifactDir, { recursive: true });
const server = createStaticServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
const results = [];
const errors = [];
const trackErrors = (page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
};
async function fillForm(page) {
  await page.locator('#name').fill('Тест');
  await page.locator('#contact-input').fill('test@example.com');
  await page.locator('#service').selectOption('both');
  await page.locator('#message').fill('Тестовая проверка формы.');
  await page.locator('#consent').check();
}

try {
  for (const width of [360, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    trackErrors(page);
    await page.goto(origin, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.locator('.project-card').count(), 3);
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const outside = [...document.querySelectorAll('main > section, .header, .expertise-strip, .footer')]
        .filter((element) => { const r = element.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; })
        .map((element) => element.id || element.className);
      const badLinks = [...document.querySelectorAll('a[href^="#"]')]
        .filter((link) => link.hash.length < 2 || !document.getElementById(link.hash.slice(1)))
        .map((link) => link.outerHTML);
      return { viewport: innerWidth, scrollWidth: root.scrollWidth, outside, badLinks };
    });
    assert.equal(layout.scrollWidth, width, `Overflow at ${width}`);
    assert.deepEqual(layout.outside, []);
    assert.deepEqual(layout.badLinks, []);
    if (width === 390 || width === 1440) {
      await page.screenshot({ path: fileURLToPath(new URL(`hero-${width}.png`, artifactDir)) });
      await page.screenshot({ path: fileURLToPath(new URL(`page-${width}.png`, artifactDir)), fullPage: true });
    }
    if (width < 900) {
      await page.locator('.menu-toggle').click();
      assert.equal(await page.locator('#mobile-menu').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#mobile-menu').isHidden(), true);
      assert.equal(await page.locator('.menu-toggle').evaluate((el) => el === document.activeElement), true);
      await page.locator('.menu-toggle').click();
      await page.locator('#mobile-menu a[href="#work"]').click();
      assert.equal(await page.locator('#mobile-menu').isHidden(), true);
      assert.equal(new URL(page.url()).hash, '#work');
    }
    await page.locator('#faq-list summary').first().click();
    assert.notEqual(await page.locator('#faq-list details').first().getAttribute('open'), null);
    await page.locator('#faq-list summary').first().press('Enter');
    assert.equal(await page.locator('#faq-list details').first().getAttribute('open'), null);
    await page.locator('[data-project="forma"]').click();
    assert.equal(await page.locator('#project-dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#project-dialog').isVisible(), false);
    await page.locator('[data-project="vector"]').click();
    await page.locator('#dialog-cta').click();
    assert.equal(await page.locator('#project-dialog').isVisible(), false);
    assert.equal(await page.locator('#service').inputValue(), 'both');
    await page.locator('.service-ads [data-service="ads"]').click();
    assert.equal(await page.locator('#service').inputValue(), 'ads');
    const fieldRect = await page.locator('#contact').boundingBox();
    assert.ok(fieldRect.y >= 76 && fieldRect.y < 200, 'Anchor is clear of the sticky header');
    let postRequests = 0;
    page.on('request', (request) => { if (request.method() === 'POST') postRequests++; });
    await page.locator('.form-submit').click();
    assert.match(await page.locator('#form-status').innerText(), /Проверьте/);
    assert.equal(await page.locator('#name').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#name').evaluate((el) => el === document.activeElement), true);
    await fillForm(page);
    await page.locator('.form-submit').click();
    assert.match(await page.locator('#form-status').innerText(), /заявка не отправлена/);
    assert.equal(postRequests, 0);
    assert.equal(await page.locator('#name').inputValue(), 'Тест');
    if (width === 390) await page.locator('#contact').screenshot({ path: fileURLToPath(new URL('form-390.png', artifactDir)) });
    results.push({ width, overflow: false, menu: width < 900 ? 'passed' : 'desktop', anchors: 'passed', faq: 'passed', dialogs: 'passed', serviceSelection: 'passed', formValidation: 'passed', demoNoNetwork: 'passed' });
    await page.close();
  }
  const dataSource = await readFile(new URL('../src/site-data.js', import.meta.url), 'utf8');
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  trackErrors(page);
  await page.route('**/src/site-data.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: dataSource.replace("privacyUrl: ''", "privacyUrl: '/privacy.pdf'").replace("endpoint: ''", "endpoint: '/api/leads'"),
  }));
  let requests = 0;
  let resolveFirst;
  const firstReceived = new Promise((resolve) => { resolveFirst = resolve; });
  let releaseFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const requestKeys = [];
  await page.route('**/api/leads', async (route) => {
    requests++;
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().postDataJSON().consent, true);
    requestKeys.push(route.request().headers()['idempotency-key']);
    assert.match(requestKeys.at(-1), /^[\da-f-]{36}$/i);
    if (requests === 1) {
      resolveFirst();
      await firstRelease;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
    }
  });
  await page.goto(origin);
  assert.equal(await page.locator('#demo-notice').isHidden(), true);
  await fillForm(page);
  await page.locator('.form-submit').click();
  await firstReceived;
  assert.equal(await page.locator('.form-submit').isDisabled(), true);
  assert.equal(await page.locator('#lead-form').getAttribute('aria-busy'), 'true');
  // Programmatic repeat submit must be ignored while the confirmed request is pending.
  await page.locator('#lead-form').evaluate((form) => form.requestSubmit());
  assert.equal(requests, 1);
  releaseFirst();
  await page.waitForFunction(() => document.querySelector('#form-status').dataset.state === 'success');
  assert.match(await page.locator('#form-status').innerText(), /Заявка принята/);
  assert.equal(await page.locator('#name').inputValue(), '');
  await fillForm(page);
  await page.locator('.form-submit').click();
  await page.waitForFunction(() => document.querySelector('#form-status').dataset.state === 'error');
  assert.match(await page.locator('#form-status').innerText(), /не подтвердил/);
  assert.equal(await page.locator('#name').inputValue(), 'Тест');
  assert.equal(await page.locator('.form-submit').isDisabled(), false);
  await page.locator('.form-submit').click();
  await page.waitForFunction(() => document.querySelector('#form-status').dataset.state === 'error');
  assert.equal(requestKeys[1], requestKeys[2], 'Retries retain the idempotency key');
  assert.notEqual(requestKeys[0], requestKeys[1], 'New leads get a new key after success');
  await page.locator('#message').fill('Изменённая тестовая задача');
  await page.locator('.form-submit').click();
  await page.waitForFunction(() => document.querySelector('#form-status').dataset.state === 'error');
  assert.notEqual(requestKeys[2], requestKeys[3], 'Edited payload gets a new key');
  results.push({ confirmedSuccess: 'passed (mock response)', failedConfirmation: 'passed', duplicateSubmission: 'passed', dataRetainedOnError: 'passed' });
  await page.close();

  const blocked = await browser.newPage();
  trackErrors(blocked);
  await blocked.route('**/src/site-data.js', (route) => route.fulfill({
    contentType: 'text/javascript', body: dataSource.replace("endpoint: ''", "endpoint: '/api/leads'"),
  }));
  await blocked.goto(origin);
  assert.equal(await blocked.locator('.form-submit').isDisabled(), true);
  assert.match(await blocked.locator('#demo-notice').innerText(), /документ/);
  results.push({ missingPrivacyBlocksSubmission: 'passed' });
  await blocked.close();

  const runtimeBlocked = await browser.newPage();
  trackErrors(runtimeBlocked);
  await runtimeBlocked.route('**/runtime-config.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `globalThis.LIMITLESS_RUNTIME = ${JSON.stringify({
      form: { endpoint: '/api/leads' }, privacyUrl: '', available: false, reason: 'https',
    })};`,
  }));
  await runtimeBlocked.goto(origin);
  assert.equal(await runtimeBlocked.locator('#name').isDisabled(), true);
  assert.equal(await runtimeBlocked.locator('#contact-input').isDisabled(), true);
  assert.match(await runtimeBlocked.locator('#demo-notice').innerText(), /защищённое соединение/);
  results.push({ runtimeConfiguration: 'passed', httpPersonalDataFieldsDisabled: 'passed', idempotentRetry: 'passed' });
  await runtimeBlocked.close();
  assert.deepEqual(errors, [], 'No browser errors');
  await writeFile(new URL('browser-report.json', artifactDir), JSON.stringify({ origin, results, browserErrors: errors }, null, 2));
  console.log(JSON.stringify({ origin, results, browserErrors: errors }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
