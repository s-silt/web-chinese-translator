<template>
  <section aria-labelledby="wt-popup-title">
    <h2 id="wt-popup-title" class="section-title">{{ t('wtPageTitle') }}</h2>
    <span v-if="state === 'unsupported'" class="wt-line">{{ t('wtUnsupportedPage') }}</span>
    <template v-else>
      <div class="wt-row">
        <span class="wt-site" :title="origin" data-test="wt-origin">{{ origin || '—' }}</span>
        <span class="wt-state" role="status" data-test="wt-state">{{ t(WT_STATE_MESSAGE[state]) }}</span>
      </div>
      <div class="wt-quick-page">
        <UiButton variant="primary" :disabled="busy || !canTranslate" data-test="wt-translate-page" @click="translatePage">
          {{ t('wtTranslatePage') }}
        </UiButton>
      </div>
      <div v-if="failedCount > 0" class="wt-row">
        <span class="wt-state" role="status" data-test="wt-failed">{{ t('wtFailedCount', { count: failedCount }) }}</span>
        <UiButton v-if="canRetryFailed" size="sm" :disabled="busy" data-test="wt-retry-failed" @click="retryFailed">
          {{ t('wtRetryFailed') }}
        </UiButton>
      </div>
      <UiSwitch
        :checked="autoEnabled"
        :disabled="busy || !configurationReady || (!autoEnabled && !canTranslate)"
        :label="t('wtSiteAuto')"
        data-test="wt-auto"
        @change="setAuto"
      />
      <span class="wt-hint" data-test="wt-data-hint">{{ t('wtModelInlineHint') }}</span>
      <div v-if="canRestore || canResume" class="wt-actions">
        <UiButton v-if="canRestore" size="sm" :disabled="busy" data-test="wt-restore" @click="restore">{{ t('wtRestore') }}</UiButton>
        <UiButton v-if="canResume" size="sm" :disabled="busy" data-test="wt-resume" @click="resume">
          {{ t('wtResume') }}
        </UiButton>
      </div>
    </template>
    <p v-if="autoError" class="wt-page-error" role="alert" data-test="wt-auto-error">{{ t(autoError) }}</p>
    <p v-if="pageError" class="wt-page-error" role="alert" data-test="wt-page-error">{{ pageError }}</p>
    <div class="wt-quick-floating">
      <UiSwitch
        :checked="autoInteractionEnabled"
        :disabled="busy || !configurationReady"
        :label="t('wtAutomaticInteractions')"
        :title="t('wtAutomaticInteractionsHint')"
        data-test="wt-popup-auto-interaction"
        @change="setAutoInteraction"
      />
      <UiSwitch
        :checked="floatingEnabled"
        :disabled="busy || !configurationReady"
        :label="t('wtFloatingButton')"
        data-test="wt-popup-floating"
        @change="setFloating"
      />
    </div>
    <div class="wt-footer">
      <UiButton size="sm" data-test="wt-settings" @click="openSettings">{{ t('wtOpenSettings') }}</UiButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { useI18n } from '../../components/ui-preferences'
import { useTranslationControls, WT_STATE_MESSAGE } from './useTranslationControls'

const { t } = useI18n()
const {
  origin,
  state,
  autoEnabled,
  canTranslate,
  floatingEnabled,
  autoInteractionEnabled,
  configurationReady,
  pageError,
  canRestore,
  canResume,
  failedCount,
  canRetryFailed,
  autoError,
  busy,
  translatePage,
  setFloating,
  setAutoInteraction,
  setAuto,
  restore,
  resume,
  retryFailed,
  openSettings,
} = useTranslationControls()
</script>

<style scoped>
.wt-line {
  font-size: 12px;
  line-height: 1.5;
  color: var(--gcn-fg-muted);
}

.wt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: var(--gcn-control-sm);
  padding: 4px 10px;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius);
}

.wt-site {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wt-state {
  flex: none;
  font-size: 12px;
  font-weight: 500;
  color: var(--gcn-fg-muted);
}

.wt-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.wt-footer {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding-top: 2px;
}

.wt-hint {
  font-size: 12px;
  line-height: 1.45;
  color: var(--gcn-fg-muted);
}

.wt-quick-page,
.wt-quick-floating {
  display: grid;
  gap: 6px;
}

.wt-quick-floating {
  padding-top: 10px;
  border-top: 1px solid var(--gcn-border-muted);
}

.wt-page-error {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius);
}
</style>
