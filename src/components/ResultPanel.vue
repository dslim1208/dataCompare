<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CellValue from './CellValue.vue';
import { fetchResults, fetchRow } from '../services/duckdb/client';
import type { ColumnPair, CompareSummary, ResultRow, Status } from '../types/csv';
const props = defineProps<{ pairs: ColumnPair[]; summary: CompareSummary; busy: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const pageSize = 50;
const filters: { status: Status | undefined; label: string }[] = [
  { status: undefined, label: '전체' },
  { status: 'MATCH', label: 'MATCH' },
  { status: 'MODIFIED', label: 'MODIFIED' },
  { status: 'ADDED', label: 'ADDED' },
  { status: 'DELETED', label: 'DELETED' },
];
const filter = ref<Status>();
const page = ref(0);
const rows = ref<ResultRow[]>([]);
const selected = ref<ResultRow>();
const detail = ref<{ source: (string | null)[] | null; target: (string | null)[] | null }>();
const error = ref('');
const keys = computed(() => props.pairs.filter(pair => pair.key));
function count(status: Status | undefined) {
  const { match, modified, added, deleted } = props.summary;
  if (!status) return match + modified + added + deleted;
  return { MATCH: match, MODIFIED: modified, ADDED: added, DELETED: deleted }[status];
}
const pages = computed(() => Math.max(1, Math.ceil(count(filter.value) / pageSize)));
async function load() {
  selected.value = undefined;
  detail.value = undefined;
  error.value = '';
  emit('busy', true);
  try { rows.value = await fetchResults(props.pairs, filter.value, page.value, pageSize); }
  catch (cause) { rows.value = []; error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
// A new comparison resets the view to the first page of all rows.
watch(() => props.summary, () => { filter.value = undefined; page.value = 0; void load(); }, { immediate: true });
function choose(status: Status | undefined) {
  filter.value = status;
  page.value = 0;
  void load();
}
function go(next: number) {
  page.value = next;
  void load();
}
async function open(row: ResultRow) {
  selected.value = row;
  detail.value = undefined;
  error.value = '';
  emit('busy', true);
  try {
    detail.value = {
      source: row.sourceRow === null ? null : await fetchRow('source', props.pairs, row.sourceRow),
      target: row.targetRow === null ? null : await fetchRow('target', props.pairs, row.targetRow),
    };
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
function changedNames(row: ResultRow) {
  return row.changed.map(index => props.pairs[index]?.source).join(', ');
}
</script>

<template>
  <section class="results">
    <h3>비교 결과 목록</h3>
    <div class="filters" role="group" aria-label="상태 필터">
      <button v-for="item in filters" :key="item.label" type="button" :class="['secondary', { active: filter === item.status }]" :aria-pressed="filter === item.status" :disabled="busy" @click="choose(item.status)">{{ item.label }} ({{ count(item.status).toLocaleString('ko-KR') }})</button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="table-wrap"><table class="result-table">
      <thead><tr><th>상태</th><th v-for="pair in keys" :key="pair.source">{{ pair.source }}</th><th>변경 컬럼</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="`${row.sourceRow}-${row.targetRow}`" :class="{ selected: selected === row }" tabindex="0" @click="open(row)" @keydown.enter="open(row)">
          <td><span :class="['state', row.status.toLowerCase()]">{{ row.status }}</span></td>
          <td v-for="(value, index) in row.keys" :key="index"><CellValue :value="value"/></td>
          <td>{{ changedNames(row) }}</td>
        </tr>
      </tbody>
    </table></div>
    <p v-if="rows.length === 0 && !error" class="muted">해당 상태의 데이터가 없습니다.</p>
    <div class="pager">
      <button type="button" class="secondary" :disabled="busy || page === 0" @click="go(page - 1)">이전</button>
      <span>{{ (page + 1).toLocaleString('ko-KR') }} / {{ pages.toLocaleString('ko-KR') }} 페이지 · 페이지당 {{ pageSize }}건</span>
      <button type="button" class="secondary" :disabled="busy || page + 1 >= pages" @click="go(page + 1)">다음</button>
    </div>
    <template v-if="selected && detail">
      <h3>상세 비교 · KEY {{ selected.keys.map(value => value ?? 'NULL').join(' | ') }} <span :class="['state', selected.status.toLowerCase()]">{{ selected.status }}</span></h3>
      <div class="table-wrap"><table class="detail-table">
        <thead><tr><th>컬럼 (Source / Target)</th><th>SOURCE</th><th>TARGET</th></tr></thead>
        <tbody>
          <tr v-for="(pair, index) in pairs" :key="index" :class="{ changed: selected.changed.includes(index) }">
            <td>{{ pair.source === pair.target ? pair.source : `${pair.source} / ${pair.target}` }}<span v-if="pair.key" class="state">KEY</span></td>
            <td><span v-if="!detail.source" class="null">없음</span><CellValue v-else :value="detail.source[index]"/></td>
            <td><span v-if="!detail.target" class="null">없음</span><CellValue v-else :value="detail.target[index]"/></td>
          </tr>
        </tbody>
      </table></div>
    </template>
  </section>
</template>
