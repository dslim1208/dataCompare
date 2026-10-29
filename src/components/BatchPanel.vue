<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import MappingPanel from './MappingPanel.vue';
import { createClient } from '../services/duckdb/client';
import { autoMatch, mappingErrors } from '../services/comparison/mapping';
import { createBatchReport } from '../services/comparison/batchExcel';
import type { ColumnPair, CompareSummary, CsvInfo, Side } from '../types/csv';

interface Job {
  id: number; name: string; source?: File; target?: File;
  sourceHeader: boolean; targetHeader: boolean; pairs?: ColumnPair[];
  status: string; error: string; result?: CompareSummary; templateName?: string;
}
const client = createClient();
const emit = defineEmits<{ busy: [value: boolean] }>();
let initialized = false;
let sequence = 0;
const jobs = ref<Job[]>([]);
const busy = ref(false);
watch(busy, value => emit('busy', value));
const progress = ref('');
const error = ref('');
const activeId = ref<number>();
const editor = ref<HTMLDialogElement>();
const editorName = ref('');
const sourceInfo = shallowRef<CsvInfo>();
const targetInfo = shallowRef<CsvInfo>();
const resultBlob = shallowRef<Blob>();
const stopRequested = ref(false);
const completed = ref(0);
const active = computed(() => jobs.value.find(job => job.id === activeId.value));
const runnable = computed(() => jobs.value.length > 0 && jobs.value.every(job => job.source && job.target && job.pairs && !mappingErrors(job.pairs).length));
function add() {
  jobs.value.push({ id: ++sequence, name: `검증 ${sequence}`, sourceHeader: true, targetHeader: true, status: '파일 선택', error: '' });
  resultBlob.value = undefined;
}
add();
function invalidate(job: Job, filesChanged = false) {
  resultBlob.value = undefined;
  progress.value = '';
  job.error = ''; job.result = undefined; job.status = '설정 필요';
  if (filesChanged) {
    job.pairs = undefined;
    job.templateName = undefined;
    if (activeId.value === job.id) { activeId.value = undefined; sourceInfo.value = undefined; targetInfo.value = undefined; }
  }
}
function choose(job: Job, side: Side, event: Event) {
  job[side] = (event.target as HTMLInputElement).files?.[0];
  invalidate(job, true);
}
async function ensureReady() { if (!initialized) { await client.initialize(); initialized = true; } }
async function load(job: Job) {
  await ensureReady();
  await client.clearCsv('source'); await client.clearCsv('target');
  const source = await client.loadCsv('source', job.source!, job.sourceHeader);
  const target = await client.loadCsv('target', job.target!, job.targetHeader);
  return { source, target };
}
async function configure(job: Job) {
  if (busy.value) return;
  busy.value = true; error.value = ''; progress.value = `${job.name} · 컬럼을 불러오는 중…`;
  activeId.value = undefined;
  sourceInfo.value = undefined; targetInfo.value = undefined;
  editorName.value = job.name;
  editor.value?.showModal();
  try {
    const info = await load(job);
    job.pairs ??= autoMatch(info.source.columns, info.target.columns);
    sourceInfo.value = info.source; targetInfo.value = info.target;
    activeId.value = job.id; job.status = mappingErrors(job.pairs).length ? '설정 필요' : '준비';
  } catch (cause) { job.error = message(cause); job.status = '실패'; error.value = `${job.name}: ${job.error}`; }
  finally { busy.value = false; progress.value = ''; }
}
function closeEditor() {
  if (busy.value) return;
  editor.value?.close();
  activeId.value = undefined;
  sourceInfo.value = undefined; targetInfo.value = undefined;
}
function update(pairs: ColumnPair[]) {
  if (!active.value) return;
  invalidate(active.value);
  active.value.pairs = pairs.map(pair => ({ ...pair }));
  active.value.status = mappingErrors(pairs).length ? '설정 필요' : '준비';
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
async function run() {
  if (!runnable.value || busy.value) return;
  busy.value = true; error.value = ''; resultBlob.value = undefined;
  activeId.value = undefined; sourceInfo.value = undefined; targetInfo.value = undefined;
  completed.value = 0; stopRequested.value = false;
  for (const job of jobs.value) { job.status = '대기'; job.result = undefined; job.error = ''; }
  const report = createBatchReport();
  try {
    for (const job of jobs.value) {
      if (stopRequested.value) {
        job.status = '중단'; job.error = '사용자 요청으로 실행하지 않았습니다.';
        report.criteria(job.name, job.sourceHeader, job.targetHeader, job.pairs!);
        report.summary(job.name, job.source!.name, job.target!.name, undefined, job.error, '중단');
        continue;
      }
      job.status = '검증 중'; progress.value = `${completed.value + 1} / ${jobs.value.length} · ${job.name} 검증 중…`;
      try {
        report.criteria(job.name, job.sourceHeader, job.targetHeader, job.pairs!);
        await load(job);
        const keys = job.pairs!.filter(pair => pair.key);
        for (const side of ['source', 'target'] as const) {
          const check = await client.validateKeys(side, keys.map(pair => ({ name: pair[side], rule: pair.rule, expression: side === 'source' ? pair.expression : undefined })));
          if (check.nullRows || check.emptyRows || check.duplicateKeys) throw new Error(`${side === 'source' ? 'Source' : 'Target'} KEY 오류: NULL ${check.nullRows}행, 빈 문자열 ${check.emptyRows}행, 중복 ${check.duplicateKeys}개 (${check.duplicateRows}행)`);
        }
        const result = await client.compare(job.pairs!);
        await report.details(job.name, job.pairs!, client);
        job.result = result; job.status = '완료';
      } catch (cause) { job.status = '실패'; job.error = message(cause); }
      report.summary(job.name, job.source!.name, job.target!.name, job.result, job.error);
      completed.value++;
    }
    progress.value = 'Excel 파일을 생성하는 중…';
    resultBlob.value = await report.download();
    progress.value = stopRequested.value ? '중단 요청을 반영했습니다. 처리 내역을 Excel에서 확인하세요.' : `${jobs.value.length}개 작업 처리 완료 · 실패 ${jobs.value.filter(job => job.status === '실패').length}개`;
  } catch (cause) { error.value = `Excel 생성 실패: ${message(cause)}`; }
  finally {
    await client.clearCsv('source').catch(() => {}); await client.clearCsv('target').catch(() => {});
    busy.value = false;
  }
}
function download() {
  if (!resultBlob.value) return;
  const url = URL.createObjectURL(resultBlob.value);
  const a = document.createElement('a'); a.href = url;
  a.download = `데이터_이행_검증_일괄결과_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onBeforeUnmount(() => { client.dispose().catch(console.error); });
</script>

<template>
  <div class="batch-workspace" :aria-busy="busy">
    <section class="panel">
      <div class="batch-toolbar"><div><h2>파일 쌍 일괄 검증</h2><p class="muted">파일 쌍별로 KEY와 비교 규칙을 설정한 뒤 한 번에 검증하세요. 결과는 하나의 Excel 파일로 받습니다.</p></div><button class="secondary" :disabled="busy" @click="add">+ 파일 쌍 추가</button></div>
      <div class="table-wrap"><table class="batch-jobs"><thead><tr><th>작업명</th><th>Source 파일</th><th>Target 파일</th><th>비교 기준</th><th>처리 상태</th><th></th></tr></thead><tbody>
        <tr v-for="(job, index) in jobs" :key="job.id" :class="{ 'batch-active': activeId === job.id }">
          <td><input v-model="job.name" :aria-label="`${index + 1}번 작업명`" maxlength="100" :disabled="busy" @input="invalidate(job)"></td>
          <td v-for="side in (['source', 'target'] as const)" :key="side"><input type="file" accept=".csv,text/csv" :aria-label="`${index + 1}번 ${side === 'source' ? 'Source' : 'Target'} 파일`" :disabled="busy" @change="choose(job, side, $event)"><label class="batch-header"><input v-model="job[side === 'source' ? 'sourceHeader' : 'targetHeader']" type="checkbox" :disabled="busy" @change="invalidate(job, true)">첫 행은 헤더</label></td>
          <td><button class="secondary" :disabled="busy || !job.source || !job.target" :aria-label="`${index + 1}번 비교 기준 설정`" @click="configure(job)">{{ job.pairs ? '설정 수정' : '설정하기' }}</button><small v-if="job.pairs">KEY {{ job.pairs.filter(p => p.key).length }}개 · {{ job.pairs.length }}개 컬럼</small></td>
          <td><span :class="{ error: job.status === '실패' }">{{ job.status }}</span><small v-if="job.result">일치 {{ job.result.match.toLocaleString() }} · 변경 {{ job.result.modified.toLocaleString() }}<br>추가 {{ job.result.added.toLocaleString() }} · 삭제 {{ job.result.deleted.toLocaleString() }}</small><details v-if="job.error"><summary>오류 내용</summary><p class="error">{{ job.error }}</p></details></td>
          <td><button class="secondary" :disabled="busy" :aria-label="`${index + 1}번 작업 삭제`" @click="jobs.splice(index, 1); resultBlob = undefined; activeId === job.id && (activeId = undefined)">삭제</button></td>
        </tr>
      </tbody></table></div>
      <p v-if="!jobs.length" class="muted">파일 쌍을 추가하세요.</p>
      <div class="batch-actions"><button :disabled="busy || !runnable" @click="run">일괄 검증 실행</button><button v-if="busy && progress.includes('검증 중')" class="secondary" :disabled="stopRequested" @click="stopRequested = true">{{ stopRequested ? '현재 작업 완료 후 중단' : '중단 요청' }}</button><span class="muted">{{ jobs.length }}개 파일 쌍 · 순차 처리</span></div>
      <p v-if="!runnable && jobs.length" class="muted">각 파일 쌍의 ‘설정하기’에서 KEY와 비교 컬럼을 지정하세요. 실행 시 KEY와 변환식을 다시 검사합니다.</p>
      <p v-if="progress" role="status" class="status">{{ progress }}</p><p v-if="error" role="alert" class="error">{{ error }}</p>
      <details class="mapping-help"><summary>Excel 결과 안내</summary><p class="muted">검증 요약 · 불일치 상세 · 검증 기준을 제공합니다. 변경 행은 다른 컬럼만, 추가·삭제 행은 매핑된 모든 컬럼을 기록합니다. 일치 행의 상세 데이터는 제외합니다. 데이터 행 번호는 헤더를 제외한 1부터 시작합니다. NULL·빈 문자열·행 없음은 상태 열로 구분하며, 사용자 정의 SQL 식의 기대값을 함께 제공합니다. 불일치 상세는 Excel 행 한도를 넘으면 시트를 나눕니다. 결과가 클수록 Excel 생성에 메모리와 시간이 필요합니다.</p></details>
      <section v-if="resultBlob" class="downloads"><h3>결과 다운로드</h3><button class="secondary" :disabled="busy" @click="download">결과 Excel 다운로드</button></section>
    </section>
    <dialog ref="editor" class="batch-editor" aria-labelledby="batch-editor-title" @cancel="busy ? $event.preventDefault() : closeEditor()">
      <header class="batch-editor-heading"><div><h2 id="batch-editor-title">{{ editorName }} · 비교 기준</h2><p class="muted">설정은 자동 반영됩니다.<template v-if="sourceInfo && targetInfo"> Source {{ sourceInfo.rowCount }}행 · Target {{ targetInfo.rowCount }}행</template></p></div><button type="button" class="secondary" :disabled="busy" aria-label="비교 기준 설정 닫기" @click="closeEditor">닫기</button></header>
      <div class="batch-editor-body" :aria-busy="busy">
        <MappingPanel v-if="active && sourceInfo && targetInfo" :key="active.id" :source="sourceInfo" :target="targetInfo" :busy="busy" :client="client" :initial-pairs="active.pairs" :initial-template-name="active.templateName || active.name" @busy="busy = $event" @template-name-changed="active && (active.templateName = $event)" @changed="update"/>
        <p v-else-if="busy" role="status" class="status">{{ editorName }} · 컬럼을 불러오는 중…</p>
        <p v-if="error" role="alert" class="error">{{ error }}</p>
      </div>
      <footer class="batch-editor-footer"><span class="muted">KEY와 비교 규칙을 설정한 뒤 닫으면 목록에 반영됩니다.</span><button type="button" :disabled="busy" @click="closeEditor">설정 완료</button></footer>
    </dialog>
  </div>
</template>
