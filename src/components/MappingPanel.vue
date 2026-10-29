<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import CellValue from './CellValue.vue';
import * as defaultClient from '../services/duckdb/client';
import type { DuckDbClient } from '../services/duckdb/client';
import { autoMatch, mappingErrors } from '../services/comparison/mapping';
import { assertTemplateColumns, parseTemplate } from '../services/comparison/template';
import type { ColumnPair, CompareRule, CsvInfo, KeyCheck, Side } from '../types/csv';
const props = defineProps<{ source: CsvInfo; target: CsvInfo; busy: boolean; client?: DuckDbClient; initialPairs?: ColumnPair[]; initialTemplateName?: string }>();
const emit = defineEmits<{ busy: [value: boolean]; changed: [pairs: ColumnPair[]]; templateNameChanged: [name: string]; validated: [pairs: ColumnPair[] | undefined] }>();
const inputPrefix = useId();
const pairs = ref<ColumnPair[]>([]);
const checks = ref<Record<Side, KeyCheck>>();
const error = ref('');
const templateError = ref('');
const templateNotice = ref('');
function defaultTemplateName() { return `${props.source.name.replace(/\.csv$/i, '').slice(0, 80)} 비교 기준`; }
const templateName = ref(props.initialTemplateName || defaultTemplateName());
const maxTemplateSize = 1024 * 1024;
const previews = ref<Record<number, { rows?: { original: string | null; expected: string | null }[]; error?: string }>>({});
const sides: Side[] = ['source', 'target'];
// A newly loaded file invalidates the whole mapping.
watch(() => [props.source, props.target], () => {
  checks.value = undefined;
  previews.value = {};
  templateError.value = ''; templateNotice.value = '';
  templateName.value = props.initialTemplateName || defaultTemplateName();
  pairs.value = props.initialPairs?.map(pair => ({ ...pair })) ?? autoMatch(props.source.columns, props.target.columns);
}, { immediate: true });
// Only non-KEY rule changes can reuse KEY checks; always replace the comparison snapshot.
watch(() => pairs.value.map(pair => ({ ...pair })), (current, previous) => {
  if (current.length !== previous.length || current.some((pair, index) => {
    const old = previous[index];
    return pair.source !== old.source || pair.target !== old.target || pair.key !== old.key || (pair.key && (pair.rule !== old.rule || (pair.rule === 'sql' && pair.expression !== old.expression)));
  })) checks.value = undefined;
  current.forEach((pair, index) => {
    const old = previous[index];
    if (!old || pair.source !== old.source || pair.rule !== old.rule || pair.expression !== old.expression) delete previews.value[index];
  });
  error.value = '';
  emit('changed', current);
  publish();
});
const errors = computed(() => mappingErrors(pairs.value));
const unmapped = computed(() => ({
  source: props.source.columns.filter(name => !pairs.value.some(pair => pair.source === name)),
  target: props.target.columns.filter(name => !pairs.value.some(pair => pair.target === name)),
}));
const passed = computed(() => checks.value && sides.every(side => {
  const check = checks.value![side];
  return check.nullRows === 0 && check.emptyRows === 0 && check.duplicateKeys === 0;
}));
const expressionsReady = computed(() => pairs.value.every((pair, index) => pair.rule !== 'sql' || !!previews.value[index]?.rows));
function publish() {
  emit('validated', passed.value && errors.value.length === 0 && expressionsReady.value ? pairs.value.map(pair => ({ ...pair })) : undefined);
}
async function preview(index: number) {
  emit('busy', true);
  try { previews.value[index] = { rows: await (props.client ?? defaultClient).previewExpression(pairs.value[index]) }; }
  catch (cause) { previews.value[index] = { error: cause instanceof Error ? cause.message : String(cause) }; }
  finally { emit('busy', false); publish(); }
}
function example(pair: ColumnPair) {
  return `'C' || SUBSTR("${pair.source.replaceAll('"', '""')}", 2)`;
}
function add() {
  pairs.value.push({ source: unmapped.value.source[0] ?? '', target: unmapped.value.target[0] ?? '', key: false, rule: 'trim' });
}
async function validate() {
  error.value = '';
  emit('busy', true);
  try {
    const keys = pairs.value.filter(pair => pair.key);
    const source = await (props.client ?? defaultClient).validateKeys('source', keys.map(pair => ({ name: pair.source, rule: pair.rule, expression: pair.expression })));
    const target = await (props.client ?? defaultClient).validateKeys('target', keys.map(pair => ({ name: pair.target, rule: pair.rule })));
    checks.value = { source, target };
    publish();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
const ruleOptions: { value: CompareRule; label: string }[] = [
  { value: 'trim', label: '앞뒤 공백 무시 (기본)' },
  { value: 'exact', label: '그대로' },
  { value: 'number', label: '숫자 (콤마 무시)' },
  { value: 'date', label: '날짜 (- . / 무시, 시간 무시)' },
  { value: 'datetime', label: '일시 (날짜+시간, 초까지)' },
  { value: 'sql', label: '사용자 정의 SQL 식' },
];
function display(values: (string | null)[]) {
  return values.map(value => value ?? 'NULL').join(' | ');
}
function saveTemplate() {
  templateError.value = ''; templateNotice.value = '';
  const filename = window.prompt('템플릿 파일명을 입력하세요. (.json 확장자는 자동으로 붙습니다.)', `${templateName.value}.json`);
  if (filename === null) return;
  try {
    const enteredName = filename.trim().replace(/\.json$/i, '').trim();
    if (!enteredName) throw new Error('템플릿 파일명을 입력하세요.');
    const template = parseTemplate(JSON.stringify({ type: 'data-migration-validation-mapping', version: 1, name: enteredName, pairs: pairs.value }));
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json;charset=utf-8' });
    if (blob.size > 1024 * 1024) throw new Error('템플릿은 1MB 이하만 저장할 수 있습니다. SQL 변환식의 길이를 줄이세요.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `${template.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    templateName.value = template.name;
    emit('templateNameChanged', template.name);
    templateNotice.value = '현재 비교 기준을 템플릿으로 저장했습니다.';
  } catch (cause) { templateError.value = cause instanceof Error ? cause.message : String(cause); }
}
async function loadTemplate(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  templateError.value = ''; templateNotice.value = '';
  emit('busy', true);
  try {
    if (file.size > maxTemplateSize) throw new Error('템플릿 파일은 1MB 이하만 지원합니다. CSV가 아닌 JSON 템플릿을 선택하세요.');
    const template = parseTemplate(await file.text());
    assertTemplateColumns(template, props.source.columns, props.target.columns);
    // A template is configuration only. Never carry checks or results over to the current data.
    checks.value = undefined; previews.value = {}; error.value = '';
    emit('validated', undefined);
    pairs.value = template.pairs;
    templateName.value = template.name;
    emit('templateNameChanged', template.name);
    templateNotice.value = `‘${template.name}’ 템플릿을 적용했습니다. 현재 데이터의 KEY와 SQL 변환식을 다시 검증하세요.`;
  } catch (cause) { templateError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
</script>

<template>
  <section class="panel mapping">
    <div class="panel-heading"><span class="tag">02</span><h2>KEY 및 비교 컬럼 매핑</h2></div>
    <p class="muted">같은 이름의 컬럼은 자동으로 연결됩니다. 비교 기준 KEY를 하나 이상 선택하세요.</p>
    <p v-if="templateError" role="alert" class="error">{{ templateError }}</p>
    <p v-if="templateNotice" role="status" class="template-notice">{{ templateNotice }}</p>
    <details class="mapping-help"><summary>KEY와 비교 규칙 안내</summary><p class="muted">같은 이름은 대소문자를 구분하지 않습니다. KEY를 여러 개 선택하면 복합 KEY가 됩니다. 기본 규칙은 앞뒤 공백 무시이며, 공백까지 구분하려면 “그대로”를 고르세요. 규칙은 비교할 때만 적용되며 원본 값은 보존됩니다. 사용자 정의 SQL 식은 Source 변환 기대값을 Target과 비교하고 상세 결과에 기대값을 함께 표시합니다.</p></details>
    <div class="table-wrap">
      <div class="mapping-grid-toolbar"><span>{{ pairs.length }}개 컬럼 연결</span><div class="mapping-template-actions"><button type="button" class="secondary" :disabled="busy || errors.length > 0" @click="saveTemplate">템플릿 저장</button><label :class="['button', { disabled: busy }]">템플릿 불러오기<input class="sr-only" type="file" accept=".json,application/json" aria-label="비교 기준 템플릿 파일" :disabled="busy" @change="loadTemplate"></label></div></div>
      <table>
      <thead><tr><th>KEY</th><th>Source 컬럼</th><th>Target 컬럼</th><th>비교 규칙</th><th></th></tr></thead>
      <tbody>
        <template v-for="(pair, index) in pairs" :key="index">
        <tr>
          <td><input v-model="pair.key" type="checkbox" :aria-label="`${index + 1}번 매핑 KEY`" :disabled="busy"></td>
          <td><select v-model="pair.source" :aria-label="`${index + 1}번 Source 컬럼`" :disabled="busy"><option v-for="name in source.columns" :key="name" :value="name">{{ name }}</option></select></td>
          <td><select v-model="pair.target" :aria-label="`${index + 1}번 Target 컬럼`" :disabled="busy"><option v-for="name in target.columns" :key="name" :value="name">{{ name }}</option></select></td>
          <td><select v-model="pair.rule" :aria-label="`${index + 1}번 비교 규칙`" :disabled="busy"><option v-for="option in ruleOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></td>
          <td><button type="button" class="secondary" :disabled="busy" @click="pairs.splice(index, 1)">삭제</button></td>
        </tr>
        <tr v-if="pair.rule === 'sql'" class="expression-row"><td colspan="5">
          <label :for="`${inputPrefix}-expression-${index}`">Source 변환식 <small>Source 컬럼을 사용하는 식만 입력 · 문자열 연결은 ||</small></label>
          <div class="expression-input"><textarea :id="`${inputPrefix}-expression-${index}`" v-model="pair.expression" :aria-label="`${index + 1}번 SQL 변환식`" :aria-invalid="!!previews[index]?.error" :aria-describedby="`${inputPrefix}-expression-state-${index}`" :placeholder="example(pair)" rows="2" spellcheck="false" :disabled="busy"></textarea><button type="button" class="secondary" :disabled="busy || !pair.expression?.trim()" :aria-label="`${index + 1}번 변환 미리보기`" @click="preview(index)">변환식 확인</button></div>
          <p v-if="previews[index]?.error" :id="`${inputPrefix}-expression-state-${index}`" role="alert" class="error">{{ previews[index].error }}</p>
          <template v-else-if="previews[index]?.rows">
            <p :id="`${inputPrefix}-expression-state-${index}`" class="muted">전체 Source 행 계산 확인 완료 · 앞 5행 미리보기 · {{ pair.key ? '변환된 KEY로 검증·연결합니다.' : '기대값과 Target 값을 그대로 비교합니다.' }}</p>
            <table class="expression-preview" :aria-label="`${index + 1}번 변환 미리보기 결과`"><thead><tr><th>Source 원본값</th><th>변환 기대값</th></tr></thead><tbody><tr v-for="(row, rowIndex) in previews[index].rows" :key="rowIndex"><td><CellValue :value="row.original"/></td><td><CellValue :value="row.expected"/></td></tr></tbody></table>
          </template>
          <p v-else :id="`${inputPrefix}-expression-state-${index}`" class="muted">변환식을 입력한 뒤 ‘변환식 확인’을 눌러야 비교할 수 있습니다. SUBSTR, CASE, REGEXP_REPLACE 등을 사용할 수 있습니다.</p>
        </td></tr>
        </template>
      </tbody>
    </table></div>
    <p v-if="pairs.length === 0" class="muted">자동으로 연결된 컬럼이 없습니다. 매핑을 추가하세요.</p>
    <button type="button" class="secondary" :disabled="busy" @click="add">+ 매핑 추가</button>
    <p v-if="unmapped.source.length || unmapped.target.length" class="muted">
      비교에서 제외되는 컬럼 — Source: {{ unmapped.source.join(', ') || '없음' }} / Target: {{ unmapped.target.join(', ') || '없음' }}
    </p>
    <ul v-if="errors.length" class="error"><li v-for="message in errors" :key="message">{{ message }}</li></ul>
    <button type="button" :disabled="busy || errors.length > 0 || !expressionsReady" @click="validate">KEY 검증</button>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <template v-if="checks">
      <div class="grid">
        <div v-for="side in sides" :key="side" class="check">
          <h3>{{ side === 'source' ? 'Source' : 'Target' }} KEY 검증</h3>
          <ul>
            <li>전체 행: {{ checks[side].rowCount.toLocaleString('ko-KR') }}</li>
            <li :class="{ fail: checks[side].nullRows }">NULL KEY 행: {{ checks[side].nullRows.toLocaleString('ko-KR') }}</li>
            <li :class="{ fail: checks[side].emptyRows }">빈 문자열 KEY 행: {{ checks[side].emptyRows.toLocaleString('ko-KR') }}</li>
            <li :class="{ fail: checks[side].duplicateKeys }">중복 KEY: {{ checks[side].duplicateKeys.toLocaleString('ko-KR') }}개 ({{ checks[side].duplicateRows.toLocaleString('ko-KR') }}행)</li>
          </ul>
          <template v-if="checks[side].samples.length">
            <p class="muted">중복 KEY 예시 (최대 10개)</p>
            <ul class="samples"><li v-for="(sample, index) in checks[side].samples" :key="index">{{ display(sample.values) }} · {{ sample.count }}건</li></ul>
          </template>
        </div>
      </div>
      <p role="status" :class="passed ? 'ok' : 'error'">{{ passed ? 'KEY 검증 통과 · 아래에서 비교를 실행하세요.' : 'KEY 검증 실패 · NULL, 빈 문자열, 중복 KEY를 정리하거나 다른 KEY를 선택하세요.' }}</p>
    </template>
  </section>
</template>
