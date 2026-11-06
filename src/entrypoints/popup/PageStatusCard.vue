<template>
  <section class="popup-card" aria-labelledby="wt-popup-title">
    <h2 id="wt-popup-title" class="sr-only">{{ t('wtPageTitle') }}</h2>
    <div class="popup-card-head">
      <span class="popup-card-host" :title="host || origin">{{ host || origin }}</span>
      <UiBadge :tone="sensitive ? 'attention' : wtStateTone(state)" dot live data-test="wt-page-state">
        {{ sensitive ? t('wtSensitiveSkipped') : t(WT_STATE_MESSAGE[state]) }}
      </UiBadge>
    </div>
    <div class="popup-card-actions">
      <UiButton
        variant="primary"
        size="sm"
        :disabled="primaryDisabled"
        data-test="wt-translate-page"
        @click="onPrimary"
      >
        {{ primaryLabel }}
      </UiButton>
      <UiButton
        size="sm"
        :disabled="busy || host === '' || !configurationReady"
        data-test="wt-exclude-site"
        @click="excludeSite(!siteExcluded)"
      >
        {{ siteExcluded ? t('includePage') : t('wtExcludeSite') }}
      </UiButton>
    </div>
    <div v-if="failedCount > 0 && !outOfScope" class="popup-card-failed">
      <span data-test="wt-failed">{{ t('wtFailedCount', { count: failedCount }) }}</span>
      <UiButton v-if="canRetryFailed" size="sm" data-test="wt-retry-failed" :disabled="busy" @click="retryFailed">
        {{ t('wtRetryFailed') }}
      </UiButton>
      <!-- 暂停或达到上限时引擎不接受单独重试：继续翻译会一并重试，记录数上限只能恢复原文 -->
      <span v-else class="popup-card-failed-hint" data-test="wt-failed-hint">
        {{ t(canResume ? 'wtFailedRetryWithResume' : 'wtFailedNoRetry') }}
      </span>
    </div>
    <p v-if="sensitive" class="popup-card-note">{{ t('wtSensitivePage') }}</p>
    <p v-else-if="state === 'out-of-scope'" class="popup-card-note">{{ t('wtScopeBlocked') }}</p>
    <p v-else-if="state === 'master-off'" class="popup-card-note">{{ t('wtMasterOff') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiBadge from '../../components/ui/UiBadge.vue'
import UiButton from '../../components/ui/UiButton.vue'
import { useI18n } from '../../components/ui-preferences'
import {
  useProvidedTranslationControls,
  wtStateTone,
  WT_STATE_MESSAGE,
} from './useTranslationControls'

const { t } = useI18n()
const {
  origin,
  host,
  state,
  canTranslate,
  canRestore,
  canResume,
  failedCount,
  canRetryFailed,
  outOfScope,
  busy,
  configurationReady,
  sensitive,
  siteExcluded,
  translatePage,
  restore,
  resume,
  retryFailed,
  excludeSite,
} = useProvidedTranslationControls()

const primaryLabel = computed(() => {
  if (busy.value) return t('wtProcessing')
  if (canRestore.value && !canResume.value) return t('wtRestore')
  if (canResume.value) return t('wtResume')
  return t('wtTranslatePage')
})

const primaryDisabled = computed(
  () =>
    busy.value ||
    sensitive.value ||
    (!canTranslate.value && !canRestore.value && !canResume.value),
)

function onPrimary(): void {
  if (canRestore.value && !canResume.value) void restore()
  else if (canResume.value) void resume()
  else void translatePage()
}
</script>

<style scoped>
.popup-card {
  display: grid;
  gap: 10px;
  background: var(--gcn-card-bg);
  border: 1px solid var(--gcn-card-border);
  border-radius: var(--gcn-card-radius);
}

.popup-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.popup-card-host {
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popup-card-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.popup-card-failed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--gcn-danger-fg);
}

.popup-card-failed-hint {
  color: var(--gcn-fg-muted);
  text-align: right;
}

.popup-card-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--gcn-fg-muted);
}
</style>
