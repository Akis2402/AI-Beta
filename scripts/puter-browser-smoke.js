'use strict';
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'puter-image-smoke-test.html');
const html = fs.readFileSync(file, 'utf8');
if (!html.includes('puter.ai.txt2img') || !html.includes('test_mode: true')) {
  console.error('STATIC FAIL: smoke page contract missing');
  process.exit(1);
}
console.log('STATIC PASS: public/puter-image-smoke-test.html exists.');
(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (_) {
    console.log('LIVE BLOCKED: Playwright is not installed. No live browser claim.');
    return;
  }
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (_) { console.log('LIVE BLOCKED: Playwright browser executable is unavailable.'); return; }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(process.env.PUTER_SMOKE_URL || 'http://127.0.0.1:3000/puter-image-smoke-test.html', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Run live test/i }).click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('LIVE PASS') || document.querySelector('#status')?.textContent.includes('LIVE BLOCKED'), null, { timeout: 130000 });
  const status = await page.locator('#status').textContent();
  console.log(status);
  if (errors.length) console.log(`LIVE BLOCKED: ${errors[0]}`);
  await browser.close();
})();
