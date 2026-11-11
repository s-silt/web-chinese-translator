<template>
  <main class="translate">
    <header class="translate-head">
      <div class="translate-head-row">
        <img class="translate-logo" :src="LOGO_URL" width="24" height="24" alt="" />
        <h1 class="translate-title">{{ t('textTranslate') }}</h1>
        <a class="translate-settings" :href="optionsUrl" target="_blank" rel="noopener" data-test="wt-text-settings">
          {{ t('wtOpenModelSettings') }}
        </a>
      </div>
    </header>

    <div class="translate-body">
      <UiNotice tone="info" class="translate-notice">
        <p>{{ t('textTranslateHint') }}</p>
        <p class="ui-hint">{{ t('textTranslateMemoryHint') }}</p>
      </UiNotice>

      <UiNotice v-if="loadFailed" tone="error" live="assertive" :aria-busy="loadingConfig" class="translate-notice">
        <p><span data-test="wt-text-load-error">{{ t('wtConfigUnreadable') }}</span></p>
        <UiButton
          variant="default"
          :disabled="loadingConfig"
          :aria-busy="loadingConfig"
          data-test="wt-text-reload"
          @click="load"
        >
          {{ t(loadingConfig ? 'stateLoading' : 'uiRetry') }}
        </UiButton>
      </UiNotice>

      <UiNotice v-else-if="modelMissing" tone="warning" class="translate-notice">
        <p><span data-test="wt-text-unconfigured">{{ t('wtNotConfigured') }}</span></p>
        <UiButton :href="optionsUrl" target="_blank" rel="noopener" variant="default" data-test="wt-text-configure">
          {{ t('wtConfigureNow') }}
        </UiButton>
      </UiNotice>

      <div class="translate-grid">
        <section class="translate-pane" aria-labelledby="wt-text-source-label">
          <div class="translate-pane-head">
            <span id="wt-text-source-label" class="ui-label">{{ t('wtSourceLanguage') }}</span>
            <UiSelect
              :model-value="source"
              :options="sourceOptions"
              aria-labelledby="wt-text-source-label"
              data-test="wt-text-source"
              @update:model-value="changeSource"
            />
          </div>
          <label id="wt-text-input-label" class="ui-label" :for="INPUT_ID">{{ t('source') }}</label>
          <UiTextarea
            :id="INPUT_ID"
            ref="textInput"
            v-model="text"
            class="translate-input"
            data-test="wt-text-input"
            :placeholder="t('textTranslateEmpty')"
            :aria-invalid="tooLong ? 'true' : undefined"
            :aria-describedby="COUNT_ID"
            @input="onInput"
            @keydown="onKeydown"
          />
          <p
            :id="COUNT_ID"
            class="translate-count ui-hint"
            :class="{ 'is-danger': tooLong }"
            data-test="wt-text-count"
          >
            {{ t('textTranslateCount', { count: text.length }) }}
          </p>
        </section>

        <section class="translate-pane" aria-labelledby="wt-text-target-label">
          <div class="translate-pane-head">
            <span id="wt-text-target-label" class="ui-label">{{ t('wtTargetLanguage') }}</span>
            <UiSelect
              :model-value="target"
              :options="targetOptions"
              aria-labelledby="wt-text-target-label"
              data-test="wt-text-target"
              @update:model-value="changeTarget"
            />
          </div>
          <label id="wt-text-result-label" class="ui-label" :for="RESULT_ID">{{ t('wtPanelResult') }}</label>
          <UiTextarea
            :id="RESULT_ID"
            :model-value="result"
            class="translate-result"
            data-test="wt-text-result"
            :placeholder="t('textTranslateResultEmpty')"
            readonly
            :aria-busy="busy"
          />
        </section>
      </div>

      <p v-if="busy" class="translate-status ui-hint" role="status" data-test="wt-text-busy">
        {{ t('wtPanelLoading') }}
      </p>
      <p v-else-if="result !== ''" class="translate-status ui-hint" role="status" data-test="wt-text-complete">
        {{ t('textTranslateComplete') }}
      </p>

      <UiNotice v-if="error !== ''" tone="error" :live="'assertive'" class="translate-notice">
        <p><span data-test="wt-text-error">{{ error }}</span></p>
        <p class="ui-hint">{{ t('textTranslateErrorHint') }}</p>
        <UiButton variant="default" :disabled="submitDisabled" data-test="wt-text-retry" @click="submit">
          {{ t('uiRetry') }}
        </UiButton>
      </UiNotice>

      <footer class="translate-actions">
        <UiButton
          variant="primary"
          :disabled="submitDisabled"
          :aria-busy="busy"
          :aria-describedby="SUBMIT_HINT_ID"
          data-test="wt-text-translate"
          @click="submit"
        >
          {{ t('wtToolbarTranslate') }}
        </UiButton>
        <UiButton v-if="busy" variant="default" data-test="wt-text-cancel" @click="cancel">{{ t('cancel') }}</UiButton>
        <UiButton variant="default" :disabled="result === ''" data-test="wt-text-copy" @click="copy">
          {{ t('wtToolbarCopy') }}
        </UiButton>
        <UiButton variant="invisible" data-test="wt-text-clear" @click="clear">{{ t('textTranslateClear') }}</UiButton>
        <ToastHost class="translate-feedback" />
        <p :id="SUBMIT_HINT_ID" class="translate-submit-hint ui-hint" data-test="wt-text-submit-hint">{{ submitHintText }}</p>
      </footer>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { browser } from 'wxt/browser'
import ToastHost from '../../components/ToastHost.vue'
import UiButton from '../../components/ui/UiButton.vue'
import UiNotice from '../../components/ui/UiNotice.vue'
import UiSelect from '../../components/ui/UiSelect.vue'
import UiTextarea from '../../components/ui/UiTextarea.vue'
import type { UiSelectOption } from '../../components/ui/types'
import { createToastSource } from '../../components/toast'
import { useI18n, useUiPreferencesSync } from '../../components/ui-preferences'
import { useSettings } from '../../components/useSettings'
import { copySelectionText } from '../../translation/clipboard'
import { closePageSession, sendTranslationMessage } from '../../translation/client'
import type { TranslationConfig } from '../../translation/config'
import { createId } from '../../translation/id'
import {
  TARGET_LANGUAGES,
  TARGET_LANGUAGE_NATIVE_LABEL,
  type SourceLanguage,
  type TargetLanguage,
} from '../../translation/target-language'
import type { MessageKey } from '../../i18n'

const MAX_TEXT = 6000
const INPUT_ID = 'wt-text-input'
const RESULT_ID = 'wt-text-result'
const COUNT_ID = 'wt-text-count'
const SUBMIT_HINT_ID = 'wt-text-submit-hint'
const LOGO_URL = '/icon/48.png'

useUiPreferencesSync()
const { t, language } = useI18n()
const { settings } = useSettings()

const text = ref('')
const result = ref('')
const source = ref<SourceLanguage>('auto')
const target = ref<TargetLanguage>('zh-CN')
const error = ref('')
const busy = ref(false)
const loadFailed = ref(false)
const loadingConfig = ref(false)
const config = shallowRef<TranslationConfig>()
const toast = createToastSource()
const textInput = useTemplateRef<{ focus(): void }>('textInput')

let epoch = 0
let configEpoch = 0
let requestId: string | undefined
let disposed = false
let languagesDirty = false
let defaultsApplied = false

const modelMissing = computed(
  () => config.value !== undefined && (config.value.baseUrl === '' || config.value.model === ''),
)
const tooLong = computed(() => text.value.length > MAX_TEXT)
const submitDisabled = computed(
  () =>
    busy.value ||
    config.value === undefined ||
    loadFailed.value ||
    modelMissing.value ||
    tooLong.value ||
    text.value.trim() === '',
)

const submitReason = computed<MessageKey | ''>(() => {
  if (config.value === undefined && !loadFailed.value) return 'stateLoading'
  if (loadFailed.value) return 'wtConfigUnreadable'
  if (modelMissing.value) return 'wtNotConfigured'
  if (tooLong.value) return 'textTranslateTooLong'
  if (text.value.trim() === '') return 'textTranslateEmpty'
  return ''
})

const shortcutKey = /mac|iphone|ipad/i.test(window.navigator.platform)
  ? '⌘+Enter'
  : 'Ctrl+Enter'
const submitHintText = computed(() =>
  submitReason.value !== '' ? t(submitReason.value) : t('textTranslateKeyHint', { key: shortcutKey }),
)

const targetOptions = computed<readonly UiSelectOption[]>(() =>
  TARGET_LANGUAGES.map((value) => ({ value, label: TARGET_LANGUAGE_NATIVE_LABEL[value], lang: value })),
)
const sourceOptions = computed<readonly UiSelectOption[]>(() => [
  { value: 'auto', label: t('wtSourceAuto') },
  ...TARGET_LANGUAGES.map((value) => ({ value, label: TARGET_LANGUAGE_NATIVE_LABEL[value], lang: value })),
])

const optionsUrl = `${browser.runtime.getURL('/options.html')}#wt-title`

function invalidate(): void {
  epoch += 1
  const id = requestId
  requestId = undefined
  if (id !== undefined) void sendTranslationMessage({ type: 'wt:cancel-assist', requestId: id })
  busy.value = false
  result.value = ''
  error.value = ''
}

function onInput(): void {
  invalidate()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    void submit()
  }
}

function changeSource(value: string): void {
  source.value = value as SourceLanguage
  languagesDirty = true
  invalidate()
}

function changeTarget(value: string): void {
  target.value = value as TargetLanguage
  languagesDirty = true
  invalidate()
}

function cancel(): void {
  invalidate()
}

function clear(): void {
  invalidate()
  text.value = ''
  void nextTick(() => textInput.value?.focus())
}

async function submit(): Promise<void> {
  if (disposed || busy.value || loadFailed.value) return
  const value = text.value
  if (value.trim() === '') {
    error.value = t('textTranslateEmpty')
    return
  }
  if (value.length > MAX_TEXT || config.value === undefined) return
  if (modelMissing.value) {
    error.value = t('wtNotConfigured')
    return
  }
  const generation = ++epoch
  const id = createId()
  requestId = id
  busy.value = true
  error.value = ''
  result.value = ''
  const reply = await sendTranslationMessage({
    type: 'wt:translate-text',
    text: value,
    sourceLanguage: source.value,
    targetLanguage: target.value,
    requestId: id,
  })
  if (disposed || generation !== epoch) return
  busy.value = false
  requestId = undefined
  if (reply.ok) result.value = reply.texts[0] ?? ''
  else error.value = reply.error
}

async function copy(): Promise<void> {
  if (result.value === '') return
  const ok = await copySelectionText(result.value)
  if (disposed) return
  toast.show(ok ? 'success' : 'danger', ok ? 'wtToolbarCopied' : 'wtToolbarCopyFailed')
}

async function load(): Promise<void> {
  const generation = ++configEpoch
  loadingConfig.value = true
  const reply = await sendTranslationMessage({ type: 'wt:get-config' })
  if (disposed || generation !== configEpoch) return
  loadingConfig.value = false
  if (!reply.ok || reply.config === undefined) {
    loadFailed.value = true
    return
  }
  loadFailed.value = false
  config.value = reply.config
  if (!defaultsApplied) {
    defaultsApplied = true
    if (!languagesDirty) {
      source.value = reply.config.inputSourceLanguage
      target.value = reply.config.inputTargetLanguage
    }
  }
}

function onFocus(): void {
  void load()
}

function onPageHide(): void {
  invalidate()
  closePageSession()
}

watch(
  [language, settings],
  () => {
    document.title = t('textTranslate')
  },
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('focus', onFocus)
  window.addEventListener('pagehide', onPageHide)
  void load()
})

onBeforeUnmount(() => {
  disposed = true
  configEpoch += 1
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('pagehide', onPageHide)
  invalidate()
  closePageSession()
})
</script>

<style scoped>
.translate {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  color: var(--gcn-fg);
  background: var(--gcn-bg);
}

.translate-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 24px 24px;
}

.translate-head {
  padding: 20px 24px 12px;
}

.translate-head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 1120px;
  margin: 0 auto;
}

.translate-logo {
  flex: none;
  border-radius: 6px;
}

.translate-title {
  flex: 1;
  min-width: 0;
  font-size: 20px;
  font-weight: 600;
}

.translate-settings {
  flex: none;
  font-size: 13px;
  color: var(--gcn-accent);
  text-decoration: none;
}

.translate-settings:hover {
  text-decoration: underline;
}

.translate-notice :deep(.ui-notice-body) {
  display: grid;
  gap: 10px;
  justify-items: start;
}

.translate-notice p {
  margin: 0;
}

.translate-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  flex: 1;
  align-items: stretch;
}

@media (max-width: 720px) {
  .translate-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.translate-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.translate-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.translate-pane-head .ui-label {
  flex: none;
}

.translate-pane-head :deep(.ui-select) {
  min-width: 0;
}

.translate-input,
.translate-result {
  flex: 1;
  width: 100%;
  min-height: 300px;
  resize: vertical;
  white-space: pre-wrap;
}

@media (max-width: 720px) {
  .translate-input,
  .translate-result {
    min-height: 240px;
  }
}

.translate-count {
  margin: 0;
  text-align: end;
}

.translate-status {
  margin: 0;
}

.translate-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.translate-submit-hint {
  flex-basis: 100%;
  margin: 0;
}

.translate-feedback {
  position: static;
  align-items: flex-start;
  max-width: 100%;
}

.translate-feedback:empty {
  display: none;
}
</style>
