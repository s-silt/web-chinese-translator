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
    <div v-if="progress" class="popup-card-progress" data-test="wt-progress">
      <div
        v-if="progress.budget > 0"
        class="popup-card-meter"
        role="progressbar"
        :aria-label="t('wtProgressLabel')"
        aria-valuemin="0"
        :aria-valuemax="progress.budget"
        :aria-valuenow="Math.min(progress.spent, progress.budget)"
      >
        <span :style="{ width: `${percent}%` }"></span>
      </div>
      <span class="ui-hint" data-test="wt-progress-text">{{ progressText }}</span>
    </div>
    <div v-if="failedCount > 0 && !outOfScope" class="popup-card-failed">
      <span class="ui-hint is-danger" data-test="wt-failed">{{ t('wtFailedCount', { count: failedCount }) }}</span>
      <UiButton v-if="canRetryFailed" size="sm" data-test="wt-retry-failed" :disabled="busy" @click="retryFailed">
        {{ t('wtRetryFailed') }}
      </UiButton>
      <!-- 暂停或达到上限时引擎不接受单独重试：继续翻译会一并重试，记录数上限只能恢复原文 -->
      <span v-else class="ui-hint" data-test="wt-failed-hint">
        {{ t(canResume ? 'wtFailedRetryWithResume' : 'wtFailedNoRetry') }}
      </span>
    </div>
    <p v-if="sensitive" class="ui-hint">{{ t('wtSensitivePage') }}</p>
    <p v-else-if="state === 'out-of-scope'" class="ui-hint">{{ t('wtScopeBlocked') }}</p>
    <p v-else-if="state === 'master-off'" class="ui-hint">{{ t('wtMasterOff') }}</p>
    <p v-else-if="state === 'capped'" class="ui-hint" data-test="wt-capped-note">
      {{ t(canResume ? 'wtCappedNote' : 'wtCappedRecordsNote') }}
      <button type="button" class="popup-card-link" data-test="wt-capped-settings" @click="openOptionsAt('#wt-general-title')">
        {{ t('wtPageLimitAdjust') }}
      </button>
    </p>
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

const { t, language } = useI18n()
const {
  origin,
  host,
  state,
  canTranslate,
  canRestore,
  canResume,
  failedCount,
  canRetryFailed,
  progress,
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
  openOptionsAt,
} = useProvidedTranslationControls()

// 敏感页禁止发送内容：不能翻译或继续，但右键手动翻译过的内容仍可恢复原文（恢复不发送任何内容）
const restoreOnly = computed(() => canRestore.value && !canResume.value)

const primaryLabel = computed(() => {
  if (busy.value) return t('wtProcessing')
  if (restoreOnly.value) return t('wtRestore')
  if (canResume.value) return t('wtResume')
  return t('wtTranslatePage')
})

const primaryDisabled = computed(() => {
  if (busy.value) return true
  if (sensitive.value) return !restoreOnly.value
  return !canTranslate.value && !canRestore.value && !canResume.value
})

function onPrimary(): void {
  if (restoreOnly.value) void restore()
  else if (canResume.value) void resume()
  else void translatePage()
}

const percent = computed(() => {
  const value = progress.value
  if (value === undefined || value.budget <= 0) return 0
  return Math.min(100, Math.round((value.spent / value.budget) * 100))
})

const progressText = computed(() => {
  const value = progress.value
  if (value === undefined) return ''
  const format = new Intl.NumberFormat(language.value, { notation: 'compact', maximumFractionDigits: 1 })
  const parts: string[] = [
    value.budget > 0
      ? t('wtProgressUsed', { used: format.format(value.spent), limit: format.format(value.budget) })
      : t('wtProgressUsedUnlimited', { used: format.format(value.spent) }),
  ]
  if (value.translated > 0) parts.push(t('wtProgressTranslated', { count: value.translated }))
  if (value.queued > 0) parts.push(t('wtProgressQueued', { count: value.queued }))
  return parts.join(' · ')
})
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

.popup-card-progress {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.popup-card-meter {
  height: 4px;
  overflow: hidden;
  background: var(--gcn-bg-muted);
  border-radius: 999px;
}

.popup-card-meter > span {
  display: block;
  height: 100%;
  background: var(--gcn-accent);
  border-radius: inherit;
}

.popup-card-failed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.popup-card-failed .ui-hint:last-child {
  text-align: right;
}

.popup-card-link {
  padding: 0;
  font: inherit;
  color: var(--gcn-accent);
  background: none;
  border: 0;
  cursor: pointer;
}

.popup-card-link:hover {
  text-decoration: underline;
}
</style>
