/**
 * 扩展页面（弹出页、设置页）的界面语言与外观：随设置变化，并缓存在本扩展的 localStorage 中，
 * 下次打开时在挂载前同步读出，避免先显示默认语言、默认配色再切换。
 */
import { computed, readonly, ref, watch, type ComputedRef, type Ref } from 'vue'
import { MESSAGES, translateMessage, type MessageKey, type MessageParams } from '../i18n'
import { languageEnvironment } from '../shared/language-env'
import { isUiLanguagePreference, resolveUiLanguage, type UiLanguage, type UiLanguagePreference } from '../shared/locale'
import { isThemePreference, isUiStyle, type Settings, type ThemePreference, type UiStyle } from '../shared/settings'
import { useSettings } from './useSettings'

/** 各外观的文案 */
export const THEME_MESSAGE: Readonly<Record<ThemePreference, MessageKey>> = {
  auto: 'themeAuto',
  light: 'themeLight',
  dark: 'themeDark',
}

/** 缓存的偏好：只用于首屏，以存储中的设置为准 */
export const PREFERENCES_CACHE_KEY = 'gcn:ui-preferences'

interface CachedPreferences {
  readonly uiLanguage: UiLanguagePreference
  readonly theme: ThemePreference
  readonly uiStyle: UiStyle
}

const DEFAULT_PREFERENCES: CachedPreferences = { uiLanguage: 'auto', theme: 'auto', uiStyle: 'classic' }

const preferences = ref<CachedPreferences>(DEFAULT_PREFERENCES)
/** 当前界面语言 */
const language = computed<UiLanguage>(() => resolveUiLanguage(preferences.value.uiLanguage, languageEnvironment()))

function readCache(): CachedPreferences {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFERENCES_CACHE_KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES
    const value = parsed as Record<string, unknown>
    return {
      uiLanguage: isUiLanguagePreference(value.uiLanguage) ? value.uiLanguage : 'auto',
      theme: isThemePreference(value.theme) ? value.theme : 'auto',
      uiStyle: isUiStyle(value.uiStyle) ? value.uiStyle : 'classic',
    }
  } catch {
    // 无法读取（存储被禁用、内容损坏）按默认
    return DEFAULT_PREFERENCES
  }
}

function writeCache(value: CachedPreferences): void {
  try {
    localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify(value))
  } catch {
    // 写不进缓存只影响下次打开时的首屏
  }
}

/** 外观写在 <html data-theme> 上；auto 时移除，跟随浏览器 */
export function applyTheme(theme: ThemePreference, root: HTMLElement = document.documentElement): void {
  if (theme === 'auto') delete root.dataset.theme
  else root.dataset.theme = theme
}

/** 界面风格写在 <html data-style> 上；classic 为默认不写属性；cyber 固定深色忽略 data-theme */
export function applyUiStyle(style: UiStyle, root: HTMLElement = document.documentElement): void {
  if (style === 'classic') delete root.dataset.style
  else root.dataset.style = style
}

/** 文档语言与标题随界面语言 */
function applyDocument(lang: UiLanguage): void {
  document.documentElement.lang = lang
  document.title = MESSAGES[lang].appName
}

function apply(next: CachedPreferences): void {
  preferences.value = next
  applyTheme(next.theme)
  applyUiStyle(next.uiStyle)
  applyDocument(language.value)
}

/** 挂载前调用：按缓存的偏好设置语言与外观 */
export function initUiPreferences(): void {
  apply(readCache())
}

/** 设置读取或变化后调用：更新语言与外观，并写入缓存 */
export function applyUiPreferences(settings: Pick<Settings, 'uiLanguage' | 'theme' | 'uiStyle'>): void {
  const next = { uiLanguage: settings.uiLanguage, theme: settings.theme, uiStyle: settings.uiStyle }
  if (
    next.uiLanguage !== preferences.value.uiLanguage ||
    next.theme !== preferences.value.theme ||
    next.uiStyle !== preferences.value.uiStyle
  ) {
    apply(next)
  }
  writeCache(next)
}

export interface UseI18n {
  /** 当前界面语言 */
  readonly language: ComputedRef<UiLanguage>
  /** 按当前界面语言取文案 */
  t(key: MessageKey, params?: MessageParams): string
}

/** 界面文案；语言变化时依赖它的模板随之更新 */
export function useI18n(): UseI18n {
  return {
    language,
    t: (key, params) => translateMessage(language.value, key, params),
  }
}

/** 当前的界面偏好（只读） */
export function useUiPreferences(): Readonly<Ref<CachedPreferences>> {
  return readonly(preferences)
}

/** 设置读取后、变化时同步界面语言与外观。须在组件 setup 内调用（弹出页、设置页的根组件） */
export function useUiPreferencesSync(): void {
  const { settings, loaded } = useSettings()
  // 读取前是默认值，不能覆盖缓存的偏好
  watch(
    [settings, loaded],
    ([value, ready]) => {
      if (ready) applyUiPreferences(value)
    },
    { immediate: true },
  )
}
