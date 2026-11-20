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
