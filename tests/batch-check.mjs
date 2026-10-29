import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5175');
  await page.getByRole('status').filter({ hasText: '준비 완료' }).waitFor({ timeout: 60000 });
  const file = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  const sourceCsv = 'id,value,note\n001,A,\n002,B,""\n003,D,삭제\n004,=1+1,정상';
  const targetCsv = 'id,value,note\n001,C,""\n002,B,\n004,=1+1,정상\n005,E,추가';
  // Leave a completed single-file comparison in place before starting batch work.
  const single = page.locator('#single-workspace');
  await single.locator('input[type=file]').nth(0).setInputFiles(file('single-source.csv', sourceCsv));
  await single.locator('input[type=file]').nth(1).setInputFiles(file('single-target.csv', targetCsv));
  await single.getByLabel('1번 매핑 KEY').check();
  await single.getByRole('button', { name: 'KEY 검증', exact: true }).click();
  await single.getByRole('button', { name: '비교 실행', exact: true }).click();
  await single.locator('.summary').waitFor();
  const originalSummary = await single.locator('.summary').innerText();
  await page.getByRole('tab', { name: '일괄 검증', exact: true }).click();
  const batch = page.locator('#batch-workspace');
  const row = i => batch.locator('.batch-jobs tbody > tr').nth(i - 1);
  const mapping = batch.locator('.mapping');
  const dialog = batch.getByRole('dialog');
  async function closeSettings() {
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: '설정 완료', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
  }
  async function setup(i, source, target, name) {
    await closeSettings();
    if (i > 1) await batch.getByRole('button', { name: '+ 파일 쌍 추가', exact: true }).click();
    await batch.getByLabel(`${i}번 작업명`, { exact: true }).fill(name);
    await batch.getByLabel(`${i}번 Source 파일`, { exact: true }).setInputFiles(source);
    await batch.getByLabel(`${i}번 Target 파일`, { exact: true }).setInputFiles(target);
    await batch.getByLabel(`${i}번 비교 기준 설정`, { exact: true }).click();
    await mapping.getByLabel('1번 매핑 KEY', { exact: true }).check({ timeout: 60000 });
    assert.equal(await dialog.isVisible(), true);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1100);
    await batch.getByRole('button', { name: '+ 파일 쌍 추가', exact: true }).waitFor();
  }
  await setup(1, file('source.csv', sourceCsv), file('target.csv', targetCsv), '일반 비교');
  assert.equal(await batch.getByRole('button', { name: '일괄 검증 실행', exact: true }).isEnabled(), true);
  await setup(2, file('duplicate.csv', 'id,value\n1,A\n1,B'), file('unique.csv', 'id,value\n1,A'), '중복 KEY 오류');
  await setup(3, resolve('samples/mapping_rule_source.csv'), resolve('samples/mapping_rule_target.csv'), '변환 검증');
  await mapping.getByLabel('1번 비교 규칙', { exact: true }).selectOption('sql');
  await mapping.getByLabel('1번 SQL 변환식', { exact: true }).fill("'C' || SUBSTR(\"전표번호\", 2)");
  await mapping.getByLabel('2번 비교 규칙', { exact: true }).selectOption('sql');
  await mapping.getByLabel('2번 SQL 변환식', { exact: true }).fill('SUBSTR("계정원장번호", 1, 4) || \'C\' || SUBSTR("계정원장번호", 5)');
  await mapping.getByLabel('2번 변환 미리보기', { exact: true }).click();
  await mapping.getByLabel('2번 변환 미리보기 결과', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/batch-settings-modal.png', fullPage: false });
  // Reopening a configuration retains edits; single and batch keep their own state.
  await closeSettings();
  await batch.getByLabel('1번 비교 기준 설정', { exact: true }).click();
  await mapping.getByLabel('1번 매핑 KEY', { exact: true }).waitFor();
  assert.equal(await mapping.getByLabel('1번 매핑 KEY', { exact: true }).isChecked(), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '1번 비교 기준 설정');
  await batch.getByLabel('3번 비교 기준 설정', { exact: true }).click();
  assert.match(await mapping.getByLabel('2번 SQL 변환식', { exact: true }).inputValue(), /SUBSTR/);
  await closeSettings();
  await batch.getByRole('button', { name: '일괄 검증 실행', exact: true }).click();
  await batch.getByRole('button', { name: '결과 Excel 다운로드', exact: true }).waitFor();
  await batch.getByRole('status').filter({ hasText: '3개 작업 처리 완료' }).waitFor({ timeout: 60000 });
  assert.match(await row(1).innerText(), /완료/);
  assert.match(await row(2).innerText(), /실패/);
  assert.match(await row(3).innerText(), /완료/);
  const downloadWait = page.waitForEvent('download');
  await batch.getByRole('button', { name: '결과 Excel 다운로드', exact: true }).click();
  const download = await downloadWait;
  assert.match(download.suggestedFilename(), /\.xlsx$/);
  await download.saveAs('/tmp/batch-result.xlsx');
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile('/tmp/batch-result.xlsx');
  assert.deepEqual(book.worksheets.map(ws => ws.name).sort(), ['검증 기준', '검증 요약', '불일치 상세'].sort());
  const summary = book.getWorksheet('검증 요약');
  assert.deepEqual(summary.getRow(2).values.slice(4, 11), ['완료', 4, 4, 1, 2, 1, 1]);
  assert.equal(summary.getCell('D3').value, '실패');
  assert.equal(summary.getCell('E3').value, null);
  assert.match(summary.getCell('K3').value, /중복 1개/);
  assert.deepEqual(summary.getRow(4).values.slice(4, 11), ['완료', 5, 5, 2, 2, 1, 1]);
  const details = book.getWorksheet('불일치 상세');
  const rows = details.getRows(2, details.rowCount - 1).map(row => row.values.slice(1));
  assert.equal(rows.length, 19); // 9 ordinary + 10 transformed field differences.
  const change = rows.find(r => r[0] === '변환 검증' && r[5] === '계정원장번호' && r[1] === '변경');
  assert.equal(change[7], '87654321');
  assert.equal(change[9], '8765C4321');
  assert.equal(change[11], '8765X4321');
  assert.ok(rows.some(r => r[8] === 'NULL' && r[12] === '빈 문자열'));
  assert.ok(rows.some(r => r[8] === '빈 문자열' && r[12] === 'NULL'));
  assert.ok(rows.some(r => String(r[2]).includes('001')));
  assert.ok(!rows.some(r => r[0] === '중복 KEY 오류'));
  assert.match(book.getWorksheet('검증 기준').getCell('H7').value, /SUBSTR/);
  assert.equal(details.getRow(1).font.bold, true);
  await page.screenshot({ path: '/tmp/batch-workspace.png', fullPage: true });
  await page.getByRole('tab', { name: '단일 검증', exact: true }).click();
  assert.equal(await single.locator('.summary').innerText(), originalSummary);
  await single.locator('.result-table tbody tr').first().click();
  await single.locator('.detail-table').waitFor();
  assert.match(await single.locator('.detail-table').innerText(), /001/);
  await page.getByRole('tab', { name: '일괄 검증', exact: true }).click();
  await setup(4, file('long.csv', `id,value\n1,A\n2,${'X'.repeat(32768)}`), file('short.csv', 'id,value\n1,B\n2,Y'), '긴 값 오류');
  await setup(5, file('formula-source.csv', 'id,value\n0001,=1+1'), file('formula-target.csv', 'id,value\n0001,=2+2'), '문자열 보존');
  await closeSettings();
  await batch.getByRole('button', { name: '일괄 검증 실행', exact: true }).click();
  await batch.getByRole('status').filter({ hasText: '5개 작업 처리 완료' }).waitFor({ timeout: 60000 });
  const nextDownload = page.waitForEvent('download');
  await batch.getByRole('button', { name: '결과 Excel 다운로드', exact: true }).click();
  await (await nextDownload).saveAs('/tmp/batch-edge-result.xlsx');
  const edge = new ExcelJS.Workbook();
  await edge.xlsx.readFile('/tmp/batch-edge-result.xlsx');
  assert.match(edge.getWorksheet('검증 요약').getCell('K5').value, /32,767/);
  const edgeDetails = edge.getWorksheet('불일치 상세');
  assert.equal(edgeDetails.rowCount, 21);
  assert.equal(edgeDetails.getCell('H21').value, '=1+1');
  assert.equal(edgeDetails.getCell('L21').value, '=2+2');
  assert.equal(edgeDetails.getCell('H21').type, ExcelJS.ValueType.String);
  assert.match(edgeDetails.getCell('C21').value, /0001/);
  assert.ok(!edgeDetails.getColumn(1).values.includes('긴 값 오류'));
  // Request stop as soon as the first async job yields, independent of machine speed.
  await page.evaluate(() => {
    const root = document.querySelector('#batch-workspace');
    const observer = new MutationObserver(() => {
      const button = [...root.querySelectorAll('button')].find(b => b.textContent === '중단 요청');
      if (button) { observer.disconnect(); button.click(); }
    });
    observer.observe(root, { childList: true, subtree: true });
  });
  await batch.getByRole('button', { name: '일괄 검증 실행', exact: true }).click();
  await batch.getByRole('status').filter({ hasText: '중단 요청을 반영했습니다' }).waitFor({ timeout: 60000 });
  assert.match(await row(1).innerText(), /완료/);
  assert.match(await row(2).innerText(), /중단/);
  const stoppedDownload = page.waitForEvent('download');
  await batch.getByRole('button', { name: '결과 Excel 다운로드', exact: true }).click();
  await (await stoppedDownload).saveAs('/tmp/batch-stopped-result.xlsx');
  const stopped = new ExcelJS.Workbook();
  await stopped.xlsx.readFile('/tmp/batch-stopped-result.xlsx');
  assert.equal(stopped.getWorksheet('검증 요약').getCell('D3').value, '중단');
  assert.equal(stopped.getWorksheet('검증 요약').rowCount, 6);
  assert.equal(stopped.getWorksheet('불일치 상세').rowCount, 10);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log('PASS: 5개 작업 순차 처리, 오류 후 계속 실행, SQL 변환, Excel 재열기·건수·불일치·기준·문자열 확인, 긴 셀 실패 시 부분 기록 제거, 중단 내역, 탭 상태 보존, 외부 요청 0건');
} finally { await browser.close(); }
