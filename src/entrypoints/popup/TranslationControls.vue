<template>
  <section aria-labelledby="wt-popup-title">
    <h2 id="wt-popup-title" class="section-title">{{ t('wtPageTitle') }}</h2>
    <UiSwitch
      v-if="supported"
      :checked="pageTranslationEnabled"
      :disabled="busy || (!canTranslate && !pageTranslationEnabled)"
      :label="t('wtTranslatePage')"
      data-test="wt-translate-page"
      @change="setPageTranslation"
    />
    <UiSwitch
      v-if="supported"
      :checked="autoEnabled"
      :disabled="busy || !configurationReady || (!autoEnabled && !canTranslate)"
      :label="t('wtSiteAuto')"
      data-test="wt-auto"
      @change="setAuto"
    />
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
    <UiSwitch
      :checked="videoSubtitlesEnabled"
      :disabled="busy || !configurationReady"
      :label="t('wtVideoSubtitlesShort')"
      data-test="wt-popup-video-subtitles"
      @change="setVideoSubtitles"
    />
    <UiSwitch
      :checked="inputTranslationEnabled"
      :disabled="busy || !configurationReady"
      :label="t('wtInputTranslation')"
      data-test="wt-popup-input-translation"
      @change="setInputTranslation"
    />
    <p v-if="autoError" class="wt-page-error" role="alert" data-test="wt-auto-error">{{ t(autoError) }}</p>
    <p v-if="pageError" class="wt-page-error" role="alert" data-test="wt-page-error">{{ pageError }}</p>
  </section>
</template>

<script setup lang="ts">
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { useI18n } from '../../components/ui-preferences'
import { useTranslationControls } from './useTranslationControls'

const { t } = useI18n()
const {
  supported,
  autoEnabled,
  canTranslate,
  floatingEnabled,
  autoInteractionEnabled,
  videoSubtitlesEnabled,
  inputTranslationEnabled,
  configurationReady,
  pageError,
  pageTranslationEnabled,
  autoError,
  busy,
  setFloating,
  setAutoInteraction,
  setAuto,
  setPageTranslation,
  setVideoSubtitles,
  setInputTranslation,
} = useTranslationControls()
</script>

<style scoped>
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
