import ExcelJS from 'exceljs';
import type { ColumnPair, CompareSummary } from '../../types/csv';
import type { DuckDbClient } from '../duckdb/client';

export const ruleLabels = { exact: '그대로', trim: '앞뒤 공백 무시', number: '숫자', date: '날짜', datetime: '일시', sql: '사용자 정의 SQL 식' };
const statusLabels: Record<string, string> = { MODIFIED: '변경', ADDED: '추가', DELETED: '삭제' };

export function createBatchReport() {
  const book = new ExcelJS.Workbook();
  book.creator = '데이터 이행 검증';
  book.created = new Date();
  function sheet(name: string, headers: string[], widths: number[]) {
    const ws = book.addWorksheet(name);
    ws.columns = headers.map((header, i) => ({ header, width: widths[i] ?? 22 }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF397916' } };
    ws.getRow(1).height = 26;
    return ws;
  }
  const summary = sheet('검증 요약', ['작업명', 'Source 파일', 'Target 파일', '처리 상태', 'Source 행', 'Target 행', '일치', '변경', '추가', '삭제', '오류 내용'], [24, 28, 28, 16, 14, 14, 14, 14, 14, 14, 65]);
  const criteria = sheet('검증 기준', ['작업명', 'Source 헤더', 'Target 헤더', 'KEY', 'Source 컬럼', 'Target 컬럼', '비교 규칙', 'Source 변환식'], [24, 16, 16, 10, 24, 24, 24, 60]);
  const detailHeaders = ['작업명', '구분', 'KEY (JSON)', 'Source 데이터 행', 'Target 데이터 행', 'Source 컬럼', 'Target 컬럼', 'Source 값', 'Source 상태', '변환 기대값', '기대값 상태', 'Target 값', 'Target 상태'];
  const detailWidths = [24, 12, 38, 20, 20, 24, 24, 32, 16, 32, 16, 32, 16];
  let details = sheet('불일치 상세', detailHeaders, detailWidths);
  let part = 1;
  function append(ws: ExcelJS.Worksheet, values: (string | number | null)[]) {
    if (values.some(v => typeof v === 'string' && v.length > 32767)) throw new Error('Excel 셀의 최대 길이(32,767자)를 초과했습니다. 값을 줄이거나 단일 검증의 CSV 다운로드를 사용하세요.');
    const row = ws.addRow(values);
    row.alignment = { vertical: 'top', wrapText: true };
    // Strings remain literal text, including leading zeros and strings beginning with '='.
    row.eachCell(cell => { if (typeof cell.value === 'string') cell.numFmt = '@'; });
  }
  function valueState(value: string | null, exists: boolean) { return !exists ? '행 없음' : value === null ? 'NULL' : value === '' ? '빈 문자열' : '문자열'; }
  return {
    criteria(name: string, sourceHeader: boolean, targetHeader: boolean, pairs: ColumnPair[]) {
      for (const pair of pairs) append(criteria, [name, sourceHeader ? '있음' : '없음', targetHeader ? '있음' : '없음', pair.key ? 'Y' : '', pair.source, pair.target, ruleLabels[pair.rule], pair.rule === 'sql' ? pair.expression ?? '' : '']);
    },
    summary(name: string, source: string, target: string, result?: CompareSummary, error = '', state?: string) {
      append(summary, [name, source, target, state ?? (error ? '실패' : '완료'), result?.sourceRows ?? null, result?.targetRows ?? null, result?.match ?? null, result?.modified ?? null, result?.added ?? null, result?.deleted ?? null, error]);
    },
    async details(name: string, pairs: ColumnPair[], client: DuckDbClient) {
      const startSheet = details;
      const startRow = details.rowCount;
      const startPart = part;
      try {
        for (let page = 0; ; page++) {
          const rows = await client.fetchMismatchDetails(pairs, page);
          for (const row of rows) {
            const key = JSON.stringify(pairs.flatMap((pair, i) => pair.key ? [{ source: pair.source, target: pair.target, value: row.sourceRow === null ? row.target[i] : row.expected[i] }] : []));
            const indexes = row.status === 'MODIFIED' ? row.changed : pairs.map((_, i) => i);
            for (const i of indexes) {
              if (details.rowCount >= 1048576) details = sheet(`불일치 상세 ${++part}`, detailHeaders, detailWidths);
              const pair = pairs[i];
              append(details, [name, statusLabels[row.status], key, row.sourceRow === null ? null : row.sourceRow + 1, row.targetRow === null ? null : row.targetRow + 1, pair.source, pair.target, row.source[i], valueState(row.source[i], row.sourceRow !== null), row.expected[i], valueState(row.expected[i], row.sourceRow !== null), row.target[i], valueState(row.target[i], row.targetRow !== null)]);
            }
          }
          if (rows.length < 1000) break;
        }
      } catch (error) {
        // A failed job must not leave a partially written detail section in the report.
        while (part > startPart) { book.removeWorksheet(details.id); details = book.getWorksheet(--part === 1 ? '불일치 상세' : `불일치 상세 ${part}`)!; }
        startSheet.spliceRows(startRow + 1, startSheet.rowCount - startRow);
        throw error;
      }
    },
    async download(): Promise<Blob> {
      book.eachSheet(ws => { ws.autoFilter = { from: 'A1', to: { row: ws.rowCount, column: ws.columnCount } }; });
      const bytes = await book.xlsx.writeBuffer();
      return new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    },
  };
}
