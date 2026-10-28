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
</script>

<template>
  <section class="panel compare">
    <div class="panel-heading"><span class="tag">03</span><h2>비교 및 결과</h2></div>
    <p class="muted">KEY {{ pairs.filter(pair => pair.key).length }}개, 비교 컬럼 {{ pairs.filter(pair => !pair.key).length }}개 · 기본(앞뒤 공백 무시) 외 규칙 {{ pairs.filter(pair => pair.rule !== 'trim').length }}개 · NULL과 빈 문자열은 항상 다른 값으로 판정합니다.</p>
    <button type="button" :disabled="busy" @click="run">비교 실행</button>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="summary" class="summary source-counts">
      <div data-status="SOURCE"><strong>{{ summary.sourceRows.toLocaleString('ko-KR') }}</strong><span>Source 전체</span></div>
      <div data-status="TARGET"><strong>{{ summary.targetRows.toLocaleString('ko-KR') }}</strong><span>Target 전체</span></div>
    </div>
    <ResultPanel v-if="summary" :pairs="pairs" :summary="summary" :busy="busy" @busy="emit('busy', $event)"/>
    <DownloadPanel v-if="summary" :pairs="pairs" :summary="summary" :busy="busy" @busy="emit('busy', $event)"/>
  </section>
</template>
