import type { ColumnPair } from '../../types/csv';

// Pairs columns whose names match case-insensitively; each column is used at most once.
export function autoMatch(source: string[], target: string[]): ColumnPair[] {
  const remaining = [...target];
  return source.flatMap(name => {
    const index = remaining.findIndex(candidate => candidate.toLowerCase() === name.toLowerCase());
    if (index < 0) return [];
    const [match] = remaining.splice(index, 1);
    return [{ source: name, target: match, key: false, rule: 'trim' as const }];
  });
}

export function mappingErrors(pairs: ColumnPair[]): string[] {
  const errors: string[] = [];
  if (!pairs.some(pair => pair.key)) errors.push('KEY 컬럼을 하나 이상 선택하세요.');
  if (pairs.some(pair => !pair.source || !pair.target)) errors.push('비어 있는 매핑이 있습니다.');
  pairs.forEach((pair, index) => {
    if (pair.rule === 'sql' && !pair.expression?.trim()) errors.push(`${index + 1}번 매핑의 SQL 변환식을 입력하세요.`);
  });
  for (const side of ['source', 'target'] as const) {
    const names = pairs.map(pair => pair[side]).filter(Boolean);
    const duplicated = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicated.length) errors.push(`${side === 'source' ? 'Source' : 'Target'} 컬럼이 중복 매핑되었습니다: ${[...new Set(duplicated)].join(', ')}`);
  }
  return errors;
}
