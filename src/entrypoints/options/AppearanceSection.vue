<template>
  <section class="section" aria-labelledby="appearance-title">
    <h2 id="appearance-title" class="section-title">{{ t('appearanceSection') }}</h2>
    <div class="wt-appearance-grid">
      <label class="wt-field">
        <span class="ui-label">{{ t('uiStyle') }}</span>
        <UiSelect
          :model-value="settings.uiStyle"
          :options="styleOptions"
          :disabled="!ready"
          data-test="wt-ui-style"
          @update:model-value="changeUiStyle($event as UiStyle)"
        />
      </label>
      <label class="wt-field">
        <span class="ui-label">{{ t('appearance') }}</span>
        <UiSelect
          :model-value="settings.theme"
          :options="themeOptions"
          :disabled="!ready || settings.uiStyle === 'cyber'"
          data-test="wt-theme"
          @update:model-value="changeTheme($event as ThemePreference)"
        />
        <span v-if="settings.uiStyle === 'cyber'" class="ui-hint">{{ t('uiStyleCyberDarkOnly') }}</span>
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiSelect from '../../components/ui/UiSelect.vue'
import { THEME_MESSAGE } from '../../components/ui-preferences'
import { useI18n } from '../../components/ui-preferences'
import { useSettings } from '../../components/useSettings'
import { UI_STYLES, type ThemePreference, type UiStyle } from '../../shared/settings'
import type { MessageKey } from '../../i18n'

const { t } = useI18n()
const { settings, ready, update } = useSettings()

const STYLE_MESSAGE: Readonly<Record<UiStyle, MessageKey>> = {
  classic: 'uiStyleClassic',
  cyber: 'uiStyleCyber',
  glass: 'uiStyleGlass',
}
const styleOptions = computed(() => UI_STYLES.map((value) => ({ value, label: t(STYLE_MESSAGE[value]) })))
const themeOptions = computed(() =>
  (Object.keys(THEME_MESSAGE) as ThemePreference[]).map((value) => ({ value, label: t(THEME_MESSAGE[value]) })),
)

function changeUiStyle(value: UiStyle): void {
  void update({ uiStyle: value })
}
function changeTheme(value: ThemePreference): void {
  void update({ theme: value })
}
</script>

<style scoped>
.wt-appearance-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

@media (max-width: 599px) {
  .wt-appearance-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.wt-field {
  display: grid;
  gap: 6px;
}

.wt-field :deep(.ui-select) {
  width: 100%;
}
</style>
