import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  const url = process.env.TEST_URL || 'http://127.0.0.1:5175';
  const single = page.locator('#single-workspace');
  const mapping = single.locator('.mapping');
  const downloads = single.locator('.downloads');
  async function open() {
    await page.goto(url);
    await single.getByRole('status').filter({ hasText: '준비 완료' }).waitFor({ timeout: 60000 });
  }
  async function files(source = resolve('samples/mapping_rule_source.csv')) {
    await single.getByLabel('source CSV 파일', { exact: true }).setInputFiles(source);
    await single.locator('.source .metrics').waitFor();
    await single.getByLabel('target CSV 파일', { exact: true }).setInputFiles(resolve('samples/mapping_rule_target.csv'));
    await mapping.waitFor();
  }
  async function previewAll(panel) {
    for (const i of [1, 2]) {
      await panel.getByLabel(`${i}번 변환 미리보기`, { exact: true }).click();
      await panel.getByLabel(`${i}번 변환 미리보기 결과`, { exact: true }).waitFor();
    }
  }
  async function validate(panel) {
    await panel.getByRole('button', { name: 'KEY 검증', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: /KEY 검증 (통과|실패)/ }).waitFor();
  }
  async function compare() {
    await single.getByRole('button', { name: '비교 실행', exact: true }).click();
    await single.locator('.summary').waitFor();
    return Promise.all(['MATCH', 'MODIFIED', 'ADDED', 'DELETED'].map(status => single.locator(`[data-status=${status}] strong`).innerText()));
  }
  const jsonFile = text => ({ name: 'template.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  async function importTemplate(panel, value) {
    await panel.getByLabel('비교 기준 템플릿 파일', { exact: true }).setInputFiles(jsonFile(typeof value === 'string' ? value : JSON.stringify(value)));
  }
  await open(); await files();
  assert.equal(await mapping.locator('.mapping-template-actions').getByRole('button', { name: '템플릿 저장', exact: true }).isDisabled(), true);
  assert.equal(await mapping.locator('.mapping-grid-toolbar input[type=file]').count(), 1);
  await mapping.getByLabel('1번 매핑 KEY', { exact: true }).check();
  const expressions = ["'C' || SUBSTR(\"전표번호\", 2)", 'SUBSTR("계정원장번호", 1, 4) || \'C\' || SUBSTR("계정원장번호", 5)'];
  for (const i of [1, 2]) {
    await mapping.getByLabel(`${i}번 비교 규칙`, { exact: true }).selectOption('sql');
    await mapping.getByLabel(`${i}번 SQL 변환식`, { exact: true }).fill(expressions[i - 1]);
  }
  await mapping.getByLabel('3번 비교 규칙', { exact: true }).selectOption('number');
  await mapping.getByLabel('4번 비교 규칙', { exact: true }).selectOption('exact');
  await previewAll(mapping); await validate(mapping);
  assert.deepEqual(await compare(), ['2', '2', '1', '1']);
  assert.equal(await downloads.locator('input[type=text]').count(), 0);
  let saved = 0;
  page.on('download', () => saved++);
  page.once('dialog', dialog => dialog.dismiss());
  await mapping.getByRole('button', { name: '템플릿 저장', exact: true }).click();
  assert.equal(saved, 0);
  page.once('dialog', dialog => dialog.accept('전표:검증'));
  const downloading = page.waitForEvent('download');
  await mapping.getByRole('button', { name: '템플릿 저장', exact: true }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), '전표_검증.json');
  await download.saveAs('/tmp/comparison-template.json');
  const text = await readFile('/tmp/comparison-template.json', 'utf8');
  const template = JSON.parse(text);
  assert.deepEqual(Object.keys(template).sort(), ['name', 'pairs', 'type', 'version']);
  assert.deepEqual(template.pairs.map(pair => pair.rule), ['sql', 'sql', 'number', 'exact']);
  assert.equal(template.pairs[0].key, true);
  assert.equal(template.pairs[1].expression, expressions[1]);
  assert.ok(!text.includes('12345678'));
  assert.equal(await downloads.getByRole('button', { name: '템플릿 저장', exact: true }).count(), 0);
  await mapping.screenshot({ path: '/tmp/template-controls.png' });
  // Reopen the application so nothing can be restored from component memory.
  await open(); await files();
  await importTemplate(mapping, '\uFEFF' + text);
  await mapping.getByRole('status').filter({ hasText: '템플릿을 적용했습니다' }).waitFor();
  assert.equal(await mapping.getByLabel('비교 기준 템플릿 이름', { exact: true }).count(), 0);
  assert.equal(await mapping.getByLabel('1번 매핑 KEY', { exact: true }).isChecked(), true);
  assert.equal(await mapping.getByLabel('2번 SQL 변환식', { exact: true }).inputValue(), expressions[1]);
  assert.equal(await single.locator('.compare').count(), 0);
  assert.equal(await mapping.getByRole('button', { name: 'KEY 검증', exact: true }).isDisabled(), true);
  await previewAll(mapping); await validate(mapping);
  assert.deepEqual(await compare(), ['2', '2', '1', '1']);
  page.once('dialog', async dialog => { assert.equal(dialog.defaultValue(), '전표:검증.json'); await dialog.dismiss(); });
  await mapping.getByRole('button', { name: '템플릿 저장', exact: true }).click();
  const summary = await single.locator('.summary').innerText();
  // Invalid imports leave both settings and existing comparison results intact.
  for (const [value, expected] of [
    ['{', /JSON 형식/],
    [{ ...template, version: 2 }, /버전/],
    [{ ...template, pairs: [{ ...template.pairs[0], source: '없는컬럼' }] }, /Source에 없는 컬럼/],
    [{ ...template, pairs: [{ ...template.pairs[0], target: '없는컬럼' }] }, /Target에 없는 컬럼/],
    [{ ...template, pairs: [{ ...template.pairs[0], key: 'true' }] }, /KEY/],
    [{ ...template, pairs: [{ ...template.pairs[0], rule: 'unknown' }] }, /비교 규칙/],
    [{ ...template, pairs: [template.pairs[0], template.pairs[0]] }, /중복 매핑/],
    [{ ...template, pairs: [{ ...template.pairs[0], key: false }] }, /KEY 컬럼/],
    [{ ...template, pairs: [{ ...template.pairs[0], expression: '' }] }, /SQL 변환식/],
    ['X'.repeat(1024 * 1024 + 1), /1MB/],
  ]) {
    await importTemplate(mapping, value);
    await mapping.getByRole('alert').filter({ hasText: expected }).waitFor();
    assert.equal(await single.locator('.summary').innerText(), summary);
    assert.equal(await mapping.getByLabel('2번 SQL 변환식', { exact: true }).inputValue(), expressions[1]);
  }
  await importTemplate(mapping, template);
  await mapping.getByRole('status').filter({ hasText: '템플릿을 적용했습니다' }).waitFor();
  assert.equal(await single.locator('.compare').count(), 0);
  assert.equal(await mapping.getByRole('status').filter({ hasText: 'KEY 검증 통과' }).count(), 0);
  // A fresh file with duplicate transformed KEYs must fail, even with a previously valid template.
  const original = await readFile(resolve('samples/mapping_rule_source.csv'), 'utf8');
  await files({ name: 'duplicate.csv', mimeType: 'text/csv', buffer: Buffer.from(original + '\nZ001,12345678,100,정상\n') });
  await importTemplate(mapping, template); await previewAll(mapping); await validate(mapping);
  assert.match(await mapping.getByRole('status').filter({ hasText: 'KEY 검증 실패' }).innerText(), /실패/);
  assert.equal(await single.locator('.compare').count(), 0);
  // The same file also works in the batch settings modal and survives closing/reopening.
  await page.getByRole('tab', { name: '일괄 검증', exact: true }).click();
  const batch = page.locator('#batch-workspace');
  await batch.getByLabel('1번 Source 파일', { exact: true }).setInputFiles(resolve('samples/mapping_rule_source.csv'));
  await batch.getByLabel('1번 Target 파일', { exact: true }).setInputFiles(resolve('samples/mapping_rule_target.csv'));
  await batch.getByLabel('1번 비교 기준 설정', { exact: true }).click();
  const dialog = batch.getByRole('dialog');
  const batchMapping = dialog.locator('.mapping');
  await batchMapping.waitFor({ timeout: 60000 });
  await importTemplate(batchMapping, template);
  await batchMapping.getByRole('status').filter({ hasText: '템플릿을 적용했습니다' }).waitFor();
  await page.screenshot({ path: '/tmp/comparison-template-modal.png', fullPage: false });
  await dialog.getByRole('button', { name: '설정 완료', exact: true }).click();
  await batch.getByLabel('1번 비교 기준 설정', { exact: true }).click();
  assert.equal(await batchMapping.getByLabel('2번 SQL 변환식', { exact: true }).inputValue(), expressions[1]);
  const batchDownload = page.waitForEvent('download');
  page.once('dialog', dialog => dialog.accept(dialog.defaultValue()));
  await batchMapping.getByRole('button', { name: '템플릿 저장', exact: true }).click();
  const batchTemplateFile = await batchDownload;
  assert.equal(batchTemplateFile.suggestedFilename(), '전표_검증.json');
  assert.deepEqual(JSON.parse(await readFile(await batchTemplateFile.path(), 'utf8')), template);
  await dialog.getByRole('button', { name: '설정 완료', exact: true }).click();
  await batch.getByRole('button', { name: '일괄 검증 실행', exact: true }).click();
  await batch.getByRole('status').filter({ hasText: '1개 작업 처리 완료 · 실패 0개' }).waitFor({ timeout: 60000 });
  assert.match(await batch.locator('.batch-jobs tbody').innerText(), /일치 2 · 변경 2/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('PASS: 템플릿 다운로드·새 세션 복원·동일 결과, 잘못된 파일/버전/규칙/누락 컬럼 거부와 기존 결과 보존, 재검증 강제·새 데이터 중복 검출, 일괄 모달 적용·재열기·실행, 외부 요청 0건');
} finally { await browser.close(); }
