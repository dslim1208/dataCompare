// Manual performance check: SOURCE/TARGET CSV paths, first column used as KEY.
// Usage: SOURCE=samples/big_source.csv TARGET=samples/big_target.csv PLAYWRIGHT_MODULE=... npm run benchmark
// Optional RULES=exact,trim,number,date,... sets the compare rule of mapping rows in order.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); }
const files = { source: resolve(process.env.SOURCE || 'samples/big_source.csv'), target: resolve(process.env.TARGET || 'samples/big_target.csv') };
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:4173');
  await page.getByRole('status').filter({ hasText: '준비 완료' }).waitFor({ timeout: 60000 });
  // Resolves when the app status leaves "처리 중" again, so timing covers the whole DuckDB call.
  const idle = () => page.evaluate(() => new Promise(done => {
    const status = document.querySelector('.status');
    let busy = false;
    new MutationObserver((_, observer) => {
      if (status.textContent.includes('처리 중')) busy = true;
      else if (busy) { observer.disconnect(); done(); }
    }).observe(status, { childList: true, subtree: true, characterData: true });
  }));
  const time = async (label, action, finished = idle) => {
    const waiting = finished();
    const started = performance.now();
    await action();
    const result = await waiting;
    console.log(`${label}: ${((performance.now() - started) / 1000).toFixed(2)}초`);
    return result;
  };
  const panels = page.locator('.panel');
  const results = page.locator('.results');
  for (const [index, side] of ['source', 'target'].entries()) {
    console.log(`${side}: ${files[side]} (${((await stat(files[side])).size / 1048576).toFixed(1)} MB)`);
    await time(`${side} 로딩`, () => panels.nth(index).locator('input[type=file]').setInputFiles(files[side]));
  }
  const mapping = page.locator('.mapping');
  await mapping.getByLabel('1번 매핑 KEY').check();
  const rules = (process.env.RULES || '').split(',').filter(Boolean);
  for (const [index, rule] of rules.entries()) await mapping.getByLabel(`${index + 1}번 비교 규칙`).selectOption(rule);
  if (rules.length) console.log(`비교 규칙: ${rules.join(', ')}`);
  await time('KEY 검증', () => mapping.getByRole('button', { name: 'KEY 검증' }).click());
  if (!await mapping.locator('.ok').count()) throw new Error('KEY 검증 실패: 첫 번째 매핑 컬럼이 KEY로 적합하지 않습니다.');
  await time('비교 실행', () => page.getByRole('button', { name: '비교 실행' }).click());
  await results.locator('.result-table tbody tr').first().waitFor({ timeout: 120000 });
  console.log(`요약: ${(await page.locator('.compare .summary').innerText()).replace(/\n/g, ' ')}`);
  if (await results.getByRole('button', { name: '다음' }).isEnabled()) await time('다음 페이지', () => results.getByRole('button', { name: '다음' }).click());
  const modified = results.getByRole('button', { name: /^MODIFIED/ });
  if (await modified.isEnabled() && !(await modified.innerText()).includes('(0)')) {
    await time('MODIFIED 필터', () => modified.click());
    await time('상세 비교', () => results.locator('.result-table tbody tr').first().click());
  }
  for (const button of await page.locator('.downloads button:enabled').all()) {
    const label = (await button.innerText()).replace(/ \(.*/, '');
    const file = await time(`다운로드 ${label}`, () => button.click(), () => page.waitForEvent('download', { timeout: 600000 }));
    console.log(`  크기: ${((await stat(await file.path())).size / 1048576).toFixed(1)} MB`);
  }
  const heap = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  console.log(`메인 스레드 JS 힙: ${heap ?? '측정 불가'} MB · Chrome 전체 메모리는 작업 관리자에서 확인하세요.`);
} finally { await browser.close(); }
