<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CellValue from './CellValue.vue';
import { fetchExpectedRow, fetchResults, fetchRow } from '../services/duckdb/client';
import type { ColumnPair, CompareSummary, ResultRow, Status } from '../types/csv';
const props = defineProps<{ pairs: ColumnPair[]; summary: CompareSummary; busy: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const pageSize = 50;
const filters: { status: Status | undefined; label: string; title: string }[] = [
  { status: undefined, label: '전체', title: '전체 결과' },
  { status: 'MATCH', label: 'MATCH', title: '일치' },
  { status: 'MODIFIED', label: 'MODIFIED', title: '변경' },
  { status: 'ADDED', label: 'ADDED', title: '추가' },
  { status: 'DELETED', label: 'DELETED', title: '삭제' },
];
const filter = ref<Status>();
const page = ref(0);
const rows = ref<ResultRow[]>([]);
const selected = ref<ResultRow>();
const detail = ref<{ source: (string | null)[] | null; target: (string | null)[] | null; expected?: (string | null)[] | null }>();
const error = ref('');
const hasExpressions = computed(() => props.pairs.some(pair => pair.rule === 'sql'));
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
      expected: hasExpressions.value && row.sourceRow !== null ? await fetchExpectedRow(props.pairs, row.sourceRow) : null,
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
    <h3>비교 결과 <small>카드를 선택하면 해당 결과만 표시됩니다.</small></h3>
    <div class="filters" role="group" aria-label="상태 필터">
      <button v-for="item in filters" :key="item.label" type="button" :class="['result-card', item.status?.toLowerCase(), { active: filter === item.status }]" :data-status="item.status" :aria-label="`${item.title} (${count(item.status).toLocaleString('ko-KR')})`" :aria-pressed="filter === item.status" :disabled="busy" @click="choose(item.status)"><span>{{ item.title }}</span><strong>{{ count(item.status).toLocaleString('ko-KR') }}</strong><small>{{ item.status || 'TOTAL' }}</small></button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="result-workspace">
      <div class="result-list">
        <h3>결과 목록 <small>행을 선택해 값을 비교하세요.</small></h3>
        <div class="table-wrap" tabindex="0" aria-label="비교 결과 목록"><table class="result-table">
          <thead><tr><th>상태</th><th v-for="pair in keys" :key="pair.source">{{ pair.source }}</th><th>변경 컬럼</th></tr></thead>
          <tbody>
            <tr v-for="row in rows" :key="`${row.sourceRow}-${row.targetRow}`" :class="{ selected: selected === row }" :tabindex="busy ? -1 : 0" :aria-selected="selected === row" @click="!busy && open(row)" @keydown.enter="!busy && open(row)" @keydown.space.prevent="!busy && open(row)">
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
      </div>
      <aside class="result-detail" aria-label="선택한 행 상세 비교" :aria-busy="!!selected && !detail && !error">
        <template v-if="selected && detail">
          <h3>상세 비교 · KEY {{ selected.keys.map(value => value ?? 'NULL').join(' | ') }} <span :class="['state', selected.status.toLowerCase()]">{{ selected.status }}</span></h3>
          <div class="table-wrap" tabindex="0" aria-label="컬럼별 상세 비교"><table class="detail-table">
            <thead><tr><th>컬럼 (Source / Target)</th><th>SOURCE</th><th v-if="hasExpressions">변환 기대값</th><th>TARGET</th></tr></thead>
            <tbody>
              <tr v-for="(pair, index) in pairs" :key="index" :class="{ changed: selected.changed.includes(index) }">
                <td>{{ pair.source === pair.target ? pair.source : `${pair.source} / ${pair.target}` }}<span v-if="pair.key" class="state">KEY</span><small v-if="pair.rule === 'sql'" :title="pair.expression">SQL 변환</small></td>
                <td><span v-if="!detail.source" class="null">없음</span><CellValue v-else :value="detail.source[index]"/></td>
                <td v-if="hasExpressions"><span v-if="!detail.expected" class="null">없음</span><CellValue v-else :value="detail.expected[index]"/></td>
                <td><span v-if="!detail.target" class="null">없음</span><CellValue v-else :value="detail.target[index]"/></td>
              </tr>
            </tbody>
          </table></div>
        </template>
        <div v-else class="detail-empty"><span aria-hidden="true">↔</span><h3>{{ selected ? '상세 정보를 불러오는 중입니다.' : '변경 전·후를 나란히 확인하세요' }}</h3><p class="muted">{{ selected ? '잠시만 기다려 주세요.' : '결과 목록에서 행을 선택하면 컬럼별 기준 값과 비교 값이 표시됩니다.' }}</p></div>
      </aside>
    </div>
  </section>
</template>
