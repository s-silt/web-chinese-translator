import { normalizeOrigin, type TranslationConfig } from './config'
import { isExcludedSite } from './page-policy'
import { requestOptionsKey } from './request-options'
import { isSiteScopeAllowed } from './site-scope'

export type RequestKind = 'auto' | 'selection' | 'assist' | 'test' | 'catalog'

export interface RequestScope {
  readonly kind: RequestKind
  readonly url: string
  /** 请求语境里附带的近期阅读站点。 */
  readonly recentSites: readonly string[]
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** 接口地址、模型、目标语言或源语言变化：全部译文和在途请求都失效。 */
export function translationOutputChanged(previous: TranslationConfig, next: TranslationConfig): boolean {
  return (
    previous.baseUrl !== next.baseUrl ||
    previous.model !== next.model ||
    previous.targetLanguage !== next.targetLanguage ||
    previous.sourceLanguage !== next.sourceLanguage ||
    requestOptionsKey(previous) !== requestOptionsKey(next)
  )
}

/** 划词辅助、主动提示、排除列表或网站运行范围变化：阅读辅助及其语境失效。 */
export function readingPolicyChanged(previous: TranslationConfig, next: TranslationConfig): boolean {
  return (
    previous.selectionPopupEnabled !== next.selectionPopupEnabled ||
    previous.selectionToolbarEnabled !== next.selectionToolbarEnabled ||
    previous.proactiveAssistEnabled !== next.proactiveAssistEnabled ||
    !sameList(previous.excludedHosts, next.excludedHosts) ||
    previous.siteScopeMode !== next.siteScopeMode ||
    !sameList(previous.siteScopeHosts, next.siteScopeHosts)
  )
}

/** 连接不变时，这次配置变更是否影响该请求所在站点的模式或它携带的语境。其他站点的规则不算。 */
export function requestAffected(request: RequestScope, previous: TranslationConfig, next: TranslationConfig): boolean {
  if (request.kind === 'test' || request.kind === 'catalog') return false
  if (isExcludedSite(request.url, previous.excludedHosts) !== isExcludedSite(request.url, next.excludedHosts)) return true
  if (isSiteScopeAllowed(request.url, previous) !== isSiteScopeAllowed(request.url, next)) return true
  if (request.kind === 'assist') return readingPolicyChanged(previous, next)
  if (request.kind === 'auto') {
    const origin = normalizeOrigin(request.url)
    if (previous.autoOrigins.includes(origin) !== next.autoOrigins.includes(origin)) return true
  }
  // 尚未发出的请求不能再带上用户刚关闭或刚排除的阅读线索。
  return request.recentSites.some(
    (site) =>
      !next.proactiveAssistEnabled ||
      isExcludedSite(`https://${site}/`, next.excludedHosts) ||
      !isSiteScopeAllowed(`https://${site}/`, next),
  )
}
