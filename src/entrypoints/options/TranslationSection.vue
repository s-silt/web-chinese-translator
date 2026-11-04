<template>
  <section class="section wt-settings-sections wt-settings-view" :aria-labelledby="sectionTitle">
    <h2 :id="sectionTitle" class="section-title">{{ t(props.view === 'model' ? 'navModel' : props.view === 'sites' ? 'wtSiteSettings' : 'navGeneral') }}</h2>
    <p v-show="props.view === 'all' || props.view === 'general'" class="wt-hint">{{ t('wtGeneralHint') }}</p>

    <label v-show="props.view === 'all' || props.view === 'model'" class="wt-field">
      <span id="wt-api-type-label" class="wt-label">{{ t('wtApiType') }}</span>
      <UiSelect
        :model-value="apiType"
        :disabled="!ready || saving || testing"
        :options="apiTypeOptions"
        aria-labelledby="wt-api-type-label"
        data-test="wt-api-type"
        @update:model-value="apiType = $event as ApiType"
      />
    </label>

    <div v-show="props.view === 'all' || props.view === 'model'" class="wt-fields" data-test="wt-model-view">
      <label class="wt-field">
        <span id="wt-base-url-label" class="wt-label">{{ t('wtBaseUrl') }}</span>
        <UiInput
          v-model="baseUrl"
          :disabled="!ready || saving || testing"
          placeholder="https://api.example.com/v1"
          aria-labelledby="wt-base-url-label"
          :aria-describedby="endpointPreview === '' ? 'wt-base-url-hint' : 'wt-endpoint-preview wt-base-url-hint'"
        />
        <span v-if="endpointPreview !== ''" id="wt-endpoint-preview" class="wt-endpoint-preview" data-test="wt-endpoint-preview">
          {{ t('wtEndpointPreview') }}: {{ endpointPreview }}
        </span>
        <span id="wt-base-url-hint" class="wt-hint">{{ t('wtBaseUrlHint') }}</span>
      </label>
      <label class="wt-field">
        <span id="wt-api-key-label" class="wt-label">API Key</span>
        <UiInput
          v-model="apiKey"
          type="password"
          autocomplete="off"
          :disabled="!ready || saving || testing"
          :placeholder="t('wtApiKeyKeep')"
          aria-labelledby="wt-api-key-label"
          aria-describedby="wt-api-key-hint"
        />
        <span id="wt-api-key-hint" class="wt-hint">{{ keyHint }}</span>
      </label>
      <div class="wt-field">
        <span id="wt-model-label" class="wt-label">{{ t('wtModel') }}</span>
        <div class="wt-model-row">
          <ModelInput
            v-model="model"
            :disabled="!ready || saving || testing"
            :options="modelChoices"
            :choose-label="t('wtModelsChoose')"
            :more-label="t('wtModelsMore')"
            aria-labelledby="wt-model-label"
            :aria-describedby="modelsMessage ? 'wt-model-hint wt-model-status' : 'wt-model-hint'"
            data-test="wt-model-input"
          />
          <UiButton
            :disabled="!ready || saving || testing"
            data-test="wt-fetch-models"
            @click="fetchingModels ? cancelModelLookup() : fetchModels()"
          >
            {{ fetchingModels ? t('wtModelsCancel') : t('wtModelsFetch') }}
          </UiButton>
        </div>
        <span id="wt-model-hint" class="wt-hint">{{ t('wtModelsHint') }}</span>
        <span
          v-if="modelsMessage"
          id="wt-model-status"
          class="wt-hint"
          :class="{ 'wt-status-error': modelsError }"
          role="status"
        >{{ modelsMessage }}</span>
      </div>
    </div>

    <details v-show="props.view === 'all' || props.view === 'model'" ref="advancedDetails" class="wt-details wt-advanced" data-test="wt-advanced">
      <summary class="wt-advanced-summary">
        <svg class="wt-advanced-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('wtAdvanced') }}</span>
        <span class="wt-hint wt-advanced-summary-hint">{{ t('wtAdvancedHint') }}</span>
      </summary>
      <div class="wt-details-body">
        <label class="wt-field">
          <span id="wt-temperature-label" class="wt-label">{{ t('wtTemperature') }}</span>
          <UiInput
            :model-value="temperatureDraft"
            type="number"
            step="any"
            min="0"
            max="2"
            :disabled="!ready || saving || testing"
            :placeholder="t('wtTemperatureDefault')"
            aria-labelledby="wt-temperature-label"
            aria-describedby="wt-temperature-hint"
            :aria-invalid="invalidField === 'temperature' ? 'true' : undefined"
            data-test="wt-temperature"
            @update:model-value="onTemperatureInput"
          />
          <span id="wt-temperature-hint" class="wt-hint">{{ t('wtTemperatureHint') }}</span>
        </label>
        <label class="wt-field">
          <span id="wt-request-params-label" class="wt-label">{{ t('wtRequestParams') }}</span>
          <textarea
            v-model="requestParamsDraft"
            class="ui-field wt-code-textarea"
            rows="5"
            spellcheck="false"
            :disabled="!ready || saving || testing"
            :placeholder="requestParamsPlaceholder"
            aria-labelledby="wt-request-params-label"
            aria-describedby="wt-request-params-hint"
            :aria-invalid="invalidField === 'requestParams' ? 'true' : undefined"
            data-test="wt-request-params"
            @input="clearInvalid('requestParams')"
          ></textarea>
          <span id="wt-request-params-hint" class="wt-hint">{{ t('wtRequestParamsHint') }}</span>
        </label>
        <label class="wt-field">
          <span id="wt-custom-headers-label" class="wt-label">{{ t('wtCustomHeaders') }}</span>
          <textarea
            v-model="customHeadersDraft"
            class="ui-field wt-code-textarea"
            rows="5"
            autocomplete="off"
            spellcheck="false"
            :disabled="!ready || saving || testing"
            :placeholder="customHeadersPlaceholder"
            aria-labelledby="wt-custom-headers-label"
            :aria-describedby="customHeadersStatusHint === '' ? 'wt-custom-headers-hint' : 'wt-custom-headers-hint wt-custom-headers-state'"
            :aria-invalid="invalidField === 'customHeaders' ? 'true' : undefined"
            data-test="wt-custom-headers"
            @input="clearInvalid('customHeaders')"
          ></textarea>
          <span id="wt-custom-headers-hint" class="wt-hint">{{ t('wtCustomHeadersHint') }}</span>
          <span v-if="customHeadersStatusHint !== ''" id="wt-custom-headers-state" class="wt-hint">{{ customHeadersStatusHint }}</span>
        </label>
      </div>
    </details>

    <div v-show="props.view === 'all' || props.view === 'model'" class="section-actions">
      <UiButton variant="primary" :disabled="!ready || saving || testing || fetchingModels" data-test="wt-save" @click="saveAndConnect">
        {{ testing ? t('wtTesting') : t('wtSaveConnect') }}
      </UiButton>
      <UiButton v-if="keyState !== 'none'" size="sm" :disabled="!ready || saving || fetchingModels" data-test="wt-delete-key" @click="deleteKey">
        {{ t('wtDeleteKey') }}
      </UiButton>
      <UiButton size="sm" :disabled="!ready || saving" data-test="wt-clear-cache" @click="clearCache">
        {{ t('wtClearCache') }}
      </UiButton>
    </div>

    <div v-show="props.view === 'all' || props.view === 'general'" class="wt-reading-group" data-test="wt-general-view">
      <div class="wt-floating-group">
        <UiSwitch
          :checked="autoInteractionEnabled"
          :label="t('wtAutomaticInteractions')"
          :disabled="!ready || saving"
          aria-describedby="wt-auto-interaction-hint"
          data-test="wt-auto-interaction"
          @change="changeAutoInteraction"
        />
        <p id="wt-auto-interaction-hint" class="wt-hint">{{ t('wtAutomaticInteractionsHint') }}</p>
      </div>
      <div class="wt-floating-group">
        <UiSwitch
          :checked="floatingButtonEnabled"
          :label="t('wtFloatingButton')"
          :disabled="!ready || saving"
          data-test="wt-floating-toggle"
          @change="changeFloatingButton"
        />
        <p class="wt-hint">{{ t('wtFloatingHint') }}</p>
        <UiButton
          v-if="floatingButtonEnabled"
          size="sm"
          class="wt-floating-grant"
          :disabled="!ready || saving || grantingAccess || allSitesGranted"
          data-test="wt-floating-grant"
          @click="grantFloatingSites"
        >
          {{ allSitesGranted ? t('wtFloatingGranted') : t('wtFloatingGrant') }}
        </UiButton>
      </div>
      <label class="wt-field">
        <span id="wt-assist-mode-label" class="wt-label">{{ t('wtAssistMode') }}</span>
        <UiSelect
          :model-value="assistMode"
          :disabled="!ready || saving"
          :options="modeOptions"
          aria-labelledby="wt-assist-mode-label"
          aria-describedby="wt-assist-mode-hint"
          data-test="wt-assist-mode"
          @update:model-value="changeAssistMode($event as AssistMode)"
        />
        <span id="wt-assist-mode-hint" class="wt-hint">{{ assistMode === 'toolbar' ? t('wtToolbarHint') : assistMode === 'smart' ? t('wtSmartInlineHint') : t('wtAssistModeHint') }}</span>
      </label>
    </div>

    <div v-show="props.view === 'all' || props.view === 'general'" class="wt-language-pair">
      <label class="wt-field">
        <span id="wt-source-language-label" class="wt-label">{{ t('wtSourceLanguage') }}</span>
        <UiSelect
          :model-value="sourceLanguage"
          :disabled="!ready || saving"
          :options="sourceLanguageOptions"
          aria-labelledby="wt-source-language-label"
          aria-describedby="wt-source-language-hint"
          data-test="wt-source-language"
          @update:model-value="changeSourceLanguage($event as SourceLanguage)"
        />
        <span id="wt-source-language-hint" class="wt-hint">{{ t('wtSourceLanguageHint') }}</span>
      </label>
      <label class="wt-field">
        <span id="wt-target-language-label" class="wt-label">{{ t('wtTargetLanguage') }}</span>
        <UiSelect
          :model-value="targetLanguage"
          :disabled="!ready || saving"
          :options="languageOptions"
          aria-labelledby="wt-target-language-label"
          aria-describedby="wt-target-language-hint"
          data-test="wt-target-language"
          @update:model-value="changeTargetLanguage($event as TargetLanguage)"
        />
        <span id="wt-target-language-hint" class="wt-hint">{{ t('wtTargetLanguageHint') }}</span>
      </label>
    </div>

    <div v-if="shortcuts.length > 0" v-show="props.view === 'all' || props.view === 'general'" class="wt-shortcuts" data-test="wt-shortcuts">
      <span class="wt-label">{{ t('wtShortcuts') }}</span>
      <ul class="wt-shortcut-list">
        <li v-for="item in shortcuts" :key="item.name"><span>{{ t(item.labelKey) }}</span><kbd>{{ item.shortcut || t('wtShortcutUnset') }}</kbd></li>
      </ul>
      <p class="wt-hint">{{ t('wtShortcutsHint') }}</p>
      <UiButton size="sm" data-test="wt-shortcuts-manage" @click="openShortcuts">{{ t('wtShortcutsManage') }}</UiButton>
    </div>

    <div v-show="props.view === 'all' || props.view === 'sites'" data-test="wt-sites-view">
      <div class="wt-details-body" data-test="wt-site-auto-details">
        <div class="wt-site-group">
          <h3 id="wt-site-scope-label" class="wt-subtitle">{{ t('wtSiteScope') }}</h3>
          <UiSelect
            :model-value="siteScopeMode"
            :disabled="!ready || saving"
            :options="scopeModeOptions"
            aria-labelledby="wt-site-scope-label"
            data-test="wt-site-scope-mode"
            @update:model-value="changeSiteScopeMode($event as SiteScopeMode)"
          />
          <p class="wt-hint">{{ t('wtScopeHint') }}</p>
          <template v-if="siteScopeMode !== 'all'">
            <ul v-if="siteScopeHosts.length" class="wt-sites">
              <li v-for="host in siteScopeHosts" :key="host" class="wt-site">
                <span class="wt-origin" data-test="wt-scope-host">{{ host }}</span>
                <UiButton size="sm" :disabled="saving" data-test="wt-scope-remove" @click="removeScopeHost(host)">
                  {{ t('wtRemove') }}
                </UiButton>
              </li>
            </ul>
            <p v-else class="wt-hint" data-test="wt-scope-empty">
              {{ siteScopeMode === 'include' ? t('wtScopeEmptyInclude') : t('wtScopeEmpty') }}
            </p>
            <div class="wt-add">
              <label class="wt-scope-field">
                {{ t('wtScopeHost') }}
                <UiInput v-model="newScopeHost" :disabled="!ready || saving" placeholder="example.org" data-test="wt-scope-input" />
              </label>
              <UiButton :disabled="!ready || saving" data-test="wt-scope-add" @click="addScopeHost">{{ t('wtAddSite') }}</UiButton>
            </div>
          </template>
        </div>
        <div class="wt-site-group">
          <h3 class="wt-subtitle">{{ t('wtAutoSites') }}</h3>
          <p class="wt-hint">{{ t('wtModelInlineHint') }}</p>
          <ul v-if="origins.length" class="wt-sites">
            <li v-for="origin in origins" :key="origin" class="wt-site">
              <span class="wt-origin" data-test="wt-origin">{{ origin }}</span>
              <UiButton size="sm" :disabled="saving" data-test="wt-remove" @click="removeSite(origin)">
                {{ t('wtRemove') }}
              </UiButton>
            </li>
          </ul>
          <p v-else class="wt-hint">{{ t('wtNoSites') }}</p>
          <div class="wt-add">
            <UiInput v-model="newSite" :disabled="!ready || saving" :placeholder="t('wtSitePlaceholder')" />
            <UiButton :disabled="!ready || saving" data-test="wt-add" @click="addSite">{{ t('wtAddSite') }}</UiButton>
          </div>
        </div>
        <div class="wt-site-group">
          <h3 class="wt-subtitle">{{ t('wtExcludedSites') }}</h3>
          <p class="wt-hint">{{ t('wtExcludedHint') }}</p>
          <ul v-if="excludedHosts.length" class="wt-sites">
            <li v-for="host in excludedHosts" :key="host" class="wt-site">
              <span class="wt-origin" data-test="wt-excluded-host">{{ host }}</span>
              <UiButton size="sm" :disabled="saving" data-test="wt-excluded-remove" @click="removeExcluded(host)">
                {{ t('wtRemove') }}
              </UiButton>
            </li>
          </ul>
          <p v-else class="wt-hint">{{ t('wtExcludedEmpty') }}</p>
          <div class="wt-add">
            <UiInput v-model="newExcludedHost" :disabled="!ready || saving" :placeholder="t('wtExcludedPlaceholder')" data-test="wt-excluded-input" />
            <UiButton :disabled="!ready || saving" data-test="wt-excluded-add" @click="addExcluded">{{ t('wtAddExcluded') }}</UiButton>
          </div>
        </div>
      </div>
    </div>

    <p v-if="statusMessage" class="wt-status" :class="{ 'wt-status-error': statusError }" role="status">
      {{ statusMessage }}
    </p>

    <p class="wt-hint wt-privacy-note">{{ t('wtPrivacyNote') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { browser } from 'wxt/browser'
import { createToastSource } from '../../components/toast'
import UiButton from '../../components/ui/UiButton.vue'
import UiInput from '../../components/ui/UiInput.vue'
import UiSelect from '../../components/ui/UiSelect.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import ModelInput from './ModelInput.vue'
import { useI18n } from '../../components/ui-preferences'
import type { MessageKey } from '../../i18n'
import {
  completionUrl,
  DEFAULT_TRANSLATION_CONFIG,
  hostPermissionPattern,
  normalizeBaseUrl,
  normalizeOrigin,
} from '../../translation/config'
import { createId } from '../../translation/id'
import { validateApiKey } from '../../translation/secrets'
import {
  TARGET_LANGUAGE_NATIVE_LABEL,
  TARGET_LANGUAGES,
  type SourceLanguage,
  type TargetLanguage,
} from '../../translation/target-language'
import { EXCLUDED_LIMIT_ERROR, normalizeExcludedHost } from '../../translation/page-policy'
import {
  isTemperature,
  normalizeCustomHeaders,
  normalizeRequestParams,
  requestOptionsKey,
  type ApiType,
  type JsonObject,
} from '../../translation/request-options'
import { SITE_SCOPE_INVALID_ERROR, SITE_SCOPE_LIMIT_ERROR, type SiteScopeMode } from '../../translation/site-scope'
import type { TranslationConfig } from '../../translation/config'
import { sendTranslationMessage as send } from '../../translation/client'
import {
  type CustomHeadersState,
  type KeyState,
  type TranslationConfigPatch,
  type TranslationReply,
} from '../../translation/messages'

const props = withDefaults(defineProps<{ view?: 'all' | 'general' | 'model' | 'sites' }>(), { view: 'all' })
const sectionTitle = computed(() => props.view === 'model'
  ? 'wt-title'
  : props.view === 'sites' ? 'wt-site-settings-title' : 'wt-general-title')
const FLOATING_WEB_ORIGINS = ['http://*/*', 'https://*/*']
const allSitesGranted = ref(false)
const grantingAccess = ref(false)
let floatingAccessEpoch = 0

type AssistMode = 'off' | 'toolbar' | 'selection' | 'smart'
type InvalidAdvancedField = 'temperature' | 'requestParams' | 'customHeaders' | null

interface ShortcutItem {
  readonly name: string
  readonly labelKey: MessageKey
  readonly shortcut: string
}

const { t } = useI18n()
const toast = createToastSource()

let persistedBase = ''
let persistedModel = ''
let persistedOptionsKey = requestOptionsKey(DEFAULT_TRANSLATION_CONFIG)
const ready = ref(false)
const saving = ref(false)
const testing = ref(false)
const baseUrl = ref('')
const model = ref('')
const apiType = ref<ApiType>('chat-completions')
const temperatureDraft = ref('')
const requestParamsDraft = ref('')
const customHeadersDraft = ref('')
const apiKey = ref('')
const keyState = ref<KeyState>('none')
const customHeadersState = ref<CustomHeadersState>('none')
const invalidField = ref<InvalidAdvancedField>(null)
const advancedDetails = ref<HTMLDetailsElement | null>(null)
const origins = ref<string[]>([])
const excludedHosts = ref<string[]>([])
const newExcludedHost = ref('')
const siteScopeMode = ref<SiteScopeMode>('all')
const siteScopeHosts = ref<string[]>([])
const newScopeHost = ref('')
const selectionPopupEnabled = ref(false)
const toolbarEnabled = ref(false)
const proactiveAssistEnabled = ref(false)
const assistMode = ref<AssistMode>('off')
const floatingButtonEnabled = ref(false)
const autoInteractionEnabled = ref(true)
const shortcuts = ref<ShortcutItem[]>([])
const newSite = ref('')
const statusMessage = ref('')
const statusError = ref(false)
const modelChoices = ref<string[]>([])
const fetchingModels = ref(false)
const modelsMessage = ref('')
const modelsError = ref(false)
let modelLookupId: string | undefined

function cancelModelLookup(): void {
  const id = modelLookupId
  modelLookupId = undefined
  fetchingModels.value = false
  if (id !== undefined) {
    modelsMessage.value = ''
    modelsError.value = false
    void send({ type: 'wt:cancel-models', requestId: id })
  }
}

function invalidateModelChoices(): void {
  cancelModelLookup()
  modelChoices.value = []
  modelsMessage.value = ''
  modelsError.value = false
}

watch([baseUrl, apiKey, apiType, customHeadersDraft], invalidateModelChoices, { flush: 'sync' })

const targetLanguage = ref<TargetLanguage>('zh-CN')
const sourceLanguage = ref<SourceLanguage>('auto')
const apiTypeOptions = computed(() => [
  { value: 'chat-completions', label: t('wtApiChat') },
  { value: 'responses', label: t('wtApiResponses') },
])
const endpointPreview = computed(() => completionUrl(baseUrl.value, apiType.value))
const requestParamsPlaceholder = computed(() =>
  apiType.value === 'responses'
    ? '{\n  "reasoning": {\n    "effort": "medium"\n  }\n}'
    : '{\n  "reasoning_effort": "medium"\n}',
)
const customHeadersPlaceholder = '{\n  "X-Custom-Header": "value"\n}'
const languageOptions = computed(() =>
  TARGET_LANGUAGES.map((value) => ({ value, label: TARGET_LANGUAGE_NATIVE_LABEL[value] })),
)
const sourceLanguageOptions = computed(() => [
  { value: 'auto', label: t('wtSourceAuto') },
  ...TARGET_LANGUAGES.map((value) => ({ value, label: TARGET_LANGUAGE_NATIVE_LABEL[value] })),
])

const modeOptions = computed(() => [
  { value: 'off', label: t('wtModeOff') },
  { value: 'toolbar', label: t('wtModeToolbar') },
  { value: 'selection', label: t('wtModeSelection') },
  { value: 'smart', label: t('wtModeSmart') },
])

const scopeModeOptions = computed(() => [
  { value: 'all', label: t('wtScopeAll') },
  { value: 'include', label: t('wtScopeInclude') },
  { value: 'exclude', label: t('wtScopeExclude') },
])

function setStatus(message: string, error: boolean): void {
  statusMessage.value = message
  statusError.value = error
}

watch(() => props.view, () => setStatus('', false))

function clearInvalid(field: Exclude<InvalidAdvancedField, null>): void {
  if (invalidField.value === field) invalidField.value = null
}

function onTemperatureInput(value: string | number): void {
  temperatureDraft.value = typeof value === 'number' ? String(value) : value
  clearInvalid('temperature')
}

function openAdvanced(): void {
  if (advancedDetails.value !== null) advancedDetails.value.open = true
}

function keyStateFrom(reply: TranslationReply): KeyState {
  if (!reply.ok) return 'none'
  return reply.keyState ?? (reply.hasKey === true ? 'ready' : 'none')
}

function applyConfig(
  config: TranslationConfig,
  state: KeyState,
  replaceDrafts = false,
  headersState?: CustomHeadersState,
): void {
  if (replaceDrafts) {
    baseUrl.value = config.baseUrl
    model.value = config.model
    apiType.value = config.apiType
    temperatureDraft.value = config.temperature === null ? '' : String(config.temperature)
    requestParamsDraft.value =
      Object.keys(config.requestParams).length === 0 ? '' : JSON.stringify(config.requestParams, null, 2)
    customHeadersDraft.value = ''
    invalidField.value = null
    persistedBase = config.baseUrl
    persistedModel = config.model
    persistedOptionsKey = requestOptionsKey(config)
  }
  if (headersState !== undefined) {
    customHeadersState.value = headersState
  } else if (replaceDrafts && config.customHeadersRevision === '') {
    customHeadersState.value = 'none'
  }
  origins.value = [...config.autoOrigins]
  targetLanguage.value = config.targetLanguage
  sourceLanguage.value = config.sourceLanguage
  excludedHosts.value = [...config.excludedHosts]
  siteScopeMode.value = config.siteScopeMode
  siteScopeHosts.value = [...config.siteScopeHosts]
  selectionPopupEnabled.value = config.selectionPopupEnabled
  toolbarEnabled.value = config.selectionToolbarEnabled
  proactiveAssistEnabled.value = config.proactiveAssistEnabled
  floatingButtonEnabled.value = config.floatingButtonEnabled
  autoInteractionEnabled.value = config.autoInteractionEnabled
  assistMode.value = persistedMode()
  keyState.value = state
}

function persistedMode(): AssistMode {
  if (!selectionPopupEnabled.value) return 'off'
  if (toolbarEnabled.value) return 'toolbar'
  return proactiveAssistEnabled.value ? 'smart' : 'selection'
}

const keyHint = computed(() => {
  switch (keyState.value) {
    case 'ready':
      return t('wtKeySaved')
    case 'different-origin':
      return t('wtKeyDifferentOrigin')
    case 'legacy':
      return t('wtKeyLegacy')
    case 'unavailable':
      return t('wtKeyUnavailable')
    default:
      return t('wtNoKey')
  }
})

const customHeadersStatusHint = computed(() => {
  switch (customHeadersState.value) {
    case 'ready':
      return t('wtCustomHeadersSaved')
    case 'different-origin':
      return t('wtCustomHeadersOrigin')
    case 'unavailable':
      return t('wtCustomHeadersUnavailable')
    default:
      return ''
  }
})

async function load(): Promise<void> {
  const reply = await send({ type: 'wt:get-config' })
  if (!reply.ok || reply.config === undefined) {
    setStatus(reply.ok ? t('wtConfigFailed') : reply.error, true)
    return
  }
  ready.value = true
  const state = keyStateFrom(reply)
  applyConfig(reply.config, state, true, reply.customHeadersState)
  if (state === 'unavailable') setStatus(t('wtKeyUnavailable'), true)
  else if (reply.customHeadersState === 'unavailable') setStatus(t('wtCustomHeadersUnavailable'), true)
}

async function savePatch(
  patch: TranslationConfigPatch,
  options?: {
    apiKey?: string
    customHeaders?: Readonly<Record<string, string>>
    expectedConnection?: { baseUrl: string; model: string; requestOptionsKey?: string }
    replaceDrafts?: boolean
  },
): Promise<false | { readonly warning?: string }> {
  const reply = await send({
    type: 'wt:save-config',
    patch,
    ...(options?.apiKey !== undefined && options.apiKey !== '' ? { apiKey: options.apiKey } : {}),
    ...(options?.customHeaders !== undefined ? { customHeaders: options.customHeaders } : {}),
    ...(options?.expectedConnection !== undefined ? { expectedConnection: options.expectedConnection } : {}),
  })
  if (!reply.ok || reply.config === undefined) {
    setStatus(reply.ok ? t('wtConfigFailed') : reply.error, true)
    return false
  }
  applyConfig(reply.config, keyStateFrom(reply), options?.replaceDrafts === true, reply.customHeadersState)
  if (reply.warning !== undefined) setStatus(reply.warning, true)
  return { warning: reply.warning }
}

async function setExcluded(host: string, excluded: boolean): Promise<boolean> {
  const reply = await send({ type: 'wt:set-site-excluded', host, excluded })
  if (!reply.ok && reply.error === EXCLUDED_LIMIT_ERROR) {
    setStatus(t('wtExcludedLimit'), true)
    return false
  }
  if (!reply.ok || reply.config === undefined) {
    setStatus(reply.ok ? t('wtConfigFailed') : reply.error, true)
    return false
  }
  applyConfig(reply.config, keyStateFrom(reply), false, reply.customHeadersState)
  if (reply.warning !== undefined) setStatus(reply.warning, true)
  return true
}

async function changeTargetLanguage(value: TargetLanguage): Promise<void> {
  await savePatch({ targetLanguage: value })
}

async function changeSourceLanguage(value: SourceLanguage): Promise<void> {
  await savePatch({ sourceLanguage: value })
}

async function changeSiteScopeMode(value: SiteScopeMode): Promise<void> {
  if (!ready.value || saving.value || value === siteScopeMode.value) return
  saving.value = true
  setStatus('', false)
  try {
    await savePatch({ siteScopeMode: value })
  } finally {
    saving.value = false
  }
}

async function setScopeHost(host: string, listed: boolean): Promise<boolean> {
  const reply = await send({ type: 'wt:set-site-scope-host', host, listed })
  if (!reply.ok && reply.error === SITE_SCOPE_LIMIT_ERROR) {
    setStatus(t('wtScopeLimit'), true)
    return false
  }
  if (!reply.ok && reply.error === SITE_SCOPE_INVALID_ERROR) {
    setStatus(t('wtScopeInvalid'), true)
    return false
  }
  if (!reply.ok || reply.config === undefined) {
    setStatus(reply.ok ? t('wtConfigFailed') : reply.error, true)
    return false
  }
  applyConfig(reply.config, keyStateFrom(reply), false, reply.customHeadersState)
  if (reply.warning !== undefined) setStatus(reply.warning, true)
  return true
}

async function addScopeHost(): Promise<void> {
  if (!ready.value || saving.value) return
  const host = normalizeExcludedHost(newScopeHost.value)
  if (host === '') {
    setStatus(t('wtScopeInvalid'), true)
    return
  }
  saving.value = true
  setStatus('', false)
  try {
    const saved = await setScopeHost(host, true)
    if (saved) newScopeHost.value = ''
  } finally {
    saving.value = false
  }
}

async function removeScopeHost(host: string): Promise<void> {
  if (!ready.value || saving.value) return
  saving.value = true
  setStatus('', false)
  try {
    await setScopeHost(host, false)
  } finally {
    saving.value = false
  }
}

async function fetchModels(): Promise<void> {
  if (!ready.value || saving.value || testing.value || fetchingModels.value) return
  clearInvalid('customHeaders')
  const base = normalizeBaseUrl(baseUrl.value)
  if (base === '') {
    modelChoices.value = []
    modelsMessage.value = t('wtInvalidValue')
    modelsError.value = true
    return
  }
  let trimmedKey: string | undefined
  if (apiKey.value !== '') {
    try {
      trimmedKey = validateApiKey(apiKey.value)
    } catch {
      modelChoices.value = []
      modelsMessage.value = t('wtKeyInvalid')
      modelsError.value = true
      return
    }
  }
  const trimmedHeaders = customHeadersDraft.value.trim()
  let parsedCustomHeaders: Readonly<Record<string, string>> | undefined
  if (trimmedHeaders !== '') {
    try {
      parsedCustomHeaders = normalizeCustomHeaders(JSON.parse(trimmedHeaders))
    } catch {
      openAdvanced()
      invalidField.value = 'customHeaders'
      modelChoices.value = []
      modelsMessage.value = t('wtCustomHeadersInvalid')
      modelsError.value = true
      return
    }
  }
  const requestId = createId()
  modelLookupId = requestId
  modelChoices.value = []
  fetchingModels.value = true
  modelsMessage.value = t('wtModelsLoading')
  modelsError.value = false
  try {
    const granted = await browser.permissions
      .request({ origins: [hostPermissionPattern(base)] })
      .catch(() => false)
    if (modelLookupId !== requestId) return
    if (!granted) {
      modelsMessage.value = t('wtPermissionDenied')
      modelsError.value = true
      return
    }
    const reply = await send({
      type: 'wt:list-models',
      baseUrl: base,
      requestId,
      ...(trimmedKey !== undefined ? { apiKey: trimmedKey } : {}),
      ...(parsedCustomHeaders !== undefined ? { customHeaders: parsedCustomHeaders } : {}),
    })
    if (modelLookupId !== requestId) return
    if (!reply.ok) {
      modelsMessage.value = reply.error
      modelsError.value = true
      return
    }
    modelChoices.value = [...reply.models]
    modelsMessage.value =
      reply.models.length === 0
        ? t('wtModelsEmpty')
        : t('wtModelsLoaded', { count: reply.models.length })
    modelsError.value = false
  } catch {
    if (modelLookupId === requestId) {
      modelsMessage.value = t('wtPermissionDenied')
      modelsError.value = true
    }
  } finally {
    if (modelLookupId === requestId) {
      modelLookupId = undefined
      fetchingModels.value = false
    }
  }
}

async function saveAndConnect(): Promise<void> {
  if (!ready.value || saving.value || testing.value || fetchingModels.value) return
  setStatus('', false)
  modelsMessage.value = ''
  modelsError.value = false
  invalidField.value = null
  const trimmed = baseUrl.value.trim()
  if (trimmed !== '' && normalizeBaseUrl(trimmed) === '') {
    setStatus(t('wtInvalidValue'), true)
    return
  }
  if (apiKey.value !== '' && !/^[\x21-\x7e]{1,512}$/.test(apiKey.value.trim())) {
    setStatus(t('wtKeyInvalid'), true)
    return
  }
  const temperatureInput = advancedDetails.value?.querySelector<HTMLInputElement>('[data-test="wt-temperature"]')
  if (temperatureInput?.validity.badInput) {
    openAdvanced()
    invalidField.value = 'temperature'
    setStatus(t('wtTemperatureInvalid'), true)
    return
  }
  const trimmedTemp = temperatureDraft.value.trim()
  let parsedTemperature: number | null = null
  if (trimmedTemp !== '') {
    const numeric = Number(trimmedTemp)
    if (!isTemperature(numeric)) {
      openAdvanced()
      invalidField.value = 'temperature'
      setStatus(t('wtTemperatureInvalid'), true)
      return
    }
    parsedTemperature = numeric
  }
  const trimmedParams = requestParamsDraft.value.trim()
  let parsedRequestParams: JsonObject = {}
  if (trimmedParams !== '') {
    try {
      parsedRequestParams = normalizeRequestParams(JSON.parse(trimmedParams))
    } catch {
      openAdvanced()
      invalidField.value = 'requestParams'
      setStatus(t('wtRequestParamsInvalid'), true)
      return
    }
  }
  const trimmedHeaders = customHeadersDraft.value.trim()
  let parsedCustomHeaders: Readonly<Record<string, string>> | undefined
  if (trimmedHeaders !== '') {
    try {
      parsedCustomHeaders = normalizeCustomHeaders(JSON.parse(trimmedHeaders))
    } catch {
      openAdvanced()
      invalidField.value = 'customHeaders'
      setStatus(t('wtCustomHeadersInvalid'), true)
      return
    }
  }
  saving.value = true
  try {
    const endpoint = trimmed === '' ? '' : completionUrl(trimmed, apiType.value)
    if (endpoint !== '') {
      const granted = await browser.permissions
        .request({ origins: [hostPermissionPattern(endpoint)] })
        .catch(() => false)
      if (!granted) {
        setStatus(t('wtPermissionDenied'), true)
        return
      }
    }
    const saved = await savePatch(
      {
        baseUrl: trimmed,
        model: model.value.trim(),
        apiType: apiType.value,
        temperature: parsedTemperature,
        requestParams: parsedRequestParams,
      },
      {
        apiKey: apiKey.value !== '' ? apiKey.value : undefined,
        customHeaders: parsedCustomHeaders,
        expectedConnection: {
          baseUrl: persistedBase,
          model: persistedModel,
          requestOptionsKey: persistedOptionsKey,
        },
        replaceDrafts: true,
      },
    )
    if (!saved) return
    apiKey.value = ''
    customHeadersDraft.value = ''
    if (saved.warning !== undefined) return
    if (trimmed === '' || model.value.trim() === '') {
      setStatus(t('saved'), false)
      return
    }
    testing.value = true
    try {
      const reply = await send({ type: 'wt:test' })
      setStatus(reply.ok ? t('wtSavedOk') : t('wtSavedFail', { error: reply.error }), !reply.ok)
    } finally {
      testing.value = false
    }
  } finally {
    saving.value = false
  }
}

async function changeAutoInteraction(enabled: boolean): Promise<void> {
  if (!ready.value || saving.value || enabled === autoInteractionEnabled.value) return
  saving.value = true
  setStatus('', false)
  try {
    await savePatch({ autoInteractionEnabled: enabled })
  } finally {
    saving.value = false
  }
}

async function changeFloatingButton(enabled: boolean): Promise<void> {
  if (!ready.value || saving.value || enabled === floatingButtonEnabled.value) return
  saving.value = true
  setStatus('', false)
  try {
    const saved = await savePatch({ floatingButtonEnabled: enabled })
    if (!saved) toast.show('danger', 'saveFailed')
    else toast.clear()
  } finally {
    saving.value = false
  }
}

async function refreshFloatingAccess(): Promise<void> {
  if (grantingAccess.value) return
  const epoch = ++floatingAccessEpoch
  try {
    const granted = await browser.permissions.contains({ origins: FLOATING_WEB_ORIGINS })
    if (epoch === floatingAccessEpoch) allSitesGranted.value = granted
  } catch {
    if (epoch === floatingAccessEpoch) allSitesGranted.value = false
  }
}

async function grantFloatingSites(): Promise<void> {
  if (!ready.value || saving.value || grantingAccess.value || allSitesGranted.value) return
  grantingAccess.value = true
  const epoch = ++floatingAccessEpoch
  setStatus('', false)
  toast.clear()
  try {
    const granted = await browser.permissions.request({ origins: FLOATING_WEB_ORIGINS })
    if (epoch !== floatingAccessEpoch) return
    allSitesGranted.value = granted
    if (!granted) setStatus(t('wtPermissionDenied'), true)
  } catch {
    if (epoch === floatingAccessEpoch) setStatus(t('wtPermissionDenied'), true)
  } finally {
    grantingAccess.value = false
  }
}

async function changeAssistMode(mode: AssistMode): Promise<void> {
  if (!ready.value || saving.value || mode === assistMode.value) return
  const desiredSelection = mode !== 'off'
  const desiredToolbar = mode === 'toolbar'
  const desiredProactive = mode === 'smart'
  if (
    desiredSelection === selectionPopupEnabled.value &&
    desiredToolbar === toolbarEnabled.value &&
    desiredProactive === proactiveAssistEnabled.value
  ) {
    assistMode.value = mode
    return
  }
  assistMode.value = mode
  saving.value = true
  try {
    if (mode !== 'off') {
      const granted = await browser.permissions
        .request({ origins: ['http://*/*', 'https://*/*'] })
        .catch(() => false)
      if (!granted) {
        assistMode.value = persistedMode()
        setStatus(t('wtPermissionDenied'), true)
        return
      }
    }
    const saved = await savePatch({
      selectionPopupEnabled: desiredSelection,
      selectionToolbarEnabled: desiredToolbar,
      proactiveAssistEnabled: desiredProactive,
    })
    if (!saved) {
      assistMode.value = persistedMode()
    }
  } finally {
    saving.value = false
  }
}

async function deleteKey(): Promise<void> {
  if (!ready.value || saving.value || fetchingModels.value) return
  saving.value = true
  try {
    const reply = await send({ type: 'wt:clear-key' })
    if (reply.ok) {
      invalidateModelChoices()
      keyState.value = 'none'
      apiKey.value = ''
      setStatus('', false)
    } else {
      setStatus(reply.error, true)
    }
  } finally {
    saving.value = false
  }
}

async function clearCache(): Promise<void> {
  if (!ready.value || saving.value) return
  saving.value = true
  try {
    const reply = await send({ type: 'wt:clear-cache' })
    setStatus(reply.ok ? t('wtClearCacheDone') : t('wtClearCacheFailed'), !reply.ok)
  } finally {
    saving.value = false
  }
}

async function addSite(): Promise<void> {
  if (!ready.value || saving.value) return
  const origin = normalizeOrigin(newSite.value)
  if (origin === '') {
    setStatus(t('wtInvalidValue'), true)
    return
  }
  if (origins.value.includes(origin)) {
    setStatus(t('exists'), true)
    return
  }
  saving.value = true
  try {
    const granted = await browser.permissions
      .request({ origins: [hostPermissionPattern(origin)] })
      .catch(() => false)
    if (!granted) {
      setStatus(t('wtPermissionDenied'), true)
      return
    }
    const reply = await send({ type: 'wt:set-site-auto', origin, enabled: true })
    if (!reply.ok || reply.config === undefined) {
      setStatus(reply.ok ? t('wtConfigFailed') : reply.error, true)
      return
    }
    applyConfig(reply.config, keyStateFrom(reply), false, reply.customHeadersState)
    newSite.value = ''
  } finally {
    saving.value = false
  }
}

async function removeSite(origin: string): Promise<void> {
  if (!ready.value || saving.value) return
  saving.value = true
  try {
    const reply = await send({ type: 'wt:set-site-auto', origin, enabled: false })
    if (!reply.ok || reply.config === undefined) {
      setStatus(reply.ok ? t('wtConfigFailed') : reply.error, true)
      return
    }
    applyConfig(reply.config, keyStateFrom(reply), false, reply.customHeadersState)
  } finally {
    saving.value = false
  }
}

async function addExcluded(): Promise<void> {
  if (!ready.value || saving.value) return
  const host = normalizeExcludedHost(newExcludedHost.value)
  if (host === '') {
    setStatus(t('wtInvalidValue'), true)
    return
  }
  saving.value = true
  setStatus('', false)
  try {
    const saved = await setExcluded(host, true)
    if (saved) newExcludedHost.value = ''
  } finally {
    saving.value = false
  }
}

async function removeExcluded(host: string): Promise<void> {
  if (!ready.value || saving.value) return
  saving.value = true
  setStatus('', false)
  try {
    await setExcluded(host, false)
  } finally {
    saving.value = false
  }
}

async function loadShortcuts(): Promise<void> {
  try {
    const all = await browser.commands?.getAll?.()
    if (!Array.isArray(all)) {
      shortcuts.value = []
      return
    }
    const items: ShortcutItem[] = []
    for (const command of all) {
      if (command.name === 'toggle-page-translation') {
        items.push({ name: command.name, labelKey: 'wtCmdTogglePage', shortcut: command.shortcut ?? '' })
      } else if (command.name === 'translate-selection') {
        items.push({ name: command.name, labelKey: 'wtCmdTranslateSelection', shortcut: command.shortcut ?? '' })
      }
    }
    shortcuts.value = items
  } catch {
    shortcuts.value = []
  }
}

async function openShortcuts(): Promise<void> {
  try {
    await browser.tabs.create({ url: 'chrome://extensions/shortcuts' })
  } catch {
    toast.show('danger', 'wtShortcutsOpenFailed')
  }
}

/** 从浏览器的快捷键页改完回来时重新读取绑定 */
function refreshShortcuts(): void {
  if (document.visibilityState !== 'visible') return
  void loadShortcuts()
  void refreshFloatingAccess()
}

onMounted(() => {
  void load()
  void loadShortcuts()
  void refreshFloatingAccess()
  document.addEventListener('visibilitychange', refreshShortcuts)
  window.addEventListener('focus', refreshShortcuts)
})

onBeforeUnmount(() => {
  cancelModelLookup()
  floatingAccessEpoch += 1
  document.removeEventListener('visibilitychange', refreshShortcuts)
  window.removeEventListener('focus', refreshShortcuts)
})
</script>

<style scoped>
.wt-fields {
  display: grid;
  align-items: start;
  gap: 16px;
}

.wt-language-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 16px;
}

@media (max-width: 599px) {
  .wt-language-pair {
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

.wt-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

@media (max-width: 480px) {
  .wt-model-row {
    grid-template-columns: minmax(0, 1fr);
    justify-items: start;
  }

  .wt-model-row :deep(.ui-input) {
    width: 100%;
  }
}

.wt-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--gcn-fg);
}

.wt-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--gcn-fg-muted);
}

.wt-endpoint-preview {
  overflow-wrap: anywhere;
  font-family: var(--gcn-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--gcn-fg-muted);
}

.wt-advanced-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 4px 12px;
}

.wt-advanced-summary::-webkit-details-marker {
  display: none;
}

.wt-advanced-chevron {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}

.wt-advanced[open] .wt-advanced-chevron {
  transform: rotate(90deg);
}

.wt-advanced-summary-hint {
  margin-left: auto;
  font-weight: 400;
}

.wt-code-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  resize: vertical;
  font-family: var(--gcn-font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.wt-code-textarea:focus-visible {
  outline: 2px solid var(--gcn-focus);
  outline-offset: -1px;
  border-color: var(--gcn-focus);
}

.section-actions :deep(.ui-button-primary) {
  padding: 0 18px;
  font-weight: 600;
}

.wt-status {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--gcn-success-fg, #1a7f37);
}

.wt-status-error {
  color: var(--gcn-danger-fg, #cf222e);
}

.wt-reading-group {
  display: grid;
  gap: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--gcn-border-muted);
}

.wt-floating-group {
  display: grid;
  gap: 4px;
}

.wt-subtitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--gcn-fg);
}

.wt-sites {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wt-site {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: var(--gcn-control-sm, 28px);
  padding: 6px 10px;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius);
}

.wt-origin {
  overflow-wrap: anywhere;
  font-size: 13px;
}

.wt-add {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.wt-add > :first-child {
  flex: 1;
  min-width: 0;
}

.wt-scope-field {
  display: grid;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}

.wt-details {
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius-lg, 8px);
  padding: 12px 16px;
  background: var(--gcn-bg-muted);
}

.wt-details > summary {
  cursor: pointer;
  font-weight: 600;
  user-select: none;
}

.wt-details-body {
  display: grid;
  gap: 16px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--gcn-border-muted);
}

.wt-site-group {
  display: grid;
  gap: 8px;
}

.wt-site-group + .wt-site-group {
  padding-top: 14px;
  border-top: 1px solid var(--gcn-border-muted);
}

.wt-site-group :deep(.ui-select) {
  width: 100%;
  max-width: 380px;
}

.wt-shortcuts {
  display: grid;
  gap: 8px;
  justify-items: start;
}

.wt-shortcut-list {
  display: grid;
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wt-shortcut-list > li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius);
}

.wt-shortcut-list kbd {
  padding: 2px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--gcn-fg);
  background: var(--gcn-bg);
  border: 1px solid var(--gcn-border);
  border-radius: 4px;
}

.wt-privacy-note {
  padding-top: 4px;
}

.wt-settings-view {
  display: grid;
  gap: 16px;
}
.wt-settings-view > .wt-reading-group {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.wt-floating-grant {
  justify-self: start;
  max-width: 100%;
}
@media (min-width: 680px) {
  .wt-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .wt-fields > .wt-field:last-child {
    grid-column: 1 / -1;
  }
}
</style>
