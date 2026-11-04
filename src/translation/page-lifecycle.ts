export function pageIdentity(href: string): string {
  const url = new URL(href)
  let fragment = url.hash.slice(1)
  try {
    fragment = decodeURIComponent(fragment)
  } catch {
    return href
  }
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
