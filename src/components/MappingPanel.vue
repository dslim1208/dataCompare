<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { validateKeys } from '../services/duckdb/client';
import { autoMatch, mappingErrors } from '../services/comparison/mapping';
import type { ColumnPair, CompareRule, CsvInfo, KeyCheck, Side } from '../types/csv';
const props = defineProps<{ source: CsvInfo; target: CsvInfo; busy: boolean }>();
const emit = defineEmits<{ busy: [value: boolean]; validated: [pairs: ColumnPair[] | undefined] }>();
const pairs = ref<ColumnPair[]>([]);
const checks = ref<Record<Side, KeyCheck>>();
const error = ref('');
const sides: Side[] = ['source', 'target'];
// A newly loaded file invalidates the whole mapping.
watch(() => [props.source, props.target], () => { pairs.value = autoMatch(props.source.columns, props.target.columns); }, { immediate: true });
// Any mapping change invalidates the previous validation result.
watch(pairs, () => { checks.value = undefined; error.value = ''; emit('validated', undefined); }, { deep: true });
const errors = computed(() => mappingErrors(pairs.value));
const unmapped = computed(() => ({
  source: props.source.columns.filter(name => !pairs.value.some(pair => pair.source === name)),
  target: props.target.columns.filter(name => !pairs.value.some(pair => pair.target === name)),
}));
const passed = computed(() => checks.value && sides.every(side => {
  const check = checks.value![side];
  return check.nullRows === 0 && check.emptyRows === 0 && check.duplicateKeys === 0;
}));
function add() {
  pairs.value.push({ source: unmapped.value.source[0] ?? '', target: unmapped.value.target[0] ?? '', key: false, rule: 'trim' });
}
async function validate() {
  error.value = '';
  emit('busy', true);
  try {
    const keys = pairs.value.filter(pair => pair.key);
    const source = await validateKeys('source', keys.map(pair => ({ name: pair.source, rule: pair.rule })));
    const target = await validateKeys('target', keys.map(pair => ({ name: pair.target, rule: pair.rule })));
    checks.value = { source, target };
    if (passed.value) emit('validated', pairs.value.map(pair => ({ ...pair })));
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
const ruleOptions: { value: CompareRule; label: string }[] = [
  { value: 'trim', label: '앞뒤 공백 무시 (기본)' },
  { value: 'exact', label: '그대로' },
  { value: 'number', label: '숫자 (콤마 무시)' },
  { value: 'date', label: '날짜 (- . / 무시, 시간 무시)' },
  { value: 'datetime', label: '일시 (날짜+시간, 초까지)' },
];
function display(values: (string | null)[]) {
  return values.map(value => value ?? 'NULL').join(' | ');
}
</script>

<template>
  <section class="panel mapping">
    <div class="panel-heading"><span class="tag">02</span><h2>KEY 및 비교 컬럼 매핑</h2></div>
    <p class="muted">같은 이름의 컬럼은 자동으로 연결됩니다. 비교 기준 KEY를 하나 이상 선택하세요.</p>
    <details class="mapping-help"><summary>KEY와 비교 규칙 안내</summary><p class="muted">같은 이름은 대소문자를 구분하지 않습니다. KEY를 여러 개 선택하면 복합 KEY가 됩니다. 기본 규칙은 앞뒤 공백 무시이며, 공백까지 구분하려면 “그대로”를 고르세요. 규칙은 비교할 때만 적용되고 화면과 다운로드에는 원본 값이 표시됩니다.</p></details>
    <div class="table-wrap"><table>
      <thead><tr><th>KEY</th><th>Source 컬럼</th><th>Target 컬럼</th><th>비교 규칙</th><th></th></tr></thead>
      <tbody>
        <tr v-for="(pair, index) in pairs" :key="index">
          <td><input v-model="pair.key" type="checkbox" :aria-label="`${index + 1}번 매핑 KEY`" :disabled="busy"></td>
          <td><select v-model="pair.source" :aria-label="`${index + 1}번 Source 컬럼`" :disabled="busy"><option v-for="name in source.columns" :key="name" :value="name">{{ name }}</option></select></td>
          <td><select v-model="pair.target" :aria-label="`${index + 1}번 Target 컬럼`" :disabled="busy"><option v-for="name in target.columns" :key="name" :value="name">{{ name }}</option></select></td>
          <td><select v-model="pair.rule" :aria-label="`${index + 1}번 비교 규칙`" :disabled="busy"><option v-for="option in ruleOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></td>
          <td><button type="button" class="secondary" :disabled="busy" @click="pairs.splice(index, 1)">삭제</button></td>
        </tr>
      </tbody>
    </table></div>
    <p v-if="pairs.length === 0" class="muted">자동으로 연결된 컬럼이 없습니다. 매핑을 추가하세요.</p>
    <button type="button" class="secondary" :disabled="busy" @click="add">+ 매핑 추가</button>
    <p v-if="unmapped.source.length || unmapped.target.length" class="muted">
      비교에서 제외되는 컬럼 — Source: {{ unmapped.source.join(', ') || '없음' }} / Target: {{ unmapped.target.join(', ') || '없음' }}
    </p>
    <ul v-if="errors.length" class="error"><li v-for="message in errors" :key="message">{{ message }}</li></ul>
    <button type="button" :disabled="busy || errors.length > 0" @click="validate">KEY 검증</button>
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
