<template>
  <section aria-labelledby="language-title">
    <h2 id="language-title" class="section-title">{{ t('languageSection') }}</h2>
    <ul class="select-list">
      <li class="select-item">
        <label for="ui-language" class="select-label">{{ t('uiLanguage') }}</label>
        <UiSelect
          id="ui-language"
          class="select"
          :model-value="settings.uiLanguage"
          :options="uiLanguageOptions"
          :disabled="!ready"
          data-test="ui-language"
          @update:model-value="setOption('uiLanguage', $event)"
        />
      </li>
      <li class="select-item">
        <label for="page-language" class="select-label">{{ t('pageLanguage') }}</label>
        <UiSelect
          id="page-language"
          class="select"
          :model-value="settings.language"
          :options="pageLanguageOptions"
          :disabled="!ready"
          :aria-describedby="translationSupported ? 'page-language-hint' : undefined"
          data-test="page-language"
          @update:model-value="setOption('language', $event)"
        />
        <p v-if="translationSupported" id="page-language-hint" class="select-hint">{{ t('pageLanguageHint') }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MessageKey } from '../../i18n'
import { createToastSource } from '../../components/toast'
import type { UiSelectOption } from '../../components/ui/types'
import UiSelect from '../../components/ui/UiSelect.vue'
import { useI18n } from '../../components/ui-preferences'
import { useSettings } from '../../components/useSettings'
import { isFirefoxBuild } from '../../shared/extension'
import { languageEnvironment } from '../../shared/language-env'
import {
  isPageLocalePreference,
  isUiLanguagePreference,
  LANGUAGE_NAMES,
  PAGE_LOCALE_PREFERENCES,
  resolvePageLocale,
  resolveUiLanguage,
  UI_LANGUAGE_PREFERENCES,
  type UiLanguage,
} from '../../shared/locale'
import type { Settings } from '../../shared/settings'

/** 外观由标题栏的按钮切换，这里只有两种语言 */
type SelectKey = 'uiLanguage' | 'language'

/** 界面语言下的语言名：用于「自动」的括注 */
const LANGUAGE_MESSAGE: Readonly<Record<UiLanguage, MessageKey>> = {
  'zh-CN': 'languageZhCN',
  'zh-TW': 'languageZhTW',
  en: 'languageEn',
  ja: 'languageJa',
  ko: 'languageKo',
}

const { t } = useI18n()
const translationSupported = !isFirefoxBuild()
// 读取前显示的是默认值：与顶部总开关一样先不可用
const { settings, ready, update } = useSettings()
// 保存失败时在页面顶部提示；再次保存成功时收起
const toast = createToastSource()
const env = languageEnvironment()

/** 语言名用该语言书写并标注语言；「自动」用界面语言书写，不标 */
function optionOf(value: 'auto' | UiLanguage, resolved: UiLanguage): UiSelectOption {
  if (value === 'auto') return { value, label: t('autoOption', { name: t(LANGUAGE_MESSAGE[resolved]) }) }
  return { value, label: LANGUAGE_NAMES[value], lang: value }
}

const uiLanguageOptions = computed<UiSelectOption[]>(() =>
  UI_LANGUAGE_PREFERENCES.map((value) => optionOf(value, resolveUiLanguage('auto', env))),
)

const pageLanguageOptions = computed<UiSelectOption[]>(() =>
  PAGE_LOCALE_PREFERENCES.map((value) => optionOf(value, resolvePageLocale('auto', env))),
)

/** 只写入合法的取值 */
function patchOf(key: SelectKey, value: string): Partial<Settings> | undefined {
  if (key === 'uiLanguage') return isUiLanguagePreference(value) ? { uiLanguage: value } : undefined
  return isPageLocalePreference(value) ? { language: value } : undefined
}

/** 下拉只显示已保存的值：保存失败时保持原值 */
async function setOption(key: SelectKey, value: string): Promise<void> {
  const patch = patchOf(key, value)
  if (!patch) return
  if (await update(patch)) toast.clear()
  else toast.show('danger', 'saveFailed')
}
</script>

<style scoped>
.select-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 标签在左、下拉靠右；放不下时（英文界面的长语言名）下拉换到标签下方 */
.select-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
}

.select-label {
  cursor: pointer;
}

.select {
  width: auto;
  min-width: 180px;
  max-width: 100%;
}

.select-hint {
  font-size: 12px;
  color: var(--gcn-fg-muted);
}
</style>
