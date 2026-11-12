<template>
  <section class="popup-engines" aria-labelledby="wt-engines-title">
    <h2 id="wt-engines-title" class="sr-only">{{ t('wtPageTitle') }}</h2>

    <div class="popup-engine">
      <span class="engine-tag engine-tag-dict">{{ t('wtEngineDict') }}</span>
      <div class="popup-engine-body">
        <div class="popup-engine-row">
          <span class="popup-engine-name">{{ githubPage ? t('wtGithubDictionary') : t('wtDictionary') }}</span>
          <span class="popup-row-end">
            <UiBadge
              v-if="showGithubState"
              :tone="githubTone"
              dot
              :live="githubLive"
              v-bind="githubStateTest"
            >
              {{ t(PAGE_STATE_MESSAGE[githubState]) }}
            </UiBadge>
            <UiBadge v-else :tone="dictEnabled ? 'success' : 'neutral'" dot>
              {{ dictEnabled ? t('wtDictOn') : t('wtDictOff') }}
            </UiBadge>
            <UiButton v-if="githubState === 'not-ready'" size="sm" @click="emit('reload')">{{ t('reload') }}</UiButton>
            <UiButton v-else-if="githubState === 'unauthorized'" variant="primary" size="sm" @click="emit('authorize')">
              {{ t('authorize') }}
            </UiButton>
          </span>
        </div>
        <p class="ui-hint">{{ t('wtOfflineHint') }}</p>
      </div>
    </div>

    <template v-if="translationSupported">
      <div class="popup-engine">
        <span class="engine-tag engine-tag-model">{{ t('wtEngineModel') }}</span>
        <div class="popup-engine-body">
          <div class="popup-engine-row">
            <span class="popup-engine-name" :title="modelName || t('wtModelUnset')">{{ modelName || t('wtModelUnset') }}</span>
          </div>
          <p class="ui-hint">{{ t('wtModelEndpointHint') }}</p>
          <template v-if="modelConfigured">
            <UiSwitch
              :checked="autoEnabled"
              :disabled="autoDisabled"
              :label="t('wtSiteAuto')"
              :aria-describedby="autoReason !== '' ? 'wt-auto-reason' : undefined"
              data-test="wt-auto"
              @change="setAuto"
            />
            <p v-if="autoReason" id="wt-auto-reason" class="ui-hint">
              {{ t(autoReason) }}
              <button
                v-if="autoReason === 'wtNotConfigured'"
                type="button"
                class="popup-reason-link"
                data-test="wt-go-configure"
                @click="openOptionsAt('#wt-title')"
              >
                {{ t('wtGoConfigure') }}
              </button>
            </p>
          </template>
          <div v-else class="popup-model-guide">
            <p class="ui-hint">{{ t('wtModelSetupHint') }}</p>
            <UiButton v-if="!canTranslate || sensitive || canRestore || canResume" size="sm" data-test="wt-configure-now" @click="openOptionsAt('#wt-title')">
              {{ t('wtConfigureNow') }}
            </UiButton>
          </div>
        </div>
      </div>

      <details class="popup-more" :open="moreOpen" @toggle="onMoreToggle">
        <summary>
          <svg class="popup-more-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ t('wtMoreFeatures') }}</span>
        </summary>
        <div class="popup-more-body">
          <div class="popup-switch">
            <UiSwitch
              :checked="autoInteractionEnabled"
              :disabled="moreDisabled"
              :label="t('wtAutomaticInteractions')"
              :title="t('wtAutomaticInteractionsHint')"
              :aria-describedby="moreReason !== '' ? 'wt-more-reason' : undefined"
              data-test="wt-popup-auto-interaction"
              @change="setAutoInteraction"
            />
          </div>
          <div class="popup-switch">
            <UiSwitch
              :checked="floatingEnabled"
              :disabled="moreDisabled"
              :label="t('wtFloatingButton')"
              :aria-describedby="moreReason !== '' ? 'wt-more-reason' : undefined"
              data-test="wt-popup-floating"
              @change="setFloating"
            />
          </div>
          <div class="popup-switch">
            <UiSwitch
              :checked="inputTranslationEnabled"
              :disabled="moreDisabled"
              :label="t('wtInputTranslation')"
              :aria-describedby="moreReason !== '' ? 'wt-more-reason' : undefined"
              data-test="wt-popup-input-translation"
              @change="setInputTranslation"
            />
          </div>
          <p v-if="moreReason" id="wt-more-reason" class="ui-hint" data-test="wt-more-reason">{{ t(moreReason) }}</p>
        </div>
      </details>
    </template>

    <p v-if="autoError" class="wt-page-error" role="alert" data-test="wt-auto-error">{{ t(autoError) }}</p>
    <p v-if="pageError" class="wt-page-error" role="alert" data-test="wt-page-error">{{ pageError }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import UiBadge from '../../components/ui/UiBadge.vue'
import UiButton from '../../components/ui/UiButton.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import type { UiBadgeTone } from '../../components/ui/types'
import { useI18n } from '../../components/ui-preferences'
import { isFirefoxBuild } from '../../shared/extension'
import { PAGE_STATE_MESSAGE, type PageState } from './usePopup'
import { useProvidedTranslationControls } from './useTranslationControls'

const POPUP_MORE_KEY = 'gcn:popup-more-open'
const translationSupported = !isFirefoxBuild()

const props = withDefaults(defineProps<{
  githubState?: PageState
  githubPage?: boolean
}>(), {
  githubState: 'loading',
  githubPage: false,
})

const emit = defineEmits<{
  authorize: []
  reload: []
}>()

const { t } = useI18n()
const {
  autoEnabled,
  canTranslate,
  canRestore,
  canResume,
  floatingEnabled,
  autoInteractionEnabled,
  inputTranslationEnabled,
  configurationReady,
  masterEnabled,
  modelConfigured,
  modelName,
  sensitive,
  dictEnabled,
  pageError,
  autoError,
  busy,
  setFloating,
  setAutoInteraction,
  setAuto,
  setInputTranslation,
  openOptionsAt,
} = useProvidedTranslationControls()

function readMoreOpen(): boolean {
  try {
    return localStorage.getItem(POPUP_MORE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeMoreOpen(open: boolean): void {
  try {
    localStorage.setItem(POPUP_MORE_KEY, String(open))
  } catch {
    // 存储不可用时只影响下次打开
  }
}

const moreOpen = ref(readMoreOpen())

function onMoreToggle(event: Event): void {
  const details = event.currentTarget as HTMLDetailsElement
  moreOpen.value = details.open
  writeMoreOpen(details.open)
}

// 需要用户处理的 GitHub 状态（未授权、未就绪）及 Firefox 构建：保留原状态行的 data-test
const githubNeedsAction = computed(
  () => !translationSupported || props.githubState === 'unauthorized' || props.githubState === 'not-ready',
)

// GitHub 页面由独立的汉化引擎处理，词典行显示它的状态，而不是网页翻译引擎的 fixed
const showGithubState = computed(() => props.githubPage || githubNeedsAction.value)

// 一页只留一个读屏状态区：有网页翻译状态卡时由它播报，词典行只在 Firefox 构建（没有状态卡）时播报
const githubLive = computed(() => !translationSupported)

const githubStateTest = computed(() => (githubNeedsAction.value ? { 'data-test': 'state' } : {}))

const githubTone = computed<UiBadgeTone>(() => {
  switch (props.githubState) {
    case 'translated':
      return 'success'
    case 'not-ready':
      return 'attention'
    case 'unauthorized':
      return 'danger'
    default:
      return 'neutral'
  }
})

const moreDisabled = computed(() => busy.value || !configurationReady.value || !masterEnabled.value)

const moreReason = computed(() => {
  if (!configurationReady.value) return 'wtConfigUnreadable' as const
  if (!masterEnabled.value) return 'wtMasterOff' as const
  return ''
})

const autoDisabled = computed(
  () =>
    busy.value ||
    !configurationReady.value ||
    !masterEnabled.value ||
    !modelConfigured.value ||
    (!autoEnabled.value && !canTranslate.value),
)

const autoReason = computed(() => {
  if (!autoDisabled.value) return ''
  if (!configurationReady.value) return 'wtConfigUnreadable' as const
  if (!masterEnabled.value) return 'wtMasterOff' as const
  if (!modelConfigured.value) return 'wtNotConfigured' as const
  return ''
})
</script>

<style scoped>
.popup-engines {
  display: grid;
  gap: 12px;
}

.popup-engine {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px 10px;
  align-items: start;
}

.engine-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  border-radius: 999px;
}

.engine-tag-dict {
  color: var(--gcn-engine-dict-fg);
  background: var(--gcn-engine-dict-bg);
}

.engine-tag-model {
  color: var(--gcn-engine-model-fg);
  background: var(--gcn-engine-model-bg);
}

.popup-engine-body {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.popup-engine-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: var(--gcn-control-sm);
}

.popup-engine-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popup-row-end {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.popup-more > summary {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  font-weight: 600;
}

.popup-more > summary::-webkit-details-marker {
  display: none;
}

.popup-more-chevron {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}

.popup-more[open] .popup-more-chevron {
  transform: rotate(90deg);
}

.popup-more-body {
  display: grid;
  gap: 6px;
  padding-top: 10px;
}

.popup-reason-link {
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--gcn-accent);
  background: none;
  border: 0;
  cursor: pointer;
}

.popup-model-guide {
  display: grid;
  gap: 8px;
  justify-items: start;
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

@media (forced-colors: active) {
  .popup-reason-link {
    text-decoration: underline;
  }
}
</style>
