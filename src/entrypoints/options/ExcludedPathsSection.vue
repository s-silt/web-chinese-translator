<template>
  <section class="section" aria-labelledby="excluded-title">
    <h2 id="excluded-title" class="section-title">{{ t('excludedPaths') }}</h2>
    <UiTextarea
      v-model="text"
      mono
      rows="6"
      spellcheck="false"
      autocomplete="off"
      aria-labelledby="excluded-title"
      :aria-invalid="invalid"
      :placeholder="PLACEHOLDER"
      @input="markDirty"
    />
    <UiInput
      v-model="probe"
      type="text"
      spellcheck="false"
      autocomplete="off"
      :aria-label="t('excludedPathTest')"
      placeholder="https://github.com/owner/repo/wiki"
      data-test="excluded-probe"
    />
    <p class="probe-result" :class="`probe-${probeResult.kind}`" data-test="excluded-probe-result" aria-live="polite">
      {{ probeText }}
    </p>
    <div class="section-actions">
      <UiButton variant="primary" @click="save">{{ t('save') }}</UiButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '../../components/ui/UiButton.vue'
import UiInput from '../../components/ui/UiInput.vue'
import UiTextarea from '../../components/ui/UiTextarea.vue'
import { useI18n } from '../../components/ui-preferences'
import { useExcludedPaths } from './useExcludedPaths'

const PLACEHOLDER = '/settings\n/*/*/wiki'

const { t } = useI18n()
const { text, invalid, probe, probeResult, markDirty, save } = useExcludedPaths()

const probeText = computed(() => {
  const result = probeResult.value
  if (result.kind === 'empty') return t('excludedProbeHint')
  if (result.kind === 'invalid') return t('excludedProbeInvalid')
  if (result.kind === 'excluded') return t('excludedProbeExcluded', { path: result.path, pattern: result.pattern })
  return t('excludedProbeIncluded', { path: result.path })
})
</script>

<style scoped>
.probe-result {
  margin: 0;
  font-size: 13px;
  color: var(--gcn-fg-muted);
  overflow-wrap: anywhere;
}

.probe-excluded {
  color: var(--gcn-attention-fg);
}

.probe-included {
  color: var(--gcn-success-fg);
}
</style>
