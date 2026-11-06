import {
  computed,
  inject,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue'
import { browser } from 'wxt/browser'
import { createToastSource } from '../../components/toast'
import type { UiBadgeTone } from '../../components/ui/types'
import type { MessageKey } from '../../i18n'
import { getSettings, watchSettings } from '../../shared/settings'
import { hostPermissionPattern, normalizeOrigin, watchTranslationConfig, type TranslationConfig } from '../../translation/config'
import { isExcludedSite, isSensitivePage, normalizeExcludedHost } from '../../translation/page-policy'
import { isSiteScopeAllowed } from '../../translation/site-scope'
import { sendTranslationMessage } from '../../translation/client'
import {
  isContentTranslationReply,
  type ContentTranslationMessage,
  type PageAction,
  type PageTranslationStatus,
} from '../../translation/messages'

export type WtState =
  | 'loading'
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
  loading: 'stateLoading',
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

export function wtStateTone(state: WtState): UiBadgeTone {
  switch (state) {
    case 'on':
    case 'page':
    case 'fixed':
      return 'success'
    case 'paused':
    case 'capped':
    case 'not-configured':
    case 'inactive':
      return 'attention'
    case 'error':
    case 'master-off':
      return 'danger'
    default:
      return 'neutral'
  }
}

interface ActiveTab {
  readonly id: number
  readonly origin: string
  readonly url: string
}

export interface UseTranslationControls {
  readonly supported: ComputedRef<boolean>
  readonly origin: ComputedRef<string>
  readonly host: ComputedRef<string>
  readonly state: ComputedRef<WtState>
  readonly autoEnabled: ComputedRef<boolean>
  readonly canTranslate: ComputedRef<boolean>
  readonly floatingEnabled: ComputedRef<boolean>
  readonly autoInteractionEnabled: ComputedRef<boolean>
  readonly videoSubtitlesEnabled: ComputedRef<boolean>
  readonly inputTranslationEnabled: ComputedRef<boolean>
  readonly configurationReady: ComputedRef<boolean>
  readonly masterEnabled: ComputedRef<boolean>
  readonly modelConfigured: ComputedRef<boolean>
  readonly modelName: ComputedRef<string>
  readonly dictEnabled: ComputedRef<boolean>
  readonly sensitive: ComputedRef<boolean>
  readonly siteExcluded: ComputedRef<boolean>
  readonly outOfScope: ComputedRef<boolean>
  readonly pageError: Readonly<Ref<string>>
  readonly canRestore: ComputedRef<boolean>
  readonly canResume: ComputedRef<boolean>
  readonly failedCount: ComputedRef<number>
  readonly canRetryFailed: ComputedRef<boolean>
  readonly autoError: Readonly<Ref<MessageKey | ''>>
  readonly busy: Readonly<Ref<boolean>>
  translatePage(): Promise<void>
  setFloating(enabled: boolean): Promise<void>
  setAutoInteraction(enabled: boolean): Promise<void>
  setAuto(enabled: boolean): Promise<void>
  setVideoSubtitles(enabled: boolean): Promise<void>
  setInputTranslation(enabled: boolean): Promise<void>
  restore(): Promise<void>
  resume(): Promise<void>
  retryFailed(): Promise<void>
  excludeSite(excluded: boolean): Promise<void>
  openSettings(): Promise<void>
  openOptionsAt(hash: string): Promise<void>
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
  const autoError = ref<MessageKey | ''>('')
  const busy = ref(false)
  const loaded = ref(false)
  const pageError = ref('')
  let disposed = false
  let loadEpoch = 0
  const toast = createToastSource()

  const supported = computed(() => loaded.value && tab.value !== undefined)
  const origin = computed(() => tab.value?.origin ?? '')
  const host = computed(() => {
    const url = tab.value?.url
    if (url === undefined) return ''
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })
  const autoEnabled = computed(() => tab.value !== undefined && (config.value?.autoOrigins ?? []).includes(origin.value))
  const outOfScope = computed(() => {
    const currentConfig = config.value
    const active = tab.value
    if (currentConfig === undefined || active === undefined) return false
    return !isSiteScopeAllowed(active.origin, currentConfig)
  })
  const configurationReady = computed(() => loaded.value && config.value !== undefined)
  const masterOn = computed(() => masterEnabled.value)
  const modelConfigured = computed(
    () => config.value !== undefined && config.value.baseUrl !== '' && config.value.model !== '',
  )
  const modelName = computed(() => config.value?.model.trim() ?? '')
  const dictEnabled = computed(() => status.value?.fixed === true)
  const sensitive = computed(() => {
    const url = tab.value?.url
    return url !== undefined && isSensitivePage(url)
  })
  const siteExcluded = computed(() => {
    const current = tab.value
    const hosts = config.value?.excludedHosts
    if (current === undefined || hosts === undefined) return false
    return isExcludedSite(current.url, hosts)
  })
  const floatingEnabled = computed(() => config.value?.floatingButtonEnabled === true)
  const autoInteractionEnabled = computed(() => config.value?.autoInteractionEnabled !== false)
  const videoSubtitlesEnabled = computed(() => config.value?.videoSubtitlesEnabled === true)
  const inputTranslationEnabled = computed(() => config.value?.inputTranslationEnabled === true)
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
      (!status.value.capped || status.value.budgetCapped === true) &&
      (status.value.paused || status.value.budgetCapped === true),
  )
  const failedCount = computed(() => (masterEnabled.value ? (status.value?.failed ?? 0) : 0))
  // status.auto 在本站自动翻译和手动翻译本页时都为真，暂停或达到上限时为假。
  // 引擎只在运行中接受单独重试；暂停时「继续翻译」已包含重试，上限时要先追加额度。
  const canRetryFailed = computed(() =>
    failedCount.value > 0 && status.value?.auto === true && !outOfScope.value,
  )

  const state = computed<WtState>(() => {
    if (!loaded.value) return 'loading'
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
    pageError.value = ''
    toast.clear()
    try {
      if (currentConfig.baseUrl === '' || currentConfig.model === '') {
        await openOptionsAt('#wt-title')
        return
      }
      const reply = await sendTranslationMessage({ type: 'wt:translate-page', tabId: current.id, url: current.url })
      if (disposed) return
      if (reply.ok) toast.show('success', 'wtPageStarted')
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
    autoError.value = ''
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

  async function enableAuto(): Promise<void> {
    const current = tab.value
    const currentConfig = config.value
    if (current === undefined || currentConfig === undefined || busy.value) return
    pageError.value = ''
    autoError.value = ''
    toast.clear()
    if (outOfScope.value) {
      autoError.value = 'wtScopeBlocked'
      return
    }
    busy.value = true
    try {
      let granted: boolean
      try {
        granted = await browser.permissions.request({ origins: [hostPermissionPattern(current.origin)] })
      } catch {
        if (!disposed) autoError.value = 'wtPermissionDenied'
        return
      }
      // 用户在权限框里取消：开关跟随持久化状态安静还原
      if (!granted || disposed) return
      const reply = await sendTranslationMessage({ type: 'wt:set-site-auto', origin: current.origin, enabled: true })
      if (disposed) return
      if (reply.ok && reply.config !== undefined) {
        config.value = reply.config
        status.value = await queryStatus(current.id)
        return
      }
      autoError.value = 'saveFailed'
    } catch {
      if (!disposed) autoError.value = 'saveFailed'
    } finally {
      busy.value = false
    }
  }

  async function setAutoInteraction(enabled: boolean): Promise<void> {
    if (disposed || busy.value || !configurationReady.value || enabled === autoInteractionEnabled.value) return
    busy.value = true
    autoError.value = ''
    pageError.value = ''
    toast.clear()
    try {
      const reply = await sendTranslationMessage({ type: 'wt:save-config', patch: { autoInteractionEnabled: enabled } })
      if (disposed) return
      if (!reply.ok || reply.config === undefined) {
        if (!reply.ok) pageError.value = reply.error
        else autoError.value = 'saveFailed'
        return
      }
      config.value = reply.config
      if (reply.warning !== undefined) pageError.value = reply.warning
    } catch {
      if (!disposed) autoError.value = 'saveFailed'
    } finally {
      busy.value = false
    }
  }

  async function disableAuto(): Promise<void> {
    const current = tab.value
    if (current === undefined || busy.value) return
    pageError.value = ''
    autoError.value = ''
    toast.clear()
    busy.value = true
    try {
      const reply = await sendTranslationMessage({ type: 'wt:set-site-auto', origin: current.origin, enabled: false })
      if (disposed) return
      if (reply.ok && reply.config !== undefined) {
        config.value = reply.config
        status.value = await queryStatus(current.id)
        return
      }
      autoError.value = 'saveFailed'
    } catch {
      if (!disposed) autoError.value = 'saveFailed'
    } finally {
      busy.value = false
    }
  }

  async function setAuto(enabled: boolean): Promise<void> {
    if (enabled === autoEnabled.value) return
    await (enabled ? enableAuto() : disableAuto())
  }

  async function setRealtimeFeature(
    key: 'videoSubtitlesEnabled' | 'inputTranslationEnabled',
    enabled: boolean,
  ): Promise<void> {
    const current = key === 'videoSubtitlesEnabled' ? videoSubtitlesEnabled.value : inputTranslationEnabled.value
    if (disposed || busy.value || !configurationReady.value || enabled === current) return
    busy.value = true
    autoError.value = ''
    pageError.value = ''
    toast.clear()
    try {
      if (enabled) {
        let granted = false
        try {
          granted = await browser.permissions.request({ origins: ['http://*/*', 'https://*/*'] })
        } catch {
          if (!disposed) autoError.value = 'wtPermissionDenied'
          return
        }
        if (!granted || disposed) return
      }
      const reply = await sendTranslationMessage({ type: 'wt:save-config', patch: { [key]: enabled } })
      if (disposed) return
      if (!reply.ok || reply.config === undefined) {
        if (!reply.ok) pageError.value = reply.error
        else autoError.value = 'saveFailed'
        return
      }
      config.value = reply.config
      await load()
      if (!disposed && reply.warning !== undefined) pageError.value = reply.warning
    } catch {
      if (!disposed) autoError.value = 'saveFailed'
    } finally {
      busy.value = false
    }
  }

  async function pageAction(action: PageAction): Promise<void> {
    const current = tab.value
    if (current === undefined || busy.value) return
    autoError.value = ''
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
      if (action === 'restore') toast.show('success', 'wtRestored')
      status.value = await queryStatus(current.id)
    } finally {
      busy.value = false
    }
  }

  async function openSettings(): Promise<void> {
    await openOptionsAt('')
  }

  async function openOptionsAt(hash: string): Promise<void> {
    try {
      await browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}${hash}` })
      if (!disposed) window.close()
    } catch {
      toast.show('danger', 'openFailed')
    }
  }

  async function excludeSite(excluded: boolean): Promise<void> {
    const current = tab.value
    if (disposed || busy.value || current === undefined) return
    const siteHost = normalizeExcludedHost(host.value)
    if (siteHost === '') return
    busy.value = true
    autoError.value = ''
    pageError.value = ''
    toast.clear()
    try {
      const reply = await sendTranslationMessage({ type: 'wt:set-site-excluded', host: siteHost, excluded })
      if (disposed) return
      if (!reply.ok || reply.config === undefined) {
        toast.show('danger', 'saveFailed')
        return
      }
      config.value = reply.config
      toast.show('success', excluded ? 'wtSiteExcluded' : 'wtSiteIncluded', { host: siteHost })
    } catch {
      if (!disposed) toast.show('danger', 'saveFailed')
    } finally {
      busy.value = false
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
    host,
    state,
    autoEnabled,
    canTranslate,
    floatingEnabled,
    autoInteractionEnabled,
    videoSubtitlesEnabled,
    inputTranslationEnabled,
    configurationReady,
    masterEnabled: masterOn,
    modelConfigured,
    modelName,
    dictEnabled,
    sensitive,
    siteExcluded,
    outOfScope,
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
    setVideoSubtitles: (enabled: boolean) => setRealtimeFeature('videoSubtitlesEnabled', enabled),
    setInputTranslation: (enabled: boolean) => setRealtimeFeature('inputTranslationEnabled', enabled),
    restore: () => pageAction('restore'),
    resume: () => pageAction('resume'),
    retryFailed: () => pageAction('retry-failed'),
    excludeSite,
    openSettings,
    openOptionsAt,
  }
}

const translationControlsKey: InjectionKey<UseTranslationControls> = Symbol('translation-controls')

export function provideTranslationControls(): UseTranslationControls {
  const controls = useTranslationControls()
  provide(translationControlsKey, controls)
  return controls
}

export function useProvidedTranslationControls(): UseTranslationControls {
  return inject(translationControlsKey, useTranslationControls, true)
}
