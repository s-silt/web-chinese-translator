import { describe, expect, it } from 'vitest'
import {
  isExcludedSite,
  isSensitivePage,
  normalizeExcludedHost,
  sanitizeExcludedHosts,
} from '../../../src/translation/page-policy'

describe('isSensitivePage', () => {
  it.each([
    '/settings/keys', '/settings/personal-access-tokens', '/settings/%74okens',
    '/settings//tokens', '/settings%2ftokens', '/orgs/acme/settings/secrets',
    '/repo/project/settings/hooks', '/settings/security.html', '/account', '/en/account/profile',
    '/checkout/cart', '/billing/plan', '/inbox/42', '/api-keys', '/oauth/authorize',
  ])('敏感路径 %s 被阻止', (path) => {
    expect(isSensitivePage(`https://example.com${path}`)).toBe(true)
  })

  it.each([
    'https://example.com/work#a/section', 'https://example.com/work#section',
    'https://docs.example.com/guide/physics', 'https://docs.example.com/docs/authentication',
    'https://reader.fixture.test/page', 'http://reader.insecure.test/page',
  ])('常规页面 %s 不敏感', (url) => {
    expect(isSensitivePage(url)).toBe(false)
  })

  it.each([
    'https://app.devin.ai/work#/settings/tokens',
    'https://app.devin.ai/work#!/billing',
    'https://app.devin.ai/work#%2Fsettings%2Ftokens',
    'https://app.devin.ai/work#%252fsettings%252ftokens',
  ])('hash 路由 %s 被阻止', (url) => {
    expect(isSensitivePage(url)).toBe(true)
  })

  it.each([
    'https://bank.com/dashboard',
    'https://online.bank.example/portal',
    'https://mail.google.com/mail',
    'https://webmail.example.net/inbox',
    'https://intranet.corp.example/wiki',
    'http://192.168.1.2/dashboard',
    'http://10.0.0.1/admin',
    'http://localhost:8080/page',
    'http://[::1]:8080/page',
    'http://[fc00::1]/page',
    'http://[fe80::1]/page',
    'http://[::ffff:127.0.0.1]/page',
    'http://[::ffff:192.168.1.1]/page',
    'http://[::]/page',
    'http://printer/page',
  ])('私有或敏感主机 %s 被阻止', (url) => {
    expect(isSensitivePage(url)).toBe(true)
  })

  it('无法解析或非 http(s) 视为敏感', () => {
    expect(isSensitivePage('not a URL')).toBe(true)
    expect(isSensitivePage('file:///etc/passwd')).toBe(true)
    expect(isSensitivePage('chrome://settings')).toBe(true)
  })

  it('IPv4 映射形式不把文档示例地址误判为私网地址', () => {
    expect(isSensitivePage('http://[::ffff:192.0.2.1]/page')).toBe(false)
  })
})

describe('excludedHosts', () => {
  const hosts = ['bank.example', 'internal.example.org']

  it.each([
    ['https://bank.example/page', true],
    ['https://api.bank.example/page', true],
    ['http://bank.example:8080/page', true],
    ['https://BANK.EXAMPLE./page', true],
    ['https://evilbank.example/page', false],
    ['https://other.example.org/page', false],
    ['https://internal.example.org/page', true],
  ])('匹配 %s -> %s', (url, expected) => {
    expect(isExcludedSite(url, hosts)).toBe(expected)
  })

  it.each([
    ['bank.example', 'bank.example'],
    ['BANK.EXAMPLE.', 'bank.example'],
    ['https://Sub.Example.com/path?q=1', 'sub.example.com'],
    ['http://intranet.local:8080/x', 'intranet.local'],
    ['https://中国.example/文章', 'xn--fiqs8s.example'],
    ['https://user:pw@evil.example/x', ''],
    ['ftp://files.example/', ''],
    ['*.bank.example', ''],
    ['https://*.bank.example', ''],
    ['*', ''],
    ['', ''],
    ['   ', ''],
    ['not a url with spaces', ''],
  ])('规范化 %s -> %s', (input, expected) => {
    expect(normalizeExcludedHost(input)).toBe(expected)
  })

  it('去重、跳过无效项并限制总数', () => {
    const many = Array.from({ length: 60 }, (_, i) => `h${i}.example`)
    const result = sanitizeExcludedHosts(['Bank.EXAMPLE', 'bank.example', '', 42, 'ftp://x.example/', ...many])
    expect(result.length).toBeLessThanOrEqual(50)
    expect(new Set(result).size).toBe(result.length)
    expect(result).toContain('bank.example')
    expect(result).not.toContain('x.example')
  })
})

describe('网站运行范围', () => {
  const scope = (siteScopeMode: 'all' | 'include' | 'exclude', siteScopeHosts: readonly string[]) => ({
    siteScopeMode,
    siteScopeHosts,
  })

  it('只接受 all、include、exclude', async () => {
    const { isSiteScopeMode } = await import('../../../src/translation/site-scope')
    expect(isSiteScopeMode('all')).toBe(true)
    expect(isSiteScopeMode('include')).toBe(true)
    expect(isSiteScopeMode('exclude')).toBe(true)
    expect(isSiteScopeMode('nope')).toBe(false)
    expect(isSiteScopeMode(1)).toBe(false)
  })

  it('非 http(s) 一律拒绝；include 含子域名；exclude 取反', async () => {
    const { isSiteScopeAllowed } = await import('../../../src/translation/site-scope')
    const all = scope('all', ['blocked.example'])
    expect(isSiteScopeAllowed('not a url', all)).toBe(false)
    expect(isSiteScopeAllowed('not-a-url', all)).toBe(false)
    expect(isSiteScopeAllowed('file:///tmp/a', all)).toBe(false)
    expect(isSiteScopeAllowed('ftp://files.example/a', all)).toBe(false)
    expect(isSiteScopeAllowed('javascript:alert(1)', all)).toBe(false)
    expect(isSiteScopeAllowed('https://app.devin.ai/work', scope('include', ['devin.ai']))).toBe(true)
    expect(isSiteScopeAllowed('https://devin.ai/', scope('include', ['devin.ai']))).toBe(true)
    expect(isSiteScopeAllowed('https://notdevin.ai/', scope('include', ['devin.ai']))).toBe(false)
    expect(isSiteScopeAllowed('https://app.devin.ai/', scope('include', []))).toBe(false)
    expect(isSiteScopeAllowed('notaurl', scope('include', ['devin.ai']))).toBe(false)
    expect(isSiteScopeAllowed('https://app.devin.ai/work', scope('exclude', ['devin.ai']))).toBe(false)
    expect(isSiteScopeAllowed('https://example.com/', scope('exclude', ['devin.ai']))).toBe(true)
    expect(isSiteScopeAllowed('https://example.com/', scope('exclude', []))).toBe(true)
    expect(isSiteScopeAllowed(':::', scope('exclude', []))).toBe(false)
    expect(isSiteScopeAllowed('https://blocked.example/', all)).toBe(true)
  })

  it('include 收窄父通配与全通配；exact 不放宽；exclude 与 all 只去重排序', async () => {
    const { restrictSitePatterns } = await import('../../../src/translation/site-scope')
    expect(restrictSitePatterns(['https://*.example.com/*'], scope('include', ['docs.example.com']))).toEqual([
      'https://*.docs.example.com/*',
    ])
    expect(restrictSitePatterns(['https://example.com/*'], scope('include', ['docs.example.com']))).toEqual([])
    expect(restrictSitePatterns(['https://api.example.com/*'], scope('include', ['example.com']))).toEqual([
      'https://api.example.com/*',
    ])
    expect(restrictSitePatterns(['https://*/*', 'http://*/*'], scope('include', ['docs.example.com'])).sort()).toEqual(
      ['http://*.docs.example.com/*', 'https://*.docs.example.com/*'].sort(),
    )
    expect(restrictSitePatterns(
      ['https://*.gitlab.com/*', 'https://*.devin.ai/*', 'https://docs.gitlab.com/*'],
      scope('include', ['docs.gitlab.com']),
    ).sort()).toEqual(['https://*.docs.gitlab.com/*', 'https://docs.gitlab.com/*'].sort())
    expect(restrictSitePatterns(['https://*.devin.ai/*'], scope('include', []))).toEqual([])
    expect(restrictSitePatterns(['https://*.gitlab.com/*'], scope('exclude', ['docs.gitlab.com']))).toEqual([
      'https://*.gitlab.com/*',
    ])
    expect(restrictSitePatterns(['http://*/*'], scope('all', ['devin.ai']))).toEqual(['http://*/*'])
  })

  it('exclude 只生成 http 与 https 通配，IP 不加星号；all 与 include 返回空数组', async () => {
    const { siteScopeExclusions } = await import('../../../src/translation/site-scope')
    expect(siteScopeExclusions(scope('exclude', ['bank.example']))).toEqual([
      'http://*.bank.example/*',
      'https://*.bank.example/*',
    ])
    expect(siteScopeExclusions(scope('all', ['bank.example']))).toEqual([])
    expect(siteScopeExclusions(scope('include', ['bank.example']))).toEqual([])
    expect(siteScopeExclusions(scope('exclude', ['b.example', 'a.example']))).toEqual(
      ['http://*.a.example/*', 'http://*.b.example/*', 'https://*.a.example/*', 'https://*.b.example/*'].sort(),
    )
    expect(siteScopeExclusions(scope('exclude', ['192.0.2.1', '[2001:db8::1]']))).toEqual(
      [
        'http://192.0.2.1/*',
        'http://[2001:db8::1]/*',
        'https://192.0.2.1/*',
        'https://[2001:db8::1]/*',
      ].sort(),
    )
    for (const pattern of siteScopeExclusions(scope('exclude', ['192.0.2.1', '[2001:db8::1]']))) {
      expect(pattern).not.toContain('*.')
    }
  })
})
