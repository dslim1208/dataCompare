export type Side = 'source' | 'target';
export interface CsvInfo {
  name: string;
  size: number;
  rowCount: string;
  columns: string[];
  preview: (string | null)[][];
}
export type CompareRule = 'exact' | 'trim' | 'number' | 'date' | 'datetime' | 'sql';
export interface ColumnPair {
  source: string;
  target: string;
  key: boolean;
  rule: CompareRule;
  expression?: string;
}
export interface KeyCheck {
  rowCount: number;
  nullRows: number;
  emptyRows: number;
  duplicateKeys: number;
  duplicateRows: number;
  samples: { values: (string | null)[]; count: number }[];
}
export interface CompareSummary {
  sourceRows: number;
  targetRows: number;
  match: number;
  modified: number;
  added: number;
  deleted: number;
}
export type Status = 'MATCH' | 'MODIFIED' | 'ADDED' | 'DELETED';
export interface ResultRow {
  status: Status;
  sourceRow: number | null;
  targetRow: number | null;
  changed: number[];
  keys: (string | null)[];
}
export type ExportKind = 'ALL' | 'ADDED' | 'DELETED' | 'MODIFIED';
