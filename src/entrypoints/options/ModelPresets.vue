<template>
  <div class="model-presets" data-test="wt-presets">
    <button
      v-for="preset in MODEL_PRESETS"
      :key="preset.id"
      type="button"
      class="model-preset"
      :aria-pressed="isPressed(preset.url)"
      :data-test="`wt-preset-${preset.id}`"
      :disabled="disabled"
      @click="emit('select', preset.url)"
    >
      {{ t(preset.key) }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from '../../components/ui-preferences'
import { MODEL_PRESETS } from './model-presets'

const props = defineProps<{
  baseUrl: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  select: [url: string]
}>()

const { t } = useI18n()

function isPressed(url: string): boolean {
  return props.baseUrl.trim() === url
}
</script>

<style scoped>
.model-presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.model-preset {
  min-height: var(--gcn-control-md);
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--gcn-fg);
  background: var(--gcn-btn-bg);
  border: 1px solid var(--gcn-btn-border);
  border-radius: var(--gcn-radius);
  cursor: pointer;
}

.model-preset:hover:not(:disabled) {
  background: var(--gcn-btn-hover-bg);
}

.model-preset[aria-pressed='true'] {
  color: var(--gcn-accent);
  border-color: var(--gcn-accent);
}

.model-preset:disabled {
  color: var(--gcn-fg-disabled);
  cursor: not-allowed;
}

@media (max-width: 599px) {
  .model-presets {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (forced-colors: active) {
  .model-preset[aria-pressed='true'] {
    outline: 2px solid Highlight;
  }
}
</style>
