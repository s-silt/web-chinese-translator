import { isExcludedSite, MAX_EXCLUDED_HOSTS } from './page-policy'

export type SiteScopeMode = 'all' | 'include' | 'exclude'

export interface SiteScopePolicy {
  readonly siteScopeMode: SiteScopeMode
  readonly siteScopeHosts: readonly string[]
}

export const MAX_SITE_SCOPE_HOSTS = MAX_EXCLUDED_HOSTS
export const SITE_SCOPE_LIMIT_ERROR = '网站名单最多 50 个'
export const SITE_SCOPE_INVALID_ERROR = '网站名单地址无效'
export const SITE_SCOPE_BLOCKED_ERROR = '该网站不在运行范围内'

export function isSiteScopeMode(value: unknown): value is SiteScopeMode {
  return value === 'all' || value === 'include' || value === 'exclude'
}

export function isSiteScopeAllowed(url: string, policy: SiteScopePolicy): boolean {
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return false
  } catch {
    return false
  }
  if (policy.siteScopeMode === 'all') return true
  const listed = isExcludedSite(url, policy.siteScopeHosts)
  return policy.siteScopeMode === 'include' ? listed : !listed
}

function patternHost(host: string): string {
  return host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : `*.${host}`
}

export function restrictSitePatterns(patterns: readonly string[], policy: SiteScopePolicy): string[] {
  if (policy.siteScopeMode !== 'include') return [...new Set(patterns)].sort()
  const result = new Set<string>()
  for (const pattern of patterns) {
    const parts = /^(https?):\/\/([^/]+)\/\*$/.exec(pattern)
    if (parts === null) continue
    const scheme = parts[1]!
    const raw = parts[2]!
    const wildcard = raw === '*' || raw.startsWith('*.')
    const base = raw === '*' ? '' : raw.replace(/^\*\./, '')
    for (const host of policy.siteScopeHosts) {
      if (base === '' || host === base || host.endsWith(`.${base}`)) {
        if (wildcard || host === base) result.add(`${scheme}://${wildcard ? patternHost(host) : base}/*`)
      } else if (base.endsWith(`.${host}`)) result.add(pattern)
    }
  }
  return [...result].sort()
}

export function siteScopeExclusions(policy: SiteScopePolicy): string[] {
  return policy.siteScopeMode === 'exclude'
    ? policy.siteScopeHosts
        .flatMap((host) => [`http://${patternHost(host)}/*`, `https://${patternHost(host)}/*`])
        .sort()
    : []
}
