<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import CsvPanel from './components/CsvPanel.vue';
import MappingPanel from './components/MappingPanel.vue';
import ComparePanel from './components/ComparePanel.vue';
import { initialize, dispose } from './services/duckdb/client';
import type { ColumnPair, CsvInfo } from './types/csv';
const ready = ref(false);
const busy = ref(false);
const version = ref('');
const error = ref('');
const source = ref<CsvInfo>();
const target = ref<CsvInfo>();
const pairs = ref<ColumnPair[]>();
const step = computed(() => pairs.value ? 3 : source.value && target.value ? 2 : 1);
onMounted(async () => {
  try { version.value = await initialize(); ready.value = true; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
});
onBeforeUnmount(() => { dispose().catch(cause => console.error('DuckDB 정리 실패', cause)); });
</script>
<template>
  <main>
    <header><div><p class="eyebrow">LOCAL CSV WORKSPACE</p><h1>dataCompare</h1><p class="muted">CSV 데이터 비교 및 검증 도구</p></div><span class="badge">로컬 처리 · 외부 전송 없음</span></header>
    <nav aria-label="비교 진행 단계" class="steps">
      <ol><li v-for="(label, index) in ['파일 선택', '컬럼 매핑·검증', '비교 및 결과']" :key="label" :class="{ current: step === index + 1, complete: step > index + 1 }" :aria-current="step === index + 1 ? 'step' : undefined"><span>{{ step > index + 1 ? '✓' : `0${index + 1}` }}</span>{{ label }}</li></ol>
    </nav>
    <div role="status" :class="['status', { error }]">{{ error ? `DuckDB 초기화 실패: ${error}` : !ready ? 'DuckDB 엔진을 준비하고 있습니다…' : busy ? '처리 중입니다. 대용량 파일은 시간이 걸릴 수 있습니다…' : `DuckDB ${version} 준비 완료` }}</div>
    <div class="grid"><CsvPanel side="source" :ready="ready" :busy="busy" @busy="busy = $event" @loaded="source = $event; pairs = undefined"/><CsvPanel side="target" :ready="ready" :busy="busy" @busy="busy = $event" @loaded="target = $event; pairs = undefined"/></div>
    <MappingPanel v-if="source && target" :source="source" :target="target" :busy="busy" @busy="busy = $event" @validated="pairs = $event"/>
    <ComparePanel v-if="source && target && pairs" :pairs="pairs" :busy="busy" @busy="busy = $event"/>
    <footer>UTF-8 · 쉼표 구분 CSV · 모든 값은 문자열로 보존 · 비인용 빈 필드 = NULL / 인용된 빈 필드 = 빈 문자열</footer>
  </main>
</template>
