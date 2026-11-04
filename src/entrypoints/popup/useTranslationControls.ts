import { computed, onMounted, onUnmounted, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import { browser } from 'wxt/browser'
import { createToastSource } from '../../components/toast'
import type { MessageKey } from '../../i18n'
import { getSettings, watchSettings } from '../../shared/settings'
import { hostPermissionPattern, normalizeOrigin, watchTranslationConfig, type TranslationConfig } from '../../translation/config'
import { isSiteScopeAllowed } from '../../translation/site-scope'
import { sendTranslationMessage } from '../../translation/client'
import {
  isContentTranslationReply,
  type ContentTranslationMessage,
  type PageAction,
  type PageTranslationStatus,
} from '../../translation/messages'

export type WtState =
  | 'unsupported'
  | 'not-configured'
  | 'on'
  | 'page'
  | 'off'
  | 'paused'
  | 'capped'
  | 'error'
  | 'fixed'
  | 'master-off'
  | 'inactive'
  | 'out-of-scope'

export const WT_STATE_MESSAGE: Readonly<Record<WtState, MessageKey>> = {
  unsupported: 'wtUnsupportedPage',
  'not-configured': 'wtNotConfigured',
  on: 'wtAutoOn',
  page: 'wtPageOn',
  off: 'wtAutoOff',
  paused: 'wtAutoPaused',
  capped: 'wtAutoCapped',
  error: 'wtAutoError',
  fixed: 'wtStateFixed',
  'master-off': 'wtMasterOff',
  inactive: 'wtAutoInactive',
  'out-of-scope': 'wtScopeBlocked',
}

interface ActiveTab {
  readonly id: number
  readonly origin: string
  readonly url: string
}

export interface UseTranslationControls {
  readonly supported: ComputedRef<boolean>
  readonly origin: ComputedRef<string>
  readonly state: ComputedRef<WtState>
  readonly autoEnabled: ComputedRef<boolean>
  readonly canTranslate: ComputedRef<boolean>
  readonly floatingEnabled: ComputedRef<boolean>
  readonly configurationReady: ComputedRef<boolean>
  readonly pageError: Readonly<Ref<string>>
  readonly canRestore: ComputedRef<boolean>
  readonly canResume: ComputedRef<boolean>
  readonly failedCount: ComputedRef<number>
  readonly canRetryFailed: ComputedRef<boolean>
  readonly asking: Ref<boolean>
  readonly busy: Readonly<Ref<boolean>>
  translatePage(): Promise<void>
  setFloating(enabled: boolean): Promise<void>
  confirmEnable(): Promise<void>
  disableAuto(): Promise<void>
  cancelConsent(): void
  askConsent(): void
  restore(): Promise<void>
  resume(): Promise<void>
  retryFailed(): Promise<void>
  openSettings(): Promise<void>
}

async function queryActiveTab(): Promise<ActiveTab | undefined> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (
      tab?.id === undefined || !Number.isSafeInteger(tab.id) || tab.id < 0 ||
      tab.incognito === true || typeof tab.url !== 'string' || tab.url.length > 8192
    ) return undefined
    const origin = normalizeOrigin(tab.url)
    return origin === '' ? undefined : { id: tab.id, origin, url: tab.url }
  } catch {
    return undefined
  }
}

async function queryStatus(tabId: number): Promise<PageTranslationStatus | undefined> {
  const message: ContentTranslationMessage = { type: 'wt:status' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reply: unknown = await Promise.race([
      Promise.resolve().then(() => browser.tabs.sendMessage(tabId, message, { frameId: 0 })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 1500)
      }),
    ])
    if (isContentTranslationReply(reply, message) && reply.ok) return reply.status
  } catch {
    void 0
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return undefined
}

export function useTranslationControls(): UseTranslationControls {
  const tab = shallowRef<ActiveTab>()
  const status = shallowRef<PageTranslationStatus>()
  const config = shallowRef<TranslationConfig>()
  const masterEnabled = ref(false)
  const asking = ref(false)
  const busy = ref(false)
  const loaded = ref(false)
  const pageError = ref('')
  let disposed = false
  let loadEpoch = 0
  const toast = createToastSource()

  const supported = computed(() => loaded.value && tab.value !== undefined)
  const origin = computed(() => tab.value?.origin ?? '')
  const autoEnabled = computed(() => tab.value !== undefined && (config.value?.autoOrigins ?? []).includes(origin.value))
  const outOfScope = computed(() => {
    const currentConfig = config.value
    const active = tab.value
    if (currentConfig === undefined || active === undefined) return false
    return !isSiteScopeAllowed(active.origin, currentConfig)
  })
  const configurationReady = computed(() => loaded.value && config.value !== undefined)
  const floatingEnabled = computed(() => config.value?.floatingButtonEnabled === true)
  const canTranslate = computed(() =>
    supported.value && masterEnabled.value && configurationReady.value && !outOfScope.value,
  )
  const canRestore = computed(
    () => masterEnabled.value && !outOfScope.value && status.value?.supported === true &&
      (status.value.fixed || status.value.auto || status.value.paused || status.value.capped),
  )
  const canResume = computed(
    () =>
      masterEnabled.value &&
      !outOfScope.value &&
      status.value?.supported === true &&
      (status.value.paused || status.value.error !== ''),
  )
  const failedCount = computed(() => (masterEnabled.value ? (status.value?.failed ?? 0) : 0))
  // 暂停时「继续翻译」已包含重试；上限时要先追加额度。
  const canRetryFailed = computed(() => failedCount.value > 0 && status.value?.auto === true && !outOfScope.value)

  const state = computed<WtState>(() => {
    if (!loaded.value) return 'off'
    const current = tab.value
    if (current === undefined) return 'unsupported'
    if (!masterEnabled.value) return 'master-off'
    if (outOfScope.value) return 'out-of-scope'
    const page = status.value
    if (page !== undefined && page.error !== '') return 'error'
    if (page?.capped) return 'capped'
    if (page?.paused) return 'paused'
    const configured = config.value !== undefined && config.value.baseUrl !== '' && config.value.model !== ''
    if (page?.auto && !autoEnabled.value) return configured ? 'page' : 'not-configured'
    if (autoEnabled.value) {
      if (!configured) return 'not-configured'
      return page !== undefined && page.supported && page.auto ? 'on' : 'inactive'
    }
    if (page?.fixed) return 'fixed'
    return 'off'
  })

  async function load(): Promise<void> {
    const epoch = ++loadEpoch
    const [active, reply, settings] = await Promise.all([
      queryActiveTab(),
      sendTranslationMessage({ type: 'wt:get-config' }),
      getSettings().catch(() => undefined),
    ])
    if (disposed || epoch !== loadEpoch) return
    const nextStatus = active !== undefined ? await queryStatus(active.id) : undefined
    if (disposed || epoch !== loadEpoch) return
    masterEnabled.value = settings?.enabled === true
    tab.value = active
    config.value = reply.ok && reply.config !== undefined ? reply.config : undefined
    status.value = nextStatus
    loaded.value = true
  }

  async function translatePage(): Promise<void> {
    const current = tab.value
    const currentConfig = config.value
    if (disposed || busy.value || !canTranslate.value || current === undefined || currentConfig === undefined) return
    busy.value = true
    asking.value = false
    pageError.value = ''
    toast.clear()
    try {
      if (currentConfig.baseUrl === '' || currentConfig.model === '') {
        await browser.tabs.create({ url: browser.runtime.getURL('/options.html') + '#wt-title' })
        if (!disposed) window.close()
        return
      }
      const reply = await sendTranslationMessage({ type: 'wt:translate-page', tabId: current.id, url: current.url })
      if (disposed) return
      await load()
      if (!disposed && !reply.ok) pageError.value = reply.error
    } catch {
      if (!disposed) toast.show('danger', 'openFailed')
    } finally {
      busy.value = false
    }
  }

  async function setFloating(enabled: boolean): Promise<void> {
    if (disposed || busy.value || !configurationReady.value || enabled === floatingEnabled.value) return
    busy.value = true
    pageError.value = ''
    toast.clear()
    try {
      const reply = await sendTranslationMessage({ type: 'wt:save-config', patch: { floatingButtonEnabled: enabled } })
      if (disposed) return
      if (!reply.ok || reply.config === undefined) {
        if (!reply.ok) pageError.value = reply.error
        else toast.show('danger', 'saveFailed')
        return
      }
      config.value = reply.config
      await load()
      if (!disposed && reply.warning !== undefined) pageError.value = reply.warning
    } catch {
      if (!disposed) toast.show('danger', 'saveFailed')
    } finally {
      busy.value = false
    }
  }

  function askConsent(): void {
    toast.clear()
    if (busy.value || tab.value === undefined) return
    pageError.value = ''
    if (outOfScope.value) {
      asking.value = false
      toast.show('danger', 'wtScopeBlocked')
      return
    }
    asking.value = true
  }

  function cancelConsent(): void {
    asking.value = false
  }

  async function confirmEnable(): Promise<void> {
    const current = tab.value
    const currentConfig = config.value
    if (current === undefined || currentConfig === undefined || busy.value) return
    pageError.value = ''
    if (outOfScope.value) {
      asking.value = false
      toast.show('danger', 'wtScopeBlocked')
      return
    }
    busy.value = true
    try {
      const granted = await browser.permissions
        .request({ origins: [hostPermissionPattern(current.origin)] })
        .catch(() => false)
      if (!granted) {
        asking.value = false
        toast.show('danger', 'wtPermissionDenied')
        return
      }
      const reply = await sendTranslationMessage({ type: 'wt:set-site-auto', origin: current.origin, enabled: true })
      if (reply.ok && reply.config !== undefined) {
        config.value = reply.config
        asking.value = false
        toast.clear()
        status.value = await queryStatus(current.id)
        return
      }
      toast.show('danger', 'saveFailed')
    } finally {
      busy.value = false
    }
  }

  async function disableAuto(): Promise<void> {
    const current = tab.value
    if (current === undefined || busy.value) return
    pageError.value = ''
    busy.value = true
    try {
      const reply = await sendTranslationMessage({ type: 'wt:set-site-auto', origin: current.origin, enabled: false })
      if (reply.ok && reply.config !== undefined) {
        config.value = reply.config
        status.value = await queryStatus(current.id)
        return
      }
      toast.show('danger', 'saveFailed')
    } finally {
      busy.value = false
    }
  }

  async function pageAction(action: PageAction): Promise<void> {
    const current = tab.value
    if (current === undefined || busy.value) return
    pageError.value = ''
    busy.value = true
    toast.clear()
    try {
      const reply = await sendTranslationMessage({
        type: 'wt:page-action', action, tabId: current.id, url: current.url,
      })
      if (!reply.ok) {
        toast.show('danger', 'openFailed')
        return
      }
      status.value = await queryStatus(current.id)
    } finally {
      busy.value = false
    }
  }

  async function openSettings(): Promise<void> {
    try {
      await browser.runtime.openOptionsPage()
      window.close()
    } catch {
      toast.show('danger', 'openFailed')
    }
  }

  const unwatchSettings = watchSettings((next) => {
    masterEnabled.value = next.enabled
    void load()
  })
  const unwatchConfig = watchTranslationConfig(() => {
    void load()
  })

  onMounted(() => {
    void load()
  })
  onUnmounted(() => {
    disposed = true
    loadEpoch += 1
    unwatchSettings()
    unwatchConfig()
  })

  return {
    supported,
    origin,
    state,
    autoEnabled,
    canTranslate,
    floatingEnabled,
    configurationReady,
    pageError,
    canRestore,
    canResume,
    failedCount,
    canRetryFailed,
    asking,
    busy,
    translatePage,
    setFloating,
    confirmEnable,
    disableAuto,
    cancelConsent,
    askConsent,
    restore: () => pageAction('restore'),
    resume: () => pageAction('resume'),
    retryFailed: () => pageAction('retry-failed'),
    openSettings,
  }
}
