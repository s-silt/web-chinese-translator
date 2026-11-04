import { pathSegments } from '../core/page'
import { isSensitivePath } from '../core/untranslated'

export const MAX_EXCLUDED_HOSTS = 50
/** 后台的上限回复；设置页据此换成界面语言的文案。 */
export const EXCLUDED_LIMIT_ERROR = '排除网站最多 50 个'
const SENSITIVE_HOSTS = [
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
  'mail.yahoo.com', 'mail.proton.me', 'accounts.google.com', 'account.microsoft.com',
  'appleid.apple.com', 'paypal.com', 'alipay.com', 'bankofamerica.com', 'wellsfargo.com',
  'chase.com', 'icbc.com.cn', 'cmbchina.com', 'ccb.com', 'abchina.com', 'boc.cn',
] as const
const PRIVATE_IPV4 = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
const SENSITIVE_HOST_LABEL = /(?:^|[.-])(?:bank|banking|webmail|mail|intranet|payroll)(?:[.-]|$)/i
const SENSITIVE_PATH = /(?:^|\/)(?:settings|api[-_]?keys?|secrets|passwords?|oauth|checkout|payments?|billing|inbox|mail|messages|payroll|credentials|medical-records?)(?:\/|$)/i
const ACCOUNT_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:accounts?|auth|sign-?in|sign-?up|log-?in|register)(?:\/|$)/i

function hostMatches(host: string, blocked: string): boolean {
  return host === blocked || host.endsWith(`.${blocked}`)
}

export function normalizeExcludedHost(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 2048) return ''
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') return ''
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return host !== '' && host.length <= 253 && !host.startsWith('.') && !host.includes('..') && !host.includes('*')
      ? host
      : ''
  } catch {
    return ''
  }
}

export function sanitizeExcludedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts = new Set<string>()
  for (const item of value.slice(0, MAX_EXCLUDED_HOSTS)) {
    if (typeof item !== 'string') continue
    const host = normalizeExcludedHost(item)
    if (host !== '') hosts.add(host)
  }
  return [...hosts]
}

export function isExcludedSite(url: string, hosts: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
    return hosts.some((blocked) => hostMatches(host, blocked))
  } catch {
    return true
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const ip6 = host.replace(/^\[|\]$/g, '')
  if (ip6 === '::') return true
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(ip6)
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16)
    const low = Number.parseInt(mapped[2]!, 16)
    if (PRIVATE_IPV4.test(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)) return true
  }
  return host === 'localhost' || /\.(?:localhost|local|internal|lan|corp)$/.test(host) ||
    (!host.includes('.') && !host.includes(':')) || PRIVATE_IPV4.test(host) ||
    ip6 === '::1' || /^f[cd][\da-f]{2}:/.test(ip6) || /^fe[89ab][\da-f]:/.test(ip6)
}

function sensitivePath(pathname: string): boolean {
  const normalized = `/${pathSegments(pathname).flatMap((segment) => segment.split('/').filter(Boolean)).join('/')}`
    .replace(/\.[a-z\d]+$/i, '')
  return isSensitivePath(pathname) || SENSITIVE_PATH.test(normalized) || ACCOUNT_PATH.test(normalized)
}

export function isSensitivePage(value: string): boolean {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return true
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (isPrivateHost(host) || SENSITIVE_HOST_LABEL.test(host) || SENSITIVE_HOSTS.some((item) => hostMatches(host, item))) return true
    if (sensitivePath(url.pathname)) return true
    let route = url.hash.slice(1)
    for (let i = 0; i < 2; i += 1) {
      const decoded = decodeURIComponent(route)
      if (decoded === route) break
      route = decoded
    }
    if (!route.startsWith('/') && !route.startsWith('!')) return false
    const path = route.replace(/^!/, '').split(/[?#]/)[0] ?? ''
    return sensitivePath(path.startsWith('/') ? path : `/${path}`)
  } catch {
    return true
  }
}
