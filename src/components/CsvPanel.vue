<script setup lang="ts">
import { ref } from 'vue';
import CellValue from './CellValue.vue';
import { clearCsv, loadCsv } from '../services/duckdb/client';
import type { CsvInfo, Side } from '../types/csv';
const props = defineProps<{ side: Side; ready: boolean; busy: boolean }>();
const emit = defineEmits<{ busy: [value: boolean]; loaded: [info: CsvInfo | undefined] }>();
const header = ref(true);
const selected = ref<File>();
const info = ref<CsvInfo>();
const error = ref('');
async function load() {
  info.value = undefined;
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
  <section class="panel">
    <div class="panel-heading"><span class="tag">{{ side === 'source' ? '01' : '02' }}</span><h2>{{ side === 'source' ? 'Source CSV' : 'Target CSV' }}</h2></div>
    <p class="muted">{{ side === 'source' ? '비교 기준이 되는 원본 파일' : '원본과 비교할 대상 파일' }}</p>
    <div class="file-label">UTF-8 CSV 파일 선택
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
      <h3>컬럼 목록</h3>
      <div class="columns"><span v-for="column in info.columns" :key="column">{{ column }}</span></div>
      <h3>데이터 미리보기 <small>최대 20행</small></h3>
      <div class="table-wrap" tabindex="0" :aria-label="`${side} 데이터 미리보기`"><table><thead><tr><th v-for="column in info.columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="(row, index) in info.preview" :key="index"><td v-for="(value, col) in row" :key="col"><CellValue :value="value"/></td></tr></tbody></table></div>
      <p v-if="info.preview.length === 0" class="muted">데이터 행이 없습니다.</p>
    </template>
    <p v-else-if="!selected" class="empty">파일을 선택하면 구조와 미리보기가 표시됩니다.</p>
  </section>
</template>
