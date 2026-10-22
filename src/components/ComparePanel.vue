<script setup lang="ts">
import { ref, watch } from 'vue';
import ResultPanel from './ResultPanel.vue';
import DownloadPanel from './DownloadPanel.vue';
import { compare } from '../services/duckdb/client';
import type { ColumnPair, CompareSummary } from '../types/csv';
const props = defineProps<{ pairs: ColumnPair[]; busy: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const summary = ref<CompareSummary>();
const error = ref('');
watch(() => props.pairs, () => { summary.value = undefined; error.value = ''; });
async function run() {
  summary.value = undefined;
  error.value = '';
  emit('busy', true);
  try { summary.value = await compare(props.pairs); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { emit('busy', false); }
}
const statuses = [
  { key: 'match', status: 'MATCH', label: '일치' },
  { key: 'modified', status: 'MODIFIED', label: '변경' },
  { key: 'added', status: 'ADDED', label: '추가' },
  { key: 'deleted', status: 'DELETED', label: '삭제' },
] as const;
</script>

<template>
  <section class="panel compare">
    <div class="panel-heading"><span class="tag">04</span><h2>비교 실행</h2></div>
    <p class="muted">KEY {{ pairs.filter(pair => pair.key).length }}개, 비교 컬럼 {{ pairs.filter(pair => !pair.key).length }}개 · 비교 규칙 적용 {{ pairs.filter(pair => pair.rule !== 'exact').length }}개 · 규칙이 '그대로'인 컬럼은 문자열 그대로 비교하며, NULL과 빈 문자열은 항상 다른 값으로 판정합니다.</p>
    <button type="button" :disabled="busy" @click="run">비교 실행</button>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="summary" class="metrics summary">
      <div data-status="SOURCE"><strong>{{ summary.sourceRows.toLocaleString('ko-KR') }}</strong><span>Source 전체</span></div>
      <div data-status="TARGET"><strong>{{ summary.targetRows.toLocaleString('ko-KR') }}</strong><span>Target 전체</span></div>
      <div v-for="item in statuses" :key="item.key" :data-status="item.status"><strong>{{ summary[item.key].toLocaleString('ko-KR') }}</strong><span>{{ item.label }} ({{ item.status }})</span></div>
    </div>
    <ResultPanel v-if="summary" :pairs="pairs" :summary="summary" :busy="busy" @busy="emit('busy', $event)"/>
    <DownloadPanel v-if="summary" :pairs="pairs" :summary="summary" :busy="busy" @busy="emit('busy', $event)"/>
  </section>
</template>
