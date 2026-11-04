/**
 * 扩展界面（弹出页、设置页、徽标）的多语言文案。文案中的 {名称} 由参数替换。
 */
import type { UiLanguage } from '../shared/locale'
import en from './en'
import zhCN, { type MessageKey, type Messages } from './zh-CN'
import zhTW from './zh-TW'
import ja from './ja'
import ko from './ko'

export type { MessageKey, Messages }

export const MESSAGES: Readonly<Record<UiLanguage, Messages>> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ja, ko }

/** 文案参数：{名称} → 值 */
export type MessageParams = Readonly<Record<string, string | number>>

const PARAM_RE = /\{(\w+)\}/g

/** 取文案并替换参数；没有对应参数的占位符原样保留 */
export function translateMessage(language: UiLanguage, key: MessageKey, params?: MessageParams): string {
  const text = MESSAGES[language][key]
  if (!params) return text
  return text.replace(PARAM_RE, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
}
