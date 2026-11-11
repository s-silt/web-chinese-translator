<template>
  <textarea ref="area" v-model="model" class="ui-field ui-textarea" :class="{ 'ui-textarea-mono': mono }"></textarea>
</template>

<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'

/**
 * 多行输入框。rows、placeholder、aria-*、input 等属性与事件直接落在原生 textarea 上。
 * 值只来自 modelValue（v-model）；内部用原生 v-model，输入法组字期间不更新、不回写
 */
const props = defineProps<{
  modelValue?: string
  /** 等宽字体：路径、代码 */
  mono?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const model = computed({
  get: () => props.modelValue ?? '',
  set: (value: string) => emit('update:modelValue', value),
})

const area = useTemplateRef<HTMLTextAreaElement>('area')

defineExpose({
  focus(): void {
    area.value?.focus()
  },
})
</script>

<style scoped>
.ui-textarea {
  display: block;
  min-height: 72px;
  resize: vertical;
}

.ui-textarea-mono {
  font-family: var(--gcn-font-mono);
  font-size: 12px;
}
</style>
