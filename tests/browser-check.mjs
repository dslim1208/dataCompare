import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); }
const pass = name => console.log(`✓ ${name}`);
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const external = [];
  const errors = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5173');
  await page.getByRole('status').filter({ hasText: '준비 완료' }).waitFor({ timeout: 60000 });
  pass('DuckDB 로컬 초기화');
  const panels = page.locator('.panel');
  const source = panels.nth(0);
  const target = panels.nth(1);
  await source.locator('input[type=file]').setInputFiles(resolve('tests/fixtures/source.csv'));
  await source.locator('tbody tr').nth(3).waitFor({ state: 'attached' });
  assert.equal(await source.locator('.preview').getAttribute('open'), null);
  await source.locator('.preview > summary').click();
  assert.equal(await source.locator('.preview .table-wrap').isVisible(), true);
  assert.equal(await source.locator('tbody tr').count(), 4);
  const values = await source.locator('tbody tr').first().locator('td').allTextContents();
  assert.deepEqual(values, ['001', '홍길동', '01000', 'NULL']);
  assert.equal(await source.locator('tbody tr').nth(1).locator('td').nth(3).innerText(), '빈 문자열');
  assert.match(await source.locator('tbody tr').nth(3).innerText(), /줄바꿈\n포함/);
  pass('한글 UTF-8, 원본 문자열 보존(001/01000), NULL·빈 문자열 구분, 인용 줄바꿈');
  await target.locator('input[type=file]').setInputFiles(resolve('tests/fixtures/target.csv'));
  await target.locator('tbody tr').waitFor({ state: 'attached' });
  assert.deepEqual(await target.locator('th').allTextContents(), ['NOTE', 'AMOUNT', 'USER_NAME', 'USER_NO']);
  pass('컬럼 순서가 다른 파일 로딩');
  await source.locator('input[type=checkbox]').uncheck();
  await page.getByRole('status').filter({ hasText: '준비 완료' }).waitFor();
  assert.equal(await source.locator('tbody tr').count(), 5);
  await source.locator('input[type=file]').setInputFiles(resolve('tests/fixtures/no-header.csv'));
  await source.locator('tbody tr').nth(1).waitFor({ state: 'attached' });
  assert.equal(await source.locator('tbody tr').count(), 2);
  await source.locator('input[type=checkbox]').check();
  await page.getByRole('status').filter({ hasText: '준비 완료' }).waitFor();
  pass('헤더 유무 전환과 재로딩');
  await source.locator('input[type=file]').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) });
  await source.getByRole('alert').filter({ hasText: '빈 파일' }).waitFor();
  assert.equal(await source.locator('tbody tr').count(), 0);
  await source.locator('input[type=file]').setInputFiles(resolve('tests/fixtures/invalid.csv'));
  await source.getByRole('alert').waitFor();
  assert.equal(await source.locator('tbody tr').count(), 0);
  pass('빈 파일·잘못된 CSV 오류 표시');
  const large = 'id,name\n' + Array.from({ length: 100000 }, (_, i) => `${i},사용자${i}`).join('\n');
  await source.locator('input[type=file]').setInputFiles({ name: 'large.csv', mimeType: 'text/csv', buffer: Buffer.from(large) });
  await source.locator('.metrics strong').filter({ hasText: '100,000' }).waitFor({ timeout: 60000 });
  assert.equal(await source.locator('tbody tr').count(), 20);
  assert.equal(await target.locator('tbody tr').count(), 1);
  pass('10만 행 로딩, 미리보기 20행 제한, Source/Target 독립');
  // Task 3: mapping and KEY validation
  const mapping = page.locator('.mapping');
  const fixture = name => resolve(`tests/fixtures/${name}.csv`);
  const validate = async () => {
    await mapping.getByRole('button', { name: 'KEY 검증' }).click();
    await mapping.getByRole('status').waitFor();
    return mapping.getByRole('status').innerText();
  };
  const compare = page.locator('.compare');
  const runCompare = async () => {
    await compare.getByRole('button', { name: '비교 실행' }).click();
    await compare.locator('.summary').waitFor({ timeout: 60000 });
    const result = {};
    for (const status of ['SOURCE', 'TARGET', 'MATCH', 'MODIFIED', 'ADDED', 'DELETED']) result[status] = await compare.locator(`[data-status=${status}] strong`).innerText();
    return result;
  };
  await source.locator('input[type=file]').setInputFiles(fixture('basic_source'));
  await target.locator('input[type=file]').setInputFiles(fixture('basic_target'));
  await mapping.waitFor();
  assert.equal(await mapping.locator('tbody tr').count(), 4);
  assert.match(await mapping.innerText(), /Source: USER_ID \/ Target: USER_NO/);
  assert.equal(await mapping.getByRole('button', { name: 'KEY 검증' }).isDisabled(), true);
  await mapping.getByRole('button', { name: '+ 매핑 추가' }).click();
  assert.equal(await mapping.getByLabel('5번 Source 컬럼').inputValue(), 'USER_ID');
  assert.equal(await mapping.getByLabel('5번 Target 컬럼').inputValue(), 'USER_NO');
  await mapping.getByLabel('5번 매핑 KEY').check();
  assert.match(await validate(), /KEY 검증 통과/);
  // Task 4: 1001 MATCH, 1002/1003 NULL vs empty and 1005 01000 vs 1000 MODIFIED, 1004 DELETED, 1006 ADDED
  assert.deepEqual(await runCompare(), { SOURCE: '5', TARGET: '5', MATCH: '1', MODIFIED: '3', ADDED: '1', DELETED: '1' });
  pass('단일 KEY 비교(컬럼명이 다른 KEY 매핑, NULL vs 빈 문자열, 숫자 형식 차이)');
  // Task 6: downloads keep NULL (empty) and empty string ("") apart, with a UTF-8 BOM for Excel
  const download = async name => {
    const [file] = await Promise.all([page.waitForEvent('download'), compare.locator('.downloads').getByRole('button', { name: new RegExp(`^${name}`) }).click()]);
    assert.match(file.suggestedFilename(), /^dataCompare_(ALL|ADDED|DELETED|MODIFIED)_\d{8}_\d{6}\.csv$/);
    const text = (await readFile(await file.path())).toString('utf8');
    assert.ok(text.startsWith('\ufeff'));
    return text.slice(1);
  };
  assert.equal(await download('전체 결과'), [
    'STATUS,USER_ID,CHANGED_COLUMNS,USER_NAME (SOURCE),USER_NAME (TARGET),AMOUNT (SOURCE),AMOUNT (TARGET),STATUS (SOURCE),STATUS (TARGET),MEMO (SOURCE),MEMO (TARGET)',
    'MATCH,1001,,홍길동,홍길동,10000,10000,Y,Y,일반,일반',
    'MODIFIED,1002,MEMO,김철수,김철수,20000,20000,Y,Y,,""',
    'MODIFIED,1003,MEMO,이영희,이영희,30000,30000,N,N,"",',
    'DELETED,1004,,박민수,,40000,,Y,,삭제 대상,',
    'MODIFIED,1005,AMOUNT,최지우,최지우,01000,1000,Y,Y,"줄바꿈\n포함","줄바꿈\n포함"',
    'ADDED,1006,,,정우성,,60000,,Y,,추가 대상',
    ''].join('\n'));
  assert.equal(await download('추가 데이터'), 'USER_NO,MEMO,STATUS,AMOUNT,USER_NAME\n1006,추가 대상,Y,60000,정우성\n');
  assert.equal(await download('삭제 데이터'), 'USER_ID,USER_NAME,AMOUNT,STATUS,MEMO\n1004,박민수,40000,Y,삭제 대상\n');
  assert.equal(await download('변경 데이터'), 'USER_ID,COLUMN_NAME,SOURCE_VALUE,TARGET_VALUE\n1002,MEMO,,""\n1003,MEMO,"",\n1005,AMOUNT,01000,1000\n');
  pass('결과 CSV 다운로드 4종(NULL/빈 문자열 구분, BOM, 파일명)');
  // Task 5: list, filter, detail
  const results = compare.locator('.results');
  const resultRows = results.locator('.result-table tbody tr');
  const filterButton = name => name === '전체' ? results.getByRole('button', { name: /^전체 결과 \(/ }) : results.locator(`.result-card[data-status="${name}"]`);
  await resultRows.nth(5).waitFor();
  assert.deepEqual(await resultRows.locator('td:nth-child(2)').allTextContents(), ['1001', '1002', '1003', '1004', '1005', '1006']);
  assert.equal(await filterButton('전체').getAttribute('aria-label'), '전체 결과 (6)');
  await filterButton('MODIFIED').click();
  await resultRows.nth(3).waitFor({ state: 'detached' });
  assert.deepEqual(await resultRows.locator('td:nth-child(3)').allTextContents(), ['MEMO', 'MEMO', 'AMOUNT']);
  await resultRows.nth(2).click();
  const changedRows = results.locator('.detail-table tr.changed');
  await changedRows.first().waitFor();
  assert.equal(await changedRows.count(), 1);
  assert.deepEqual(await changedRows.first().locator('td').allTextContents(), ['AMOUNT', '01000', '1000']);
  assert.match(await results.locator('.detail-table').innerText(), /USER_ID \/ USER_NOKEY\t1005\t1005/);
  await resultRows.nth(0).click();
  await changedRows.first().filter({ hasText: 'MEMO' }).waitFor();
  assert.deepEqual(await changedRows.first().locator('td').allTextContents(), ['MEMO', 'NULL', '빈 문자열']);
  await filterButton('ADDED').click();
  await resultRows.nth(1).waitFor({ state: 'detached' });
  await resultRows.first().click();
  await results.locator('.detail-table').waitFor();
  assert.match(await results.locator('.detail-table').innerText(), /USER_ID \/ USER_NOKEY\t없음\t1006/);
  pass('결과 목록·상태 필터·상세 비교·변경 컬럼 강조');
  assert.match(await page.locator('.steps [aria-current=step]').innerText(), /03\s*비교 및 결과/);
  const listBox = await results.locator('.result-list').boundingBox();
  const detailBox = await results.locator('.result-detail').boundingBox();
  assert.ok(detailBox.x > listBox.x + listBox.width, '데스크톱 목록·상세 좌우 배치');
  await results.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/datacompare-ui-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '모바일 가로 넘침 없음');
  const mobileList = await results.locator('.result-list').boundingBox();
  const mobileDetail = await results.locator('.result-detail').boundingBox();
  assert.ok(mobileDetail.y >= mobileList.y + mobileList.height, '모바일 목록·상세 세로 배치');
  await page.screenshot({ path: '/tmp/datacompare-ui-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass('접힌 미리보기 펼치기, 진행 단계, 데스크톱 좌우 배치, 모바일 세로 배치·가로 넘침 없음');
  await mapping.getByLabel('5번 Target 컬럼').selectOption('USER_NAME');
  assert.equal(await compare.count(), 0);
  assert.match(await mapping.innerText(), /Target 컬럼이 중복 매핑되었습니다: USER_NAME/);
  pass('중복 매핑 차단');
  await source.locator('input[type=file]').setInputFiles(fixture('duplicate_key'));
  await mapping.getByRole('button', { name: '+ 매핑 추가' }).click();
  await mapping.getByLabel('3번 매핑 KEY').check();
  assert.match(await validate(), /KEY 검증 실패/);
  assert.match(await mapping.innerText(), /중복 KEY: 1개 \(2행\)/);
  assert.match(await mapping.innerText(), /1002 · 2건/);
  pass('중복 KEY 검출');
  await source.locator('input[type=file]').setInputFiles(fixture('null_key'));
  await mapping.getByRole('button', { name: '+ 매핑 추가' }).click();
  await mapping.getByLabel('3번 매핑 KEY').check();
  assert.match(await validate(), /KEY 검증 실패/);
  assert.match(await mapping.innerText(), /NULL KEY 행: 1/);
  assert.match(await mapping.innerText(), /빈 문자열 KEY 행: 1/);
  pass('NULL KEY·빈 문자열 KEY 검출');
  await source.locator('input[type=file]').setInputFiles(fixture('invalid'));
  await source.getByRole('alert').waitFor();
  assert.equal(await mapping.count(), 0);
  pass('로딩 실패 시 매핑 숨김');
  await source.locator('input[type=file]').setInputFiles(fixture('composite_source'));
  await target.locator('input[type=file]').setInputFiles(fixture('composite_target'));
  await mapping.waitFor();
  await mapping.getByLabel('1번 매핑 KEY').check();
  await mapping.getByLabel('2번 매핑 KEY').check();
  assert.match(await validate(), /KEY 검증 통과/);
  assert.deepEqual(await runCompare(), { SOURCE: '4', TARGET: '4', MATCH: '2', MODIFIED: '1', ADDED: '1', DELETED: '1' });
  pass('복합 KEY 비교');
  // File removal clears the panel and hides the mapping until a file is chosen again
  assert.match(await source.locator('.picker').innerText(), /composite_source\.csv/);
  await source.getByRole('button', { name: 'source 파일 제거' }).click();
  await source.getByText('선택된 파일 없음').waitFor();
  assert.equal(await source.getByRole('button', { name: 'source 파일 제거' }).count(), 0);
  assert.equal(await source.locator('tbody tr').count(), 0);
  assert.equal(await mapping.count(), 0);
  await source.locator('input[type=file]').setInputFiles(fixture('composite_source'));
  await mapping.waitFor();
  pass('파일 제거');
  // SQL transform: filter, rename and cast; result columns become VARCHAR and comparison uses the result
  await source.locator('input[type=file]').setInputFiles(fixture('basic_source'));
  await target.locator('input[type=file]').setInputFiles(fixture('basic_target'));
  await mapping.waitFor();
  const sql = source.locator('.sql');
  await sql.locator('summary').click();
  await sql.getByLabel('source 가공 SQL').fill("SELECT USER_ID AS USER_NO, USER_NAME, CAST(AMOUNT AS INTEGER) AS AMOUNT FROM source WHERE STATUS = 'Y';");
  await sql.getByRole('button', { name: 'SQL 적용' }).click();
  await sql.getByRole('button', { name: '원본으로 되돌리기' }).waitFor();
  assert.deepEqual(await source.locator('th').allTextContents(), ['USER_NO', 'USER_NAME', 'AMOUNT']);
  assert.equal(await source.locator('.metrics strong').first().innerText(), '4');
  assert.equal(await mapping.getByLabel('1번 Source 컬럼').inputValue(), 'USER_NO');
  await mapping.getByLabel('1번 매핑 KEY').check();
  assert.match(await validate(), /KEY 검증 통과/);
  // 1005 becomes 1000 after the INTEGER cast and matches; 1003 (STATUS N) is filtered out so the target row is ADDED
  assert.deepEqual(await runCompare(), { SOURCE: '4', TARGET: '5', MATCH: '3', MODIFIED: '0', ADDED: '2', DELETED: '1' });
  // Re-running refers to the original CSV again, a second statement is rejected and the current table is kept
  await sql.getByLabel('source 가공 SQL').fill('SELECT * FROM source; DROP TABLE target');
  await sql.getByRole('button', { name: 'SQL 적용' }).click();
  await source.getByRole('alert').waitFor();
  assert.equal(await source.locator('.metrics strong').first().innerText(), '4');
  assert.equal(await compare.count(), 1);
  await sql.getByLabel('source 가공 SQL').fill("SELECT * FROM source WHERE STATUS = 'N'");
  await sql.getByRole('button', { name: 'SQL 적용' }).click();
  await source.locator('.metrics strong').first().filter({ hasText: /^1$/ }).waitFor();
  assert.equal(await compare.count(), 0);
  await sql.getByRole('button', { name: '원본으로 되돌리기' }).click();
  await source.locator('.metrics strong').first().filter({ hasText: /^5$/ }).waitFor();
  assert.deepEqual(await source.locator('th').allTextContents(), ['USER_ID', 'USER_NAME', 'AMOUNT', 'STATUS', 'MEMO']);
  assert.equal(await target.locator('.metrics strong').first().innerText(), '5');
  pass('SQL 가공(필터·컬럼명 변경·형변환 후 비교, 원본 기준 재실행, 다중 문장 차단, 원본 복원)');
  // Compare rules: normalization applies to comparison only; shown and downloaded values stay original
  await source.locator('input[type=file]').setInputFiles(fixture('format_source'));
  await target.locator('input[type=file]').setInputFiles(fixture('format_target'));
  await mapping.waitFor();
  await mapping.getByLabel('1번 매핑 KEY').check();
  // Default rule is trim; switch every row to exact to check the strict comparison
  for (const index of [1, 2, 3, 4]) {
    assert.equal(await mapping.getByLabel(`${index}번 비교 규칙`).inputValue(), 'trim');
    await mapping.getByLabel(`${index}번 비교 규칙`).selectOption('exact');
  }
  assert.match(await validate(), /KEY 검증 통과/);
  // Exact: "1 " is a different key, every format difference is MODIFIED, only row 4 matches
  assert.deepEqual(await runCompare(), { SOURCE: '7', TARGET: '7', MATCH: '1', MODIFIED: '5', ADDED: '1', DELETED: '1' });
  await mapping.getByLabel('1번 비교 규칙').selectOption('trim');
  await mapping.getByLabel('2번 비교 규칙').selectOption('date');
  await mapping.getByLabel('3번 비교 규칙').selectOption('number');
  await mapping.getByLabel('4번 비교 규칙').selectOption('trim');
  assert.equal(await compare.count(), 0);
  assert.match(await validate(), /KEY 검증 통과/);
  // Rules: rows 1-4 match (abc falls back to text); row 5 differs in DATE and in AMOUNT (NULL vs empty);
  // row 6 is over 15 digits so it stays a text comparison; row 7 keeps tiny decimals apart
  assert.deepEqual(await runCompare(), { SOURCE: '7', TARGET: '7', MATCH: '4', MODIFIED: '3', ADDED: '0', DELETED: '0' });
  assert.equal(await download('변경 데이터'), 'ID,COLUMN_NAME,SOURCE_VALUE,TARGET_VALUE\n5,DATE,2026-10-05,2026-10-06\n5,AMOUNT,,""\n6,AMOUNT,"1,234,567,890,123,456",1234567890123456\n7,AMOUNT,0.000001,0.000002\n');
  await filterButton('MATCH').click();
  await resultRows.nth(4).waitFor({ state: 'detached' });
  await resultRows.first().click();
  await results.locator('.detail-table').waitFor();
  assert.match(await results.locator('.detail-table').innerText(), /DATE\t2026-10-01\t2026\.10\.01/);
  assert.equal(await results.locator('.detail-table tr.changed').count(), 0);
  pass('비교 규칙(공백·숫자 콤마·날짜 구분자 무시, 변환 실패 시 원본 비교, 원본 값 표시)');
  // Number/date sample: default trim alone, then number/date rules (case per row in CASE_NOTE)
  await source.locator('input[type=file]').setInputFiles(resolve('samples/number_date_source.csv'));
  await target.locator('input[type=file]').setInputFiles(resolve('samples/number_date_target.csv'));
  await mapping.waitFor();
  assert.match(await mapping.innerText(), /Source: CASE_NOTE \/ Target: 없음/);
  await mapping.getByLabel('1번 매핑 KEY').check();
  assert.match(await validate(), /KEY 검증 통과/);
  // Trim only: 5 (spaces), 13 (leading space), 19 (trailing space) and 20 (KEY " 20") match
  assert.deepEqual(await runCompare(), { SOURCE: '26', TARGET: '26', MATCH: '4', MODIFIED: '22', ADDED: '0', DELETED: '0' });
  await mapping.getByLabel('2번 비교 규칙').selectOption('number');
  await mapping.getByLabel('3번 비교 규칙').selectOption('date');
  assert.match(await validate(), /KEY 검증 통과/);
  // Date rule ignores the time (17); UPDATED_AT is still trim, so 21-26 differ
  assert.deepEqual(await runCompare(), { SOURCE: '26', TARGET: '26', MATCH: '12', MODIFIED: '14', ADDED: '0', DELETED: '0' });
  await mapping.getByLabel('5번 비교 규칙').selectOption('datetime');
  assert.match(await validate(), /KEY 검증 통과/);
  assert.deepEqual(await runCompare(), { SOURCE: '26', TARGET: '26', MATCH: '16', MODIFIED: '10', ADDED: '0', DELETED: '0' });
  assert.equal(await download('변경 데이터'), [
    'ID,COLUMN_NAME,SOURCE_VALUE,TARGET_VALUE',
    '7,AMOUNT,100,101',
    '8,AMOUNT,"1,000원",1000',
    '9,AMOUNT,1234567890123456,"1,234,567,890,123,456"',
    '10,AMOUNT,,""',
    '14,ORDER_DATE,2026-10-04,2026-10-05',
    '15,ORDER_DATE,2026-1-5,2026-01-05',
    '16,ORDER_DATE,10/06/2026,2026-10-06',
    '18,ORDER_DATE,2026-02-30,2026-03-02',
    '23,UPDATED_AT,2026-10-01 09:00:00,2026-10-01 09:00:01',
    '26,UPDATED_AT,2026-10-01 25:00:00,2026-10-02 01:00:00',
    ''].join('\n'));
  // Date rule on a timestamp column ignores the 1 second difference of 23
  await mapping.getByLabel('5번 비교 규칙').selectOption('date');
  assert.match(await validate(), /KEY 검증 통과/);
  assert.deepEqual(await runCompare(), { SOURCE: '26', TARGET: '26', MATCH: '17', MODIFIED: '9', ADDED: '0', DELETED: '0' });
  pass('숫자·날짜·일시 샘플(기본 공백 무시, 숫자·날짜·일시 규칙, 날짜 규칙 시간 무시, 변환 실패 원문 비교)');
  // Large comparison: target shifted by 1,000 ids, every 5th shared id changed
  const rows = (from, to, amount) => 'ID,NAME,AMOUNT\n' + Array.from({ length: to - from + 1 }, (_, i) => `${from + i},사용자${from + i},${amount(from + i)}`).join('\n');
  await source.locator('input[type=file]').setInputFiles({ name: 'large_source.csv', mimeType: 'text/csv', buffer: Buffer.from(rows(1, 100000, i => i * 10)) });
  await target.locator('input[type=file]').setInputFiles({ name: 'large_target.csv', mimeType: 'text/csv', buffer: Buffer.from(rows(1001, 101000, i => i * 10 + (i % 5 === 0 ? 1 : 0))) });
  await mapping.waitFor({ timeout: 60000 });
  await mapping.getByLabel('1번 매핑 KEY').check();
  assert.match(await validate(), /KEY 검증 통과/);
  assert.deepEqual(await runCompare(), { SOURCE: '100,000', TARGET: '100,000', MATCH: '79,200', MODIFIED: '19,800', ADDED: '1,000', DELETED: '1,000' });
  pass('10만 행 비교 건수');
  await results.getByText('1 / 2,020 페이지').waitFor();
  assert.equal(await resultRows.count(), 50);
  await results.getByRole('button', { name: '다음' }).click();
  await results.getByText('2 / 2,020 페이지').waitFor();
  await resultRows.first().locator('td:nth-child(2)').filter({ hasText: /^51$/ }).waitFor();
  await filterButton('MODIFIED').click();
  await results.getByText('1 / 396 페이지').waitFor();
  await resultRows.first().locator('td:nth-child(2)').filter({ hasText: /^1005$/ }).waitFor();
  await filterButton('ADDED').click();
  await results.getByText('1 / 20 페이지').waitFor();
  const modifiedCsv = (await download('변경 데이터')).trimEnd().split('\n');
  assert.equal(modifiedCsv.length, 19800 + 1);
  assert.equal(modifiedCsv[1], '1005,AMOUNT,10050,10051');
  assert.equal((await download('전체 결과')).trimEnd().split('\n').length, 101000 + 1);
  // ADDED rows sit in the last chunk only; the header must still come first exactly once.
  const addedCsv = (await download('추가 데이터')).trimEnd().split('\n');
  assert.equal(addedCsv.length, 1000 + 1);
  assert.deepEqual(addedCsv.slice(0, 2), ['ID,NAME,AMOUNT', '100001,사용자100001,1000010']);
  await resultRows.first().locator('td:nth-child(2)').filter({ hasText: /^100001$/ }).waitFor();
  pass('10만 행 페이지 이동·필터·다운로드');
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  pass('외부 요청 0건, 페이지 오류 0건');
  await page.screenshot({ path: '/tmp/datacompare-check.png', fullPage: true });
  console.log('PASS: 전체 시나리오 통과');
} finally { await browser.close(); }
