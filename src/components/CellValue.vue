<script setup lang="ts">
defineProps<{ value: string | null }>();
</script>

<template>
  <span v-if="value === null" class="null">NULL</span><span v-else-if="value === ''" class="null">빈 문자열</span><template v-else>{{ value }}</template>
</template>
