export function decodePageFragment(hash: string): string | undefined {
  let fragment: string
  try {
    fragment = decodeURIComponent(hash.slice(1))
  } catch {
    return undefined
  }
  // 第二层可能混有真实百分号或无效 UTF-8，仍识别其中可解码的路由分隔符。
  return fragment.replace(/(?:%[\da-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded.replace(/%[0-7][\da-f]/gi, decodeURIComponent)
    }
  })
}

export function pageIdentity(href: string): string {
  const url = new URL(href)
  const fragment = decodePageFragment(url.hash)
  if (fragment === undefined) return href
  const route = fragment.startsWith('/') || fragment.startsWith('!') ? url.hash : ''
  return `${url.origin}${url.pathname}${url.search}${route}`
}

/**
 * 浏览器侧地址（tab.url / info.pageUrl / changeInfo.url）可能保留 `#:~:text=...` 片段指令，
 * 而文档实际 `location.href` 按规范隐去该指令。仅剥离 `#` 后的 `:~:` 指令段，
 * 保留路径、query（含字面 `:~:`）、普通锚点与 hash 路由。
 */
export function documentFormOfBrowserUrl(url: string): string {
  const hash = url.indexOf('#')
  if (hash === -1) return url
  const directive = url.indexOf(':~:', hash + 1)
  if (directive === -1) return url
  return url.slice(0, directive === hash + 1 ? hash : directive)
}

/**
 * 核对已核验文档的 `location.href` 与浏览器报告 URL：仅允许相差文本片段指令，
 * 不放宽两个真实文档快照之间的比较。
 */
export function matchesBrowserUrl(documentUrl: string, browserUrl: string): boolean {
  return documentUrl === browserUrl || documentUrl === documentFormOfBrowserUrl(browserUrl)
}

export function watchPageLifecycle(options: {
  onNavigate(): void
  onSuspend(): void
  onResume(): void
  onUnload(): void
}): () => void {
  let identity = pageIdentity(location.href)
  let disposed = false

  const check = (): void => {
    if (disposed) return
    const current = pageIdentity(location.href)
    if (current !== identity) {
      identity = current
      options.onNavigate()
    }
  }

  let trustedTimer: ReturnType<typeof setTimeout> | undefined
  const onTrusted = (event: Event): void => {
    if (!event.isTrusted) return
    if (trustedTimer !== undefined) clearTimeout(trustedTimer)
    trustedTimer = setTimeout(() => {
      trustedTimer = undefined
      check()
    }, 0)
  }
  const onPopstate = (): void => {
    check()
  }
  const onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) options.onSuspend()
    else options.onUnload()
  }
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      check()
      options.onResume()
    }
  }

  window.addEventListener('popstate', onPopstate)
  window.addEventListener('hashchange', onPopstate)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('pointerdown', onTrusted, true)
  window.addEventListener('keyup', onTrusted, true)

  const navigation = (window as Window & { navigation?: EventTarget }).navigation
  if (navigation !== undefined) navigation.addEventListener('navigatesuccess', check)

  const observer =
    navigation === undefined
      ? new MutationObserver(() => {
          check()
        })
      : undefined
  observer?.observe(document.documentElement, { childList: true, subtree: true })

  return () => {
    disposed = true
    if (trustedTimer !== undefined) clearTimeout(trustedTimer)
    window.removeEventListener('popstate', onPopstate)
    window.removeEventListener('hashchange', onPopstate)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('pointerdown', onTrusted, true)
    window.removeEventListener('keyup', onTrusted, true)
    navigation?.removeEventListener('navigatesuccess', check)
    observer?.disconnect()
  }
}
