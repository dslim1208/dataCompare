import type { ColumnPair, CompareRule } from '../../types/csv';
import { mappingErrors } from './mapping';

export interface MappingTemplate {
  type: 'data-migration-validation-mapping';
  version: 1;
  name: string;
  pairs: ColumnPair[];
}

const rules: CompareRule[] = ['exact', 'trim', 'number', 'date', 'datetime', 'sql'];

export function parseTemplate(text: string): MappingTemplate {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('JSON 형식이 올바르지 않습니다. 저장한 템플릿 파일을 선택하세요.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('비교 기준 템플릿 파일이 아닙니다.');
  const data = value as Record<string, unknown>;
  if (data.type !== 'data-migration-validation-mapping') throw new Error('비교 기준 템플릿 파일이 아닙니다.');
  if (data.version !== 1) throw new Error('지원하지 않는 템플릿 버전입니다.');
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100) throw new Error('템플릿 이름은 1~100자로 지정하세요.');
  if (!Array.isArray(data.pairs) || !data.pairs.length) throw new Error('템플릿에 컬럼 매핑이 없습니다.');
  const pairs: ColumnPair[] = data.pairs.map((value: unknown, index: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${index + 1}번 매핑 형식이 올바르지 않습니다.`);
    const pair = value as Record<string, unknown>;
    if (typeof pair.source !== 'string' || !pair.source || typeof pair.target !== 'string' || !pair.target || typeof pair.key !== 'boolean' || !rules.includes(pair.rule as CompareRule)) throw new Error(`${index + 1}번 매핑의 컬럼·KEY·비교 규칙을 확인하세요.`);
    if (pair.rule === 'sql' && (typeof pair.expression !== 'string' || !pair.expression.trim())) throw new Error(`${index + 1}번 매핑의 SQL 변환식이 없습니다.`);
    return { source: pair.source, target: pair.target, key: pair.key, rule: pair.rule as CompareRule, ...(pair.rule === 'sql' ? { expression: pair.expression as string } : {}) };
  });
  const errors = mappingErrors(pairs);
  if (errors.length) throw new Error(errors.join('\n'));
  return { type: 'data-migration-validation-mapping', version: 1, name: data.name.trim(), pairs };
}

export function assertTemplateColumns(template: MappingTemplate, source: string[], target: string[]): void {
  const missingSource = [...new Set(template.pairs.filter(pair => !source.includes(pair.source)).map(pair => pair.source))];
  const missingTarget = [...new Set(template.pairs.filter(pair => !target.includes(pair.target)).map(pair => pair.target))];
  const errors = [missingSource.length ? `Source에 없는 컬럼: ${missingSource.join(', ')}` : '', missingTarget.length ? `Target에 없는 컬럼: ${missingTarget.join(', ')}` : ''].filter(Boolean);
  if (errors.length) throw new Error(`현재 파일에 템플릿을 적용할 수 없습니다.\n${errors.join('\n')}\n기존 설정은 유지됩니다.`);
}
