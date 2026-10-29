import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { ColumnPair, CompareRule, CompareSummary, CsvInfo, ExportKind, KeyCheck, ResultRow, Side, Status } from '../../types/csv';

// Each workspace owns its engine and table names; the single-file exports keep their own instance.
export function createClient() {
let database: duckdb.AsyncDuckDB | undefined;
let connection: duckdb.AsyncDuckDBConnection | undefined;
let worker: Worker | undefined;
const sqlTableNames: Record<Side, string> = { source: 'source', target: 'target' };

function setSqlTableName(side: Side, value: string): void {
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  const name = value.trim();
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) throw new Error('테이블명은 문자 또는 _로 시작하고 문자·숫자·_만 사용할 수 있습니다.');
  const other = side === 'source' ? 'target' : 'source';
  const lower = name.toLowerCase();
  if (lower === sqlTableNames[other].toLowerCase()) throw new Error('기준 파일과 비교 파일의 테이블명은 서로 달라야 합니다.');
  if (lower !== side && ['source', 'target', 'source_raw', 'target_raw', 'source_sql', 'target_sql', 'comparison', 'comparison_expected'].includes(lower)) throw new Error('앱에서 사용하는 이름입니다. 다른 테이블명을 입력하세요.');
  sqlTableNames[side] = name;
}

type Table = Awaited<ReturnType<duckdb.AsyncDuckDBConnection['query']>>;

// Arrow cells arrive as typed values; the UI only needs strings and NULL kept apart.
function cell(table: Table, column: number, row: number): string | null {
  const value: unknown = table.getChildAt(column)?.get(row);
  return value == null ? null : String(value);
}

async function initialize(): Promise<string> {
  if (location.protocol === 'file:') throw new Error('file:// 실행은 지원하지 않습니다. README의 로컬 HTTP 실행 방법을 사용하세요.');
  await dispose();
  try {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    });
    worker = new Worker(bundle.mainWorker!);
    database = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await database.instantiate(bundle.mainModule);
    await database.open({ query: { castBigIntToDouble: false } });
    connection = await database.connect();
    await connection.query("SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;");
    const result = await connection.query('SELECT version() AS version');
    return String(result.get(0)?.version);
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function loadCsv(side: Side, file: File, header: boolean): Promise<CsvInfo> {
  if (!database || !connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  if (file.size === 0) throw new Error('빈 파일입니다. CSV 데이터를 확인하세요.');
  // Table names and file paths are application-owned; the user's file name never enters SQL.
  const path = `${side}.csv`;
  // Comparison rows point at the old table's rowids, so any reload invalidates them.
  await connection.query('DROP TABLE IF EXISTS comparison; DROP TABLE IF EXISTS comparison_expected');
  await connection.query(`DROP TABLE IF EXISTS ${side}_raw`);
  await database.registerFileHandle(path, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  try {
    await connection.query(`CREATE OR REPLACE TABLE ${side} AS SELECT * FROM read_csv('${path}', header=${header}, all_varchar=true, delim=',', quote='"', escape='"', nullstr='', allow_quoted_nulls=false, strict_mode=true)`);
    return await describeTable(side, file.name, file.size);
  } catch (error) {
    // A failed reload must not leave the previous file's table behind for later comparison.
    await connection.query(`DROP TABLE IF EXISTS ${side}`).catch(cause => console.error('이전 테이블 정리 실패', cause));
    throw error;
  } finally {
    await database.dropFile(path);
  }
}

async function clearCsv(side: Side): Promise<void> {
  if (!connection) return;
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  await connection.query('DROP TABLE IF EXISTS comparison; DROP TABLE IF EXISTS comparison_expected');
  await connection.query(`DROP TABLE IF EXISTS ${side}`);
  await connection.query(`DROP TABLE IF EXISTS ${side}_raw`);
}

async function describeTable(side: Side, name: string, size: number): Promise<CsvInfo> {
  const schema = await connection!.query(`DESCRIBE ${side}`);
  const count = await connection!.query(`SELECT count(*) AS total FROM ${side}`);
  const rows = await connection!.query(`SELECT * FROM ${side} LIMIT 20`);
  const total: unknown = count.get(0)?.total;
  if (total == null) throw new Error('행 수를 조회하지 못했습니다.');
  return {
    name, size, rowCount: String(total),
    columns: schema.toArray().map(row => String(row.column_name)),
    preview: Array.from({ length: rows.numRows }, (_, index) => rows.schema.fields.map((_, column) => cell(rows, column, index))),
  };
}

async function hasTable(name: string): Promise<boolean> {
  const result = await connection!.query(`SELECT count(*) AS cnt FROM duckdb_tables() WHERE table_name = ${quoteLiteral(name)}`);
  return Number(result.get(0)?.cnt) > 0;
}

// Replaces the side's table with the result of a user SELECT. Inside the query the side's own name
// always means the originally loaded CSV (kept as <side>_raw), so the SQL can be edited and re-run.
// The query runs as a subquery, so a second statement after ';' is a syntax error rather than executed.
// Every result column is cast back to VARCHAR so KEY checks, rules and downloads behave as for a CSV.
async function transformTable(side: Side, sql: string, name: string, size: number): Promise<CsvInfo> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  const query = sql.trim().replace(/;+\s*$/, '');
  if (!query) throw new Error('SQL을 입력하세요.');
  if (!await hasTable(side)) throw new Error('먼저 CSV 파일을 불러오세요.');
  const raw = await hasTable(`${side}_raw`);
  const aliases: string[] = [];
  for (const current of ['source', 'target'] as const) {
    if (current !== side && !await hasTable(current)) continue;
    const table = current === side && raw ? `${current}_raw` : current;
    const select = `SELECT * FROM main.${quoteIdentifier(table)}`;
    // Keep the default names usable for existing SQL, alongside each custom name.
    aliases.push(`${quoteIdentifier(current)} AS (${select})`);
    if (sqlTableNames[current].toLowerCase() !== current) aliases.push(`${quoteIdentifier(sqlTableNames[current])} AS (${select})`);
  }
  const scope = `WITH ${aliases.join(', ')}\n`;
  try {
    await connection.query(`CREATE OR REPLACE TABLE ${side}_sql AS ${scope}SELECT COLUMNS(*)::VARCHAR FROM (\n${query}\n)`);
  } catch (error) {
    await connection.query(`DROP TABLE IF EXISTS ${side}_sql`).catch(cause => console.error('SQL 임시 테이블 정리 실패', cause));
    throw error;
  }
  // One transaction, so a failed swap never leaves the side without a table.
  await connection.query(`BEGIN TRANSACTION;
DROP TABLE IF EXISTS comparison;
DROP TABLE IF EXISTS comparison_expected;
${raw ? `DROP TABLE ${side};` : `ALTER TABLE ${side} RENAME TO ${side}_raw;`}
ALTER TABLE ${side}_sql RENAME TO ${side};
COMMIT;`).catch(async error => {
    await connection!.query('ROLLBACK').catch(() => undefined);
    throw error;
  });
  return describeTable(side, name, size);
}

// Restores the originally loaded CSV after transformTable.
async function resetTable(side: Side, name: string, size: number): Promise<CsvInfo> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  if (await hasTable(`${side}_raw`)) {
    await connection.query(`BEGIN TRANSACTION;
DROP TABLE IF EXISTS comparison;
DROP TABLE IF EXISTS comparison_expected;
DROP TABLE IF EXISTS ${side};
ALTER TABLE ${side}_raw RENAME TO ${side};
COMMIT;`).catch(async error => {
      await connection!.query('ROLLBACK').catch(() => undefined);
      throw error;
    });
  }
  return describeTable(side, name, size);
}

// User column names reach SQL only after matching the loaded table's columns, then as quoted identifiers.
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const rules: CompareRule[] = ['exact', 'trim', 'number', 'date', 'datetime', 'sql'];

// DuckDB's tokenizer distinguishes SQL syntax from quoted strings and Korean identifiers.
// Only a scalar expression is accepted: no statements, comments, subqueries or row expansion.
async function assertExpression(expression: string): Promise<void> {
  if (!database) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (!expression.trim()) throw new Error('SQL 변환식을 입력하세요.');
  const tokens = await database.tokenize(expression);
  const bytes = new TextEncoder().encode(expression);
  const blocked = new Set(['SELECT', 'FROM', 'JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'OVER', 'WINDOW', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'WITH', 'VALUES', 'INTO', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'COPY', 'ATTACH', 'DETACH', 'INSTALL', 'LOAD', 'CALL', 'PRAGMA', 'SET', 'UNNEST', 'RANDOM', 'UUID', 'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_TIME', 'CURRENT_DATE']);
  for (let index = 0; index < tokens.offsets.length; index++) {
    const type = tokens.types[index];
    if (type === duckdb.TokenType.STRING_CONSTANT) continue;
    const token = new TextDecoder().decode(bytes.subarray(tokens.offsets[index], tokens.offsets[index + 1] ?? bytes.length)).trim();
    if (type === duckdb.TokenType.COMMENT || token === ';' || blocked.has(token.toUpperCase())) throw new Error('컬럼과 함수로 구성된 변환식만 입력하세요. SELECT·명령문·주석·집계·윈도·행 확장은 사용할 수 없습니다.');
  }
}

function expressionValue(expression: string): string {
  return `CAST((\n${expression}\n) AS VARCHAR)`;
}

async function previewExpression(pair: ColumnPair): Promise<{ original: string | null; expected: string | null }[]> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  const columns = await columnsOf('source');
  if (!columns.has(pair.source)) throw new Error('Source 컬럼을 확인하세요.');
  const expression = pair.expression ?? '';
  await assertExpression(expression);
  const value = expressionValue(expression);
  // Bind as a per-row expression; aggregates cannot consume a non-grouped rowid.
  await connection.query(`SELECT rowid, ${value} AS expected FROM source LIMIT 0`);
  // Evaluate all rows so bad casts beyond the preview also block comparison.
  await connection.query(`SELECT count(${value}) FROM source`);
  const result = await connection.query(`SELECT ${quoteIdentifier(pair.source)}, ${value} FROM source LIMIT 5`);
  return Array.from({ length: result.numRows }, (_, index) => ({ original: cell(result, 0, index), expected: cell(result, 1, index) }));
}

const hasExpressions = (pairs: ColumnPair[]) => pairs.some(pair => pair.rule === 'sql');
const expectedValue = (pair: ColumnPair, index: number) => pair.rule === 'sql' ? `e.value_${index}` : `s.${quoteIdentifier(pair.source)}`;
const expectedJoin = (pairs: ColumnPair[]) => hasExpressions(pairs) ? 'LEFT JOIN comparison_expected e ON e.source_row = c.source_row' : '';

async function prepareExpected(pairs: ColumnPair[]): Promise<void> {
  if (!hasExpressions(pairs)) { await connection!.query('DROP TABLE IF EXISTS comparison_expected'); return; }
  const values: string[] = [];
  for (const [index, pair] of pairs.entries()) {
    if (pair.rule !== 'sql') continue;
    await assertExpression(pair.expression ?? '');
    values.push(`${expressionValue(pair.expression!)} AS value_${index}`);
  }
  await connection!.query(`CREATE OR REPLACE TEMP TABLE comparison_expected AS SELECT rowid AS source_row, ${values.join(', ')} FROM source`);
}


// Typed value for number/date rules; NULL when the text cannot be parsed. Plain replace() is used
// instead of regexp_replace() because it is several times faster on large columns.
// DOUBLE parses ~10x faster than DECIMAL(38, 10) and keeps every number of up to 15 digits distinct;
// longer numbers are left unparsed so they fall back to an exact text comparison.
function parsed(column: string, rule: CompareRule): string {
  if (rule === 'number') {
    const digits = `replace(trim(${column}), ',', '')`;
    return `CASE WHEN length(${digits}) <= 15 THEN try_cast(${digits} AS DOUBLE) END`;
  }
  // Date part loses its - . / separators and time part its colons, so four fixed formats cover
  // 2026-10-01, 2026.10.01 13:05, 2026/10/01T13:05:00.5 and 20261001. A third space-separated part
  // means unknown text, which is left unparsed rather than half-read.
  const text = `replace(trim(${column}), 'T', ' ')`;
  const day = `replace(replace(replace(split_part(${text}, ' ', 1), '-', ''), '.', ''), '/', '')`;
  const time = `replace(split_part(${text}, ' ', 2), ':', '')`;
  // Picking one format by length is several times faster than letting strptime try a format list.
  const timestamp = `CASE WHEN split_part(${text}, ' ', 3) = '' THEN CASE length(${time}) WHEN 0 THEN try_strptime(${day}, '%Y%m%d') WHEN 4 THEN try_strptime(${day} || ${time}, '%Y%m%d%H%M') WHEN 6 THEN try_strptime(${day} || ${time}, '%Y%m%d%H%M%S') ELSE try_strptime(${day} || ${time}, '%Y%m%d%H%M%S.%f') END END`;
  return rule === 'date' ? `CAST(${timestamp} AS DATE)` : timestamp;
}

// Single hashable KEY value for joins and duplicate checks. Display and download keep original values.
// Unparseable number/date text falls back to the original text, and NULL stays NULL.
function normalize(column: string, rule: CompareRule): string {
  if (rule === 'trim') return `trim(${column})`;
  if (rule !== 'exact' && rule !== 'sql') return `coalesce(CAST(${parsed(column, rule)} AS VARCHAR), ${column})`;
  return column;
}

// Value columns compare typed values directly; converting them back to text dominated the cost.
function differs(source: string, target: string, rule: CompareRule): string {
  if (rule === 'trim') return `trim(${source}) IS DISTINCT FROM trim(${target})`;
  if (rule !== 'exact' && rule !== 'sql') {
    const [left, right] = [parsed(source, rule), parsed(target, rule)];
    // left <> right is NULL only when either side failed to parse, so each side is parsed once.
    return `coalesce(${left} <> ${right}, ${source} IS DISTINCT FROM ${target})`;
  }
  return `${source} IS DISTINCT FROM ${target}`;
}

async function columnsOf(side: Side): Promise<Set<string>> {
  const schema = await connection!.query(`DESCRIBE ${side}`);
  return new Set(schema.toArray().map(row => String(row.column_name)));
}

async function validateKeys(side: Side, keys: { name: string; rule: CompareRule; expression?: string }[]): Promise<KeyCheck> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  if (keys.length === 0) throw new Error('KEY 컬럼을 하나 이상 선택하세요.');
  const columns = await columnsOf(side);
  const unknown = keys.filter(key => !columns.has(key.name)).map(key => key.name);
  if (unknown.length) throw new Error(`존재하지 않는 컬럼입니다: ${unknown.join(', ')}`);
  if (new Set(keys.map(key => key.name)).size !== keys.length) throw new Error('KEY 컬럼이 중복 선택되었습니다.');
  if (keys.some(key => !rules.includes(key.rule))) throw new Error('잘못된 비교 규칙입니다.');
  // Duplicates and empty keys are judged on the normalized value, exactly as the comparison join sees it.
  for (const key of keys) if (side === 'source' && key.rule === 'sql') {
    await previewExpression({ source: key.name, target: key.name, key: true, rule: 'sql', expression: key.expression });
  }
  const quoted = keys.map(key => normalize(side === 'source' && key.rule === 'sql' ? expressionValue(key.expression!) : quoteIdentifier(key.name), key.rule));
  const keyList = quoted.join(', ');
  const anyNull = quoted.map(key => `${key} IS NULL`).join(' OR ');
  const anyEmpty = quoted.map(key => `${key} = ''`).join(' OR ');
  // NULL/empty keys are reported separately, so the duplicate check covers only valid keys.
  const validKeys = `NOT (${anyNull}) AND NOT (${anyEmpty})`;
  const counts = await connection.query(`
SELECT
	count(*) AS row_count
	, count(*) FILTER (WHERE ${anyNull}) AS null_rows
	, count(*) FILTER (WHERE ${anyEmpty}) AS empty_rows
FROM ${side}`);
  const duplicates = await connection.query(`
SELECT
	count(*) AS duplicate_keys
	, coalesce(sum(cnt), 0) AS duplicate_rows
FROM (
	SELECT
		count(*) AS cnt
	FROM ${side}
	WHERE ${validKeys}
	GROUP BY
		${keyList}
	HAVING count(*) > 1
)`);
  const samples = await connection.query(`
SELECT
	${keyList}
	, count(*) AS cnt
FROM ${side}
WHERE ${validKeys}
GROUP BY
	${keyList}
HAVING count(*) > 1
ORDER BY
	cnt DESC
LIMIT 10`);
  const total = counts.get(0);
  const duplicate = duplicates.get(0);
  if (!total || !duplicate) throw new Error('KEY 검증 결과를 조회하지 못했습니다.');
  return {
    rowCount: Number(total.row_count),
    nullRows: Number(total.null_rows),
    emptyRows: Number(total.empty_rows),
    duplicateKeys: Number(duplicate.duplicate_keys),
    duplicateRows: Number(duplicate.duplicate_rows),
    samples: Array.from({ length: samples.numRows }, (_, index) => ({
      values: keys.map((_, column) => cell(samples, column, index)),
      count: Number(samples.getChildAt(keys.length)?.get(index)),
    })),
  };
}

async function assertPairs(pairs: ColumnPair[]): Promise<ColumnPair[]> {
  const keys = pairs.filter(pair => pair.key);
  if (keys.length === 0) throw new Error('KEY 컬럼을 하나 이상 선택하세요.');
  const sourceColumns = await columnsOf('source');
  const targetColumns = await columnsOf('target');
  const unknown = pairs.flatMap(pair => [
    ...(sourceColumns.has(pair.source) ? [] : [`Source ${pair.source}`]),
    ...(targetColumns.has(pair.target) ? [] : [`Target ${pair.target}`]),
  ]);
  if (unknown.length) throw new Error(`존재하지 않는 컬럼입니다: ${unknown.join(', ')}`);
  if (pairs.some(pair => !rules.includes(pair.rule))) throw new Error('잘못된 비교 규칙입니다.');
  return keys;
}

// Run only after validateKeys passed on both sides: duplicate or NULL keys would corrupt the join.
async function compare(pairs: ColumnPair[]): Promise<CompareSummary> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  const keys = await assertPairs(pairs);
  await prepareExpected(pairs);
  const side = (alias: 's' | 't', pair: ColumnPair) => normalize(alias === 's' ? expectedValue(pair, pairs.indexOf(pair)) : `t.${quoteIdentifier(pair.target)}`, pair.rule);
  const on = keys.map(pair => `${side('s', pair)} = ${side('t', pair)}`).join('\n\t\tAND ');
  // changed holds indexes into pairs; NULL vs '' counts as a difference because IS DISTINCT FROM keeps them apart.
  const changes = pairs.flatMap((pair, index) => pair.key ? [] : [`CASE WHEN ${differs(expectedValue(pair, index), `t.${quoteIdentifier(pair.target)}`, pair.rule)} THEN [${index}] ELSE [] END`]);
  const changed = changes.length ? `flatten([${changes.join(', ')}])` : '[]::INTEGER[]';
  await connection.query(`
CREATE OR REPLACE TABLE comparison AS
SELECT
	source_row
	, target_row
	, CASE
		WHEN source_row IS NULL THEN 'ADDED'
		WHEN target_row IS NULL THEN 'DELETED'
		WHEN len(changed) > 0 THEN 'MODIFIED'
		ELSE 'MATCH'
	END AS status
	, changed
	-- Stable display order, also used to export in fixed-size chunks.
	, row_number() OVER (ORDER BY source_row NULLS LAST, target_row) - 1 AS ord
FROM (
	SELECT
		s.rowid AS source_row
		, t.rowid AS target_row
		, CASE WHEN s.rowid IS NOT NULL AND t.rowid IS NOT NULL THEN ${changed} ELSE []::INTEGER[] END AS changed
	FROM source s
	${hasExpressions(pairs) ? 'LEFT JOIN comparison_expected e ON e.source_row = s.rowid' : ''}
	FULL OUTER JOIN target t
		ON ${on}
)`);
  const result = await connection.query(`
SELECT
	(SELECT count(*) FROM source) AS source_rows
	, (SELECT count(*) FROM target) AS target_rows
	, count(*) FILTER (WHERE status = 'MATCH') AS match_rows
	, count(*) FILTER (WHERE status = 'MODIFIED') AS modified_rows
	, count(*) FILTER (WHERE status = 'ADDED') AS added_rows
	, count(*) FILTER (WHERE status = 'DELETED') AS deleted_rows
FROM comparison`);
  const row = result.get(0);
  if (!row) throw new Error('비교 결과를 조회하지 못했습니다.');
  return {
    sourceRows: Number(row.source_rows), targetRows: Number(row.target_rows),
    match: Number(row.match_rows), modified: Number(row.modified_rows), added: Number(row.added_rows), deleted: Number(row.deleted_rows),
  };
}

const statuses: Status[] = ['MATCH', 'MODIFIED', 'ADDED', 'DELETED'];

// Reads one page of comparison rows; values come from the original tables via rowid, never copied.
async function fetchResults(pairs: ColumnPair[], status: Status | undefined, page: number, pageSize: number): Promise<ResultRow[]> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (status !== undefined && !statuses.includes(status)) throw new Error('잘못된 상태 값입니다.');
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('잘못된 페이지 값입니다.');
  const keys = await assertPairs(pairs);
  const keyValues = keys.map((pair, index) => `\n\t, coalesce(${expectedValue(pair, pairs.indexOf(pair))}, t.${quoteIdentifier(pair.target)}) AS key_${index}`).join('');
  const result = await connection.query(`
SELECT
	c.status
	, c.source_row
	, c.target_row
	, c.changed${keyValues}
FROM (
	SELECT
		*
	FROM comparison
	${status ? `WHERE status = '${status}'` : ''}
	ORDER BY
		source_row NULLS LAST
		, target_row
	LIMIT ${pageSize} OFFSET ${page * pageSize}
) c
LEFT JOIN source s
	ON s.rowid = c.source_row
LEFT JOIN target t
	ON t.rowid = c.target_row
${expectedJoin(pairs)}
ORDER BY
	c.source_row NULLS LAST
	, c.target_row`);
  return Array.from({ length: result.numRows }, (_, index) => {
    const row = result.get(index)!;
    return {
      status: String(row.status) as Status,
      sourceRow: row.source_row == null ? null : Number(row.source_row),
      targetRow: row.target_row == null ? null : Number(row.target_row),
      changed: Array.from(row.changed?.toArray() ?? [], Number),
      keys: keys.map((_, column) => cell(result, 4 + column, index)),
    };
  });
}

// Values of every mapped column for one original row, in pairs order.
async function fetchRow(side: Side, pairs: ColumnPair[], rowid: number): Promise<(string | null)[]> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  if (!Number.isSafeInteger(rowid) || rowid < 0) throw new Error('잘못된 행 번호입니다.');
  await assertPairs(pairs);
  const columns = pairs.map(pair => quoteIdentifier(pair[side])).join('\n\t, ');
  const result = await connection.query(`
SELECT
	${columns}
FROM ${side}
WHERE rowid = ${rowid}`);
  if (result.numRows !== 1) throw new Error('원본 행을 찾지 못했습니다.');
  return pairs.map((_, column) => cell(result, column, 0));
}

async function fetchExpectedRow(pairs: ColumnPair[], rowid: number): Promise<(string | null)[]> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (!Number.isSafeInteger(rowid) || rowid < 0) throw new Error('잘못된 행 번호입니다.');
  const result = await connection.query(`SELECT ${pairs.map(expectedValue).join(', ')} FROM source s LEFT JOIN comparison_expected e ON e.source_row = s.rowid WHERE s.rowid = ${rowid}`);
  if (result.numRows !== 1) throw new Error('원본 행을 찾지 못했습니다.');
  return pairs.map((_, index) => cell(result, index, 0));
}

function columnLabel(pair: ColumnPair): string {
  return pair.source === pair.target ? pair.source : `${pair.source} / ${pair.target}`;
}

function exportQuery(pairs: ColumnPair[], kind: ExportKind, from: number, to: number): string {
  const range = `c.ord >= ${from} AND c.ord < ${to}`;
  const joins = `FROM comparison c
LEFT JOIN source s
	ON s.rowid = c.source_row
LEFT JOIN target t
	ON t.rowid = c.target_row
${expectedJoin(pairs)}`;
  const keyValues = pairs.flatMap(pair => pair.key ? [`coalesce(s.${quoteIdentifier(pair.source)}, t.${quoteIdentifier(pair.target)}) AS ${quoteIdentifier(pair.source)}`] : []);
  const keyColumns = keyValues.map(value => `\n\t, ${value}`).join('');
  const compared = pairs.map((pair, index) => ({ pair, index })).filter(({ pair }) => !pair.key);
  if (kind === 'ADDED' || kind === 'DELETED') {
    // Added/deleted rows are exported as the complete original rows, ready to re-use.
    const alias = kind === 'ADDED' ? 't' : 's';
    return `
SELECT
	${alias}.*
${joins}
WHERE c.status = '${kind}'
	AND ${range}
ORDER BY
	c.ord`;
  }
  if (kind === 'MODIFIED') {
    if (compared.length === 0) throw new Error('비교 컬럼이 없어 변경 데이터가 없습니다.');
    const pick = (value: (pair: ColumnPair) => string) => `CASE c.idx${compared.map(({ pair, index }) => ` WHEN ${index} THEN ${value(pair)}`).join('')} END`;
    // One output row per changed column: KEY, column name, source value, target value.
    return `
SELECT
	${keyValues.join('\n\t, ')}
	, ${pick(pair => quoteLiteral(columnLabel(pair)))} AS "COLUMN_NAME"
	, ${pick(pair => `s.${quoteIdentifier(pair.source)}`)} AS "SOURCE_VALUE"
	${hasExpressions(pairs) ? `, ${pick(pair => expectedValue(pair, pairs.indexOf(pair)))} AS "EXPECTED_VALUE"` : ''}
	, ${pick(pair => `t.${quoteIdentifier(pair.target)}`)} AS "TARGET_VALUE"
FROM (
	SELECT
		c.source_row
		, c.target_row
		, c.ord
		, unnest(c.changed) AS idx
	FROM comparison c
	WHERE c.status = 'MODIFIED'
		AND ${range}
) c
LEFT JOIN source s
	ON s.rowid = c.source_row
LEFT JOIN target t
	ON t.rowid = c.target_row
${expectedJoin(pairs)}
ORDER BY
	c.ord
	, c.idx`;
  }
  const changedNames = compared.length
    ? `nullif(concat_ws(', '${compared.map(({ pair, index }) => `, CASE WHEN list_contains(c.changed, ${index}) THEN ${quoteLiteral(columnLabel(pair))} END`).join('')}), '')`
    : 'NULL';
  const values = pairs.map((pair, index) => ({ pair, index })).filter(({ pair }) => !pair.key || pair.rule === 'sql').map(({ pair, index }) => `\n\t, s.${quoteIdentifier(pair.source)} AS ${quoteIdentifier(`${pair.source} (SOURCE)`)}${pair.rule === 'sql' ? `\n\t, ${expectedValue(pair, index)} AS ${quoteIdentifier(`${pair.source} (EXPECTED)`)}` : ''}\n\t, t.${quoteIdentifier(pair.target)} AS ${quoteIdentifier(`${pair.target} (TARGET)`)}`).join('');
  return `
SELECT
	c.status AS "STATUS"${keyColumns}
	, ${changedNames} AS "CHANGED_COLUMNS"${values}
${joins}
WHERE ${range}
ORDER BY
	c.ord`;
}

const exportChunk = 100_000;

// DuckDB writes each chunk into its virtual file system; chunks become Blobs right away so the
// browser can keep them outside the page heap and the WASM heap never holds the whole result.
async function exportCsv(pairs: ColumnPair[], kind: ExportKind): Promise<Blob> {
  if (!database || !connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (!['ALL', 'ADDED', 'DELETED', 'MODIFIED'].includes(kind)) throw new Error('잘못된 다운로드 구분입니다.');
  await assertPairs(pairs);
  const total = Number((await connection.query('SELECT count(*) AS total FROM comparison')).get(0)?.total ?? 0);
  const path = 'export.csv';
  const parts: Blob[] = [];
  for (let from = 0; from === 0 || from < total; from += exportChunk) {
    try {
      await connection.query(`COPY (${exportQuery(pairs, kind, from, from + exportChunk)}) TO '${path}' (HEADER ${from === 0}, DELIMITER ',', QUOTE '"', ESCAPE '"', NULLSTR '')`);
      // The worker transfers a plain ArrayBuffer, never a SharedArrayBuffer.
      const bytes = await database.copyFileToBuffer(path) as Uint8Array<ArrayBuffer>;
      if (bytes.length) parts.push(new Blob([bytes]));
    } finally {
      await database.dropFile(path).catch(cause => console.error('다운로드 임시 파일 정리 실패', cause));
    }
  }
  return new Blob(parts);
}

async function dispose(): Promise<void> {
  try { await connection?.close(); } finally {
    connection = undefined;
    try { await database?.terminate(); } finally {
      database = undefined;
      worker?.terminate();
      worker = undefined;
    }
  }
}

// Read mismatch records in pages, including all values in one query rather than one query per cell.
async function fetchMismatchDetails(pairs: ColumnPair[], page: number) {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('잘못된 페이지 값입니다.');
  const fields = pairs.flatMap((pair, i) => [
    `s.${quoteIdentifier(pair.source)} AS source_${i}`,
    `${expectedValue(pair, i)} AS expected_${i}`,
    `t.${quoteIdentifier(pair.target)} AS target_${i}`,
  ]);
  const result = await connection.query(`SELECT c.*, ${fields.join(', ')}
    FROM (SELECT * FROM comparison WHERE status != 'MATCH' ORDER BY ord LIMIT 1000 OFFSET ${page * 1000}) c
    LEFT JOIN source s ON s.rowid = c.source_row
    LEFT JOIN target t ON t.rowid = c.target_row
    ${expectedJoin(pairs)} ORDER BY c.ord`);
  const indexes = pairs.map((_, i) => ['source', 'expected', 'target'].map(side => result.schema.fields.findIndex(f => f.name === `${side}_${i}`)));
  return Array.from({ length: result.numRows }, (_, r) => {
    const row = result.get(r)!;
    return {
      status: String(row.status),
      sourceRow: row.source_row == null ? null : Number(row.source_row),
      targetRow: row.target_row == null ? null : Number(row.target_row),
      changed: Array.from(row.changed ?? [], Number),
      source: indexes.map(columns => cell(result, columns[0], r)),
      expected: indexes.map(columns => cell(result, columns[1], r)),
      target: indexes.map(columns => cell(result, columns[2], r)),
    };
  });
}

return { setSqlTableName, initialize, loadCsv, clearCsv, transformTable, resetTable, previewExpression, validateKeys, compare, fetchResults, fetchRow, fetchExpectedRow, exportCsv, dispose, fetchMismatchDetails };
}

export type DuckDbClient = ReturnType<typeof createClient>;
export const { setSqlTableName, initialize, loadCsv, clearCsv, transformTable, resetTable, previewExpression, validateKeys, compare, fetchResults, fetchRow, fetchExpectedRow, exportCsv, dispose, fetchMismatchDetails } = createClient();
