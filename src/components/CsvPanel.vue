<script setup lang="ts">
import { ref } from 'vue';
import CellValue from './CellValue.vue';
import { clearCsv, loadCsv, resetTable, setSqlTableName, transformTable } from '../services/duckdb/client';
import type { CsvInfo, Side } from '../types/csv';
const props = defineProps<{ side: Side; ready: boolean; busy: boolean }>();
const emit = defineEmits<{ busy: [value: boolean]; loaded: [info: CsvInfo | undefined] }>();
const header = ref(true);
const selected = ref<File>();
const info = ref<CsvInfo>();
const error = ref('');
function defaultSql(name: string) { return `SELECT * FROM "${name}";`; }
const sql = ref(defaultSql(props.side));
let currentTableName: string = props.side;
const tableName = ref<string>(props.side);
const tableNameError = ref('');
function renameTable() {
  try {
    setSqlTableName(props.side, tableName.value);
    const name = tableName.value.trim();
    if (sql.value.trim() === defaultSql(currentTableName)) sql.value = defaultSql(name);
    currentTableName = name;
    tableNameError.value = '';
  }
  catch (cause) { tableNameError.value = cause instanceof Error ? cause.message : String(cause); }
}
const transformed = ref(false);
async function load() {
  info.value = undefined;
  transformed.value = false;
  emit('loaded', undefined);
  error.value = '';
  if (!selected.value) return;
  emit('busy', true);
  try {
    info.value = await loadCsv(props.side, selected.value, header.value);
    emit('loaded', info.value);
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
// Applies or reverts the SQL; on failure the current table is kept, so the previous info stays valid.
async function apply(revert: boolean) {
  if (!selected.value) return;
  error.value = '';
  emit('busy', true);
  try {
    const file = selected.value;
    info.value = revert ? await resetTable(props.side, file.name, file.size) : await transformTable(props.side, sql.value, file.name, file.size);
    transformed.value = !revert;
    emit('loaded', info.value);
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Clearing lets the same path be chosen again; a cancelled dialog keeps the current file.
  input.value = '';
  if (!file) return;
  selected.value = file;
  void load();
}
async function remove() {
  selected.value = undefined;
  info.value = undefined;
  transformed.value = false;
  error.value = '';
  emit('loaded', undefined);
  emit('busy', true);
  try { await clearCsv(props.side); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
function size(bytes: number) {
  return `${(bytes / 1024 / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} MB (${bytes.toLocaleString('ko-KR')} bytes)`;
}
</script>

<template>
  <section :class="['panel', 'csv-panel', side]">
    <div class="panel-heading"><span class="tag">{{ side === 'source' ? 'SOURCE' : 'TARGET' }}</span><h2>{{ side === 'source' ? '기준 파일' : '비교 파일' }}</h2></div>
    <p class="muted">{{ side === 'source' ? '비교 기준이 되는 원본 파일' : '원본과 비교할 대상 파일' }}</p>
    <div class="file-label"><span class="file-format"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>UTF-8 CSV 파일</span>
      <div class="picker">
        <label :class="['button', { disabled: !ready || busy }]">파일 선택<input class="sr-only" :aria-label="`${side} CSV 파일`" type="file" accept=".csv,text/csv" :disabled="!ready || busy" @change="choose"></label>
        <span v-if="selected" class="filename">{{ selected.name }} <span class="muted">· {{ size(selected.size) }}</span></span>
        <span v-else class="muted">선택된 파일 없음</span>
        <button v-if="selected" type="button" class="remove" :aria-label="`${side} 파일 제거`" title="파일 제거" :disabled="busy" @click="remove">×</button>
      </div>
    </div>
    <label class="checkbox"><input v-model="header" type="checkbox" :disabled="!ready || busy" @change="load"> 첫 번째 행을 컬럼명으로 사용</label>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <template v-if="info">
      <div class="metrics"><div><strong>{{ Number(info.rowCount).toLocaleString('ko-KR') }}</strong><span>데이터 행</span></div><div><strong>{{ info.columns.length }}</strong><span>컬럼 · 모두 VARCHAR</span></div></div>
      <p v-if="transformed" class="muted">SQL 가공 결과입니다. 비교·다운로드도 이 결과를 기준으로 합니다.</p>
      <details class="preview">
        <summary>컬럼 및 데이터 미리보기 <small>최대 20행</small></summary>
        <h3>컬럼 목록</h3>
        <div class="columns"><span v-for="column in info.columns" :key="column">{{ column }}</span></div>
        <h3>데이터 미리보기 <small>최대 20행</small></h3>
        <div class="table-wrap" tabindex="0" :aria-label="`${side} 데이터 미리보기`"><table><thead><tr><th v-for="column in info.columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="(row, index) in info.preview" :key="index"><td v-for="(value, col) in row" :key="col"><CellValue :value="value"/></td></tr></tbody></table></div>
        <p v-if="info.preview.length === 0" class="muted">데이터 행이 없습니다.</p>
      </details>
      <details class="sql" :open="transformed">
        <summary>SQL로 가공 <small>{{ transformed ? '적용됨' : '선택' }}</small></summary>
        <label class="table-name">SQL 테이블명<input v-model="tableName" :aria-label="`${side} SQL 테이블명`" :aria-invalid="!!tableNameError" :aria-describedby="tableNameError ? `${side}-table-error` : undefined" type="text" :placeholder="side" :disabled="!ready || busy" spellcheck="false" autocomplete="off" @input="renameTable"></label>
        <p v-if="tableNameError" :id="`${side}-table-error`" role="alert" class="error">{{ tableNameError }}</p>
        <p class="muted">불러온 데이터를 <code>{{ tableName.trim() || side }}</code> 테이블로 조회해 비교 대상을 바꿉니다. SQL 안의 <code>{{ tableName.trim() || side }}</code>는 항상 원본 CSV를 가리킵니다. 다른 쪽 테이블도 참조하거나 조인할 수 있으며, 그쪽의 현재 데이터(가공했다면 가공 결과)를 사용합니다.</p>
        <textarea v-model="sql" :aria-label="`${side} 가공 SQL`" rows="4" spellcheck="false" :placeholder="`SELECT * FROM &quot;${tableName.trim() || side}&quot; WHERE ...`" :disabled="busy"></textarea>
        <button type="button" :disabled="busy || !sql.trim() || !!tableNameError" @click="apply(false)">SQL 적용</button>
        <button v-if="transformed" type="button" class="secondary" :disabled="busy" @click="apply(true)">원본으로 되돌리기</button>
      </details>
    </template>
    <p v-else-if="!selected" class="empty">파일을 선택하면 구조와 미리보기가 표시됩니다.</p>
  </section>
</template>
