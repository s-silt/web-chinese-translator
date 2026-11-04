const REPORT_DELAY_MS = 8000

export function createPageContextTracker(options: {
  enabled: () => boolean
  pageId: () => string
  send: () => Promise<boolean>
}): { refresh(): void; reset(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let sentKey = ''
  let inFlightKey = ''
  let generation = 0
  let disposed = false

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const schedule = (): void => {
    clearTimer()
    if (disposed || !options.enabled() || document.hidden || !document.hasFocus()) return
    if (sentKey === options.pageId() || inFlightKey === options.pageId()) return
    const gen = generation
    timer = setTimeout(() => {
      timer = undefined
      if (disposed || gen !== generation || !options.enabled()) return
      if (document.hidden || !document.hasFocus()) return
      const key = options.pageId()
      if (sentKey === key || inFlightKey === key) return
      inFlightKey = key
      void options
        .send()
        .then((ok) => {
          if (ok && gen === generation && key === options.pageId() && options.enabled()) sentKey = key
        })
        .catch(() => undefined)
        .finally(() => {
          if (inFlightKey === key && gen === generation) inFlightKey = ''
        })
    }, REPORT_DELAY_MS)
  }

  const onVisibility = (): void => {
    if (document.hidden) clearTimer()
    else schedule()
  }
  const onFocus = (): void => {
    schedule()
  }
  const onBlur = (): void => {
    clearTimer()
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)

  return {
    refresh() {
      if (!options.enabled()) {
        generation += 1
        clearTimer()
        sentKey = ''
        inFlightKey = ''
      }
      schedule()
    },
    reset() {
      generation += 1
      clearTimer()
      sentKey = ''
      inFlightKey = ''
    },
    dispose() {
      generation += 1
      disposed = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    },
  }
}
