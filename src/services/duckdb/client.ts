import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { ColumnPair, CompareRule, CompareSummary, CsvInfo, ExportKind, KeyCheck, ResultRow, Side, Status } from '../../types/csv';

let database: duckdb.AsyncDuckDB | undefined;
let connection: duckdb.AsyncDuckDBConnection | undefined;
let worker: Worker | undefined;

type Table = Awaited<ReturnType<duckdb.AsyncDuckDBConnection['query']>>;

// Arrow cells arrive as typed values; the UI only needs strings and NULL kept apart.
function cell(table: Table, column: number, row: number): string | null {
  const value: unknown = table.getChildAt(column)?.get(row);
  return value == null ? null : String(value);
}

export async function initialize(): Promise<string> {
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

export async function loadCsv(side: Side, file: File, header: boolean): Promise<CsvInfo> {
  if (!database || !connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  if (file.size === 0) throw new Error('빈 파일입니다. CSV 데이터를 확인하세요.');
  // Table names and file paths are application-owned; the user's file name never enters SQL.
  const path = `${side}.csv`;
  // Comparison rows point at the old table's rowids, so any reload invalidates them.
  await connection.query('DROP TABLE IF EXISTS comparison');
  await database.registerFileHandle(path, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  try {
    await connection.query(`CREATE OR REPLACE TABLE ${side} AS SELECT * FROM read_csv('${path}', header=${header}, all_varchar=true, delim=',', quote='"', escape='"', nullstr='', allow_quoted_nulls=false, strict_mode=true)`);
    const schema = await connection.query(`DESCRIBE ${side}`);
    const count = await connection.query(`SELECT count(*) AS total FROM ${side}`);
    const rows = await connection.query(`SELECT * FROM ${side} LIMIT 20`);
    const total: unknown = count.get(0)?.total;
    if (total == null) throw new Error('행 수를 조회하지 못했습니다.');
    return {
      name: file.name, size: file.size, rowCount: String(total),
      columns: schema.toArray().map(row => String(row.column_name)),
      preview: Array.from({ length: rows.numRows }, (_, index) => rows.schema.fields.map((_, column) => cell(rows, column, index))),
    };
  } catch (error) {
    // A failed reload must not leave the previous file's table behind for later comparison.
    await connection.query(`DROP TABLE IF EXISTS ${side}`).catch(cause => console.error('이전 테이블 정리 실패', cause));
    throw error;
  } finally {
    await database.dropFile(path);
  }
}

export async function clearCsv(side: Side): Promise<void> {
  if (!connection) return;
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  await connection.query('DROP TABLE IF EXISTS comparison');
  await connection.query(`DROP TABLE IF EXISTS ${side}`);
}

// User column names reach SQL only after matching the loaded table's columns, then as quoted identifiers.
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const rules: CompareRule[] = ['exact', 'trim', 'number', 'date'];

// Typed value for number/date rules; NULL when the text cannot be parsed. Plain replace() is used
// instead of regexp_replace() because it is several times faster on large columns.
// DOUBLE parses ~10x faster than DECIMAL(38, 10) and keeps every number of up to 15 digits distinct;
// longer numbers are left unparsed so they fall back to an exact text comparison.
function parsed(column: string, rule: CompareRule): string {
  if (rule === 'number') {
    const digits = `replace(trim(${column}), ',', '')`;
    return `CASE WHEN length(${digits}) <= 15 THEN try_cast(${digits} AS DOUBLE) END`;
  }
  return `CAST(try_strptime(replace(replace(replace(trim(${column}), '-', ''), '.', ''), '/', ''), '%Y%m%d') AS DATE)`;
}

// Single hashable KEY value for joins and duplicate checks. Display and download keep original values.
// Unparseable number/date text falls back to the original text, and NULL stays NULL.
function normalize(column: string, rule: CompareRule): string {
  if (rule === 'trim') return `trim(${column})`;
  if (rule === 'number' || rule === 'date') return `coalesce(CAST(${parsed(column, rule)} AS VARCHAR), ${column})`;
  return column;
}

// Value columns compare typed values directly; converting them back to text dominated the cost.
function differs(source: string, target: string, rule: CompareRule): string {
  if (rule === 'trim') return `trim(${source}) IS DISTINCT FROM trim(${target})`;
  if (rule === 'number' || rule === 'date') {
    const [left, right] = [parsed(source, rule), parsed(target, rule)];
    return `CASE WHEN ${left} IS NOT NULL AND ${right} IS NOT NULL THEN ${left} <> ${right} ELSE ${source} IS DISTINCT FROM ${target} END`;
  }
  return `${source} IS DISTINCT FROM ${target}`;
}

async function columnsOf(side: Side): Promise<Set<string>> {
  const schema = await connection!.query(`DESCRIBE ${side}`);
  return new Set(schema.toArray().map(row => String(row.column_name)));
}

export async function validateKeys(side: Side, keys: { name: string; rule: CompareRule }[]): Promise<KeyCheck> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (side !== 'source' && side !== 'target') throw new Error('잘못된 데이터 구분입니다.');
  if (keys.length === 0) throw new Error('KEY 컬럼을 하나 이상 선택하세요.');
  const columns = await columnsOf(side);
  const unknown = keys.filter(key => !columns.has(key.name)).map(key => key.name);
  if (unknown.length) throw new Error(`존재하지 않는 컬럼입니다: ${unknown.join(', ')}`);
  if (new Set(keys.map(key => key.name)).size !== keys.length) throw new Error('KEY 컬럼이 중복 선택되었습니다.');
  if (keys.some(key => !rules.includes(key.rule))) throw new Error('잘못된 비교 규칙입니다.');
  // Duplicates and empty keys are judged on the normalized value, exactly as the comparison join sees it.
  const quoted = keys.map(key => normalize(quoteIdentifier(key.name), key.rule));
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
export async function compare(pairs: ColumnPair[]): Promise<CompareSummary> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  const keys = await assertPairs(pairs);
  const side = (alias: 's' | 't', pair: ColumnPair) => normalize(`${alias}.${quoteIdentifier(alias === 's' ? pair.source : pair.target)}`, pair.rule);
  const on = keys.map(pair => `${side('s', pair)} = ${side('t', pair)}`).join('\n\t\tAND ');
  // changed holds indexes into pairs; NULL vs '' counts as a difference because IS DISTINCT FROM keeps them apart.
  const changes = pairs.flatMap((pair, index) => pair.key ? [] : [`CASE WHEN ${differs(`s.${quoteIdentifier(pair.source)}`, `t.${quoteIdentifier(pair.target)}`, pair.rule)} THEN [${index}] ELSE [] END`]);
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
export async function fetchResults(pairs: ColumnPair[], status: Status | undefined, page: number, pageSize: number): Promise<ResultRow[]> {
  if (!connection) throw new Error('DuckDB가 아직 준비되지 않았습니다.');
  if (status !== undefined && !statuses.includes(status)) throw new Error('잘못된 상태 값입니다.');
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('잘못된 페이지 값입니다.');
  const keys = await assertPairs(pairs);
  const keyValues = keys.map((pair, index) => `\n\t, coalesce(s.${quoteIdentifier(pair.source)}, t.${quoteIdentifier(pair.target)}) AS key_${index}`).join('');
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
export async function fetchRow(side: Side, pairs: ColumnPair[], rowid: number): Promise<(string | null)[]> {
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

function columnLabel(pair: ColumnPair): string {
  return pair.source === pair.target ? pair.source : `${pair.source} / ${pair.target}`;
}

function exportQuery(pairs: ColumnPair[], kind: ExportKind, from: number, to: number): string {
  const range = `c.ord >= ${from} AND c.ord < ${to}`;
  const joins = `FROM comparison c
LEFT JOIN source s
	ON s.rowid = c.source_row
LEFT JOIN target t
	ON t.rowid = c.target_row`;
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
ORDER BY
	c.ord
	, c.idx`;
  }
  const changedNames = compared.length
    ? `nullif(concat_ws(', '${compared.map(({ pair, index }) => `, CASE WHEN list_contains(c.changed, ${index}) THEN ${quoteLiteral(columnLabel(pair))} END`).join('')}), '')`
    : 'NULL';
  const values = compared.map(({ pair }) => `\n\t, s.${quoteIdentifier(pair.source)} AS ${quoteIdentifier(`${pair.source} (SOURCE)`)}\n\t, t.${quoteIdentifier(pair.target)} AS ${quoteIdentifier(`${pair.target} (TARGET)`)}`).join('');
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
export async function exportCsv(pairs: ColumnPair[], kind: ExportKind): Promise<Blob> {
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

export async function dispose(): Promise<void> {
  try { await connection?.close(); } finally {
    connection = undefined;
    try { await database?.terminate(); } finally {
      database = undefined;
      worker?.terminate();
      worker = undefined;
    }
  }
}
