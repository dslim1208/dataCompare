<script setup lang="ts">
import { ref } from 'vue';
import { exportCsv } from '../services/duckdb/client';
import type { ColumnPair, CompareSummary, ExportKind } from '../types/csv';
const props = defineProps<{ pairs: ColumnPair[]; summary: CompareSummary; busy: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const error = ref('');
const items: { kind: ExportKind; label: string; description: string }[] = [
  { kind: 'ALL', label: '전체 결과', description: '상태, KEY, 변경 컬럼, 컬럼별 Source/Target 값' },
  { kind: 'ADDED', label: '추가 데이터', description: 'Target에만 있는 원본 행 전체' },
  { kind: 'DELETED', label: '삭제 데이터', description: 'Source에만 있는 원본 행 전체' },
  { kind: 'MODIFIED', label: '변경 데이터', description: 'KEY, 컬럼명, Source 값, Target 값 (변경 컬럼당 1행)' },
];
function count(kind: ExportKind) {
  const { match, modified, added, deleted } = props.summary;
  return { ALL: match + modified + added + deleted, ADDED: added, DELETED: deleted, MODIFIED: modified }[kind];
}
function timestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
async function download(kind: ExportKind) {
  error.value = '';
  emit('busy', true);
  try {
    const csv = await exportCsv(props.pairs, kind);
    // UTF-8 BOM so Excel opens Korean text correctly; other CSV tools ignore it.
    const url = URL.createObjectURL(new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `dataCompare_${kind}_${timestamp()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
</script>

<template>
  <section class="downloads">
    <h3>결과 다운로드 <small>UTF-8 CSV (Excel 호환 BOM 포함)</small></h3>
    <div class="download-list">
      <div v-for="item in items" :key="item.kind">
        <button type="button" :disabled="busy || count(item.kind) === 0" @click="download(item.kind)">{{ item.label }} ({{ count(item.kind).toLocaleString('ko-KR') }})</button>
        <span class="muted">{{ item.description }}</span>
      </div>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
  </section>
</template>
