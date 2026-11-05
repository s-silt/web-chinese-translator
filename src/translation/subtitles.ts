import { createId } from './id'
import type { LiveTranslationOptions, LiveTranslationWatcher } from './live-translation'
import {
  findShowingSubtitleTrack,
  isNetflixHost,
  isSubtitleElementVisible,
  isYouTubeHost,
  readSubtitleSample,
  resolvePlayerContainer,
  type SubtitleSample,
} from './subtitle-source'

const DISCOVERY_INTERVAL_MS = 1000
const MAX_VIDEOS = 8
const DOM_DEBOUNCE_MS = 250
const DOM_MAX_WAIT_MS = 1000
const CACHE_LIMIT = 128
const MIN_BACKOFF_MS = 1000
const MAX_CUE_LENGTH = 1500
const MAX_TOTAL_LENGTH = 4000
const MAX_BATCH_ITEMS = 5

const SUBTITLE_CSS = `
.overlay {
  box-sizing: border-box;
  position: fixed;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  pointer-events: none;
  font: 15px/1.45 -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.bubble {
  box-sizing: border-box;
  max-width: min(86%, 720px);
  padding: 5px 12px;
  border-radius: 8px;
  color: #f8fafc;
  background: rgba(15, 23, 42, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  text-align: center;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  pointer-events: none;
}
.bubble.is-hint, .bubble.is-status {
  font-size: 12px;
  line-height: 1.4;
  padding: 3px 10px;
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.72);
}
`

function isVideoVisible(video: HTMLVideoElement): boolean {
  if (!video.isConnected || !isSubtitleElementVisible(video)) return false
  const rect = video.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function selectTargetVideo(): HTMLVideoElement | undefined {
  const nodeList = document.querySelectorAll('video')
  const candidates: HTMLVideoElement[] = []
  for (let i = 0; i < nodeList.length && candidates.length < MAX_VIDEOS; i += 1) {
    const v = nodeList[i]
    if (v !== undefined && v.isConnected) candidates.push(v)
  }
  if (candidates.length === 0) return undefined
  const playingVisible = candidates.find((v) => !v.paused && !v.ended && isVideoVisible(v))
  if (playingVisible !== undefined) return playingVisible
  return candidates.find(isVideoVisible)
}

function hasImageOnlySubtitles(container: HTMLElement): boolean {
  if (!isNetflixHost()) return false
  const timedText = container.querySelector('.player-timedtext')
  if (timedText === null) return false
  const hasGraphic = timedText.querySelector('svg,img,canvas,image') !== null
  if (!hasGraphic) return false
  const textContainers = timedText.querySelectorAll('.player-timedtext-text-container')
  for (let i = 0; i < textContainers.length; i += 1) {
    const text = (textContainers[i]?.textContent ?? '').trim()
    if (text !== '') return false
  }
  return true
}

function hasUnsupportedShowingTrack(video: HTMLVideoElement): boolean {
  const tracks = video.textTracks
  if (tracks === undefined || tracks === null) return false
  let hasShowing = false
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]
    if (track === undefined || track.mode !== 'showing') continue
    if (track.kind !== 'subtitles' && track.kind !== 'captions') continue
    hasShowing = true
  }
  return hasShowing && findShowingSubtitleTrack(video) === undefined
}

function isPlayerAdActive(container: HTMLElement): boolean {
  return (
    isYouTubeHost() &&
    (container.classList.contains('ad-showing') || container.classList.contains('ad-interrupting'))
  )
}

export function createSubtitleTranslation(options: LiveTranslationOptions): LiveTranslationWatcher {
  let disposed = false
  let generation = 0
  let currentVideo: HTMLVideoElement | undefined
  let currentContainer: HTMLElement | undefined
  let currentSource: object | undefined
  let currentVideoSrc = ''
  let currentTrack: TextTrack | undefined
  let inFlightId: string | undefined
  let inFlightText: string | undefined
  let pendingSample: SubtitleSample | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let discoveryTimer: ReturnType<typeof setInterval> | undefined
  let domObserver: MutationObserver | undefined
  let observedContainer: HTMLElement | undefined
  let backoffUntil = 0
  let activeSourceText = ''
  let statusKind: 'none' | 'translation' | 'hint' | 'error' = 'none'

  const cache = new Map<string, string>()

  const host = document.createElement('div')
  host.setAttribute('data-wt-root', '')
  host.style.cssText =
    'all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483646 !important; pointer-events: none !important; display: none !important; contain: style !important;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = SUBTITLE_CSS
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.setAttribute('role', 'status')
  bubble.setAttribute('aria-live', 'polite')
  overlay.append(bubble)
  shadow.append(style, overlay)

  function cacheKey(text: string): string {
    return `${generation}:${text}`
  }

  function cacheGet(text: string): string | undefined {
    const key = cacheKey(text)
    const value = cache.get(key)
    if (value === undefined) return undefined
    cache.delete(key)
    cache.set(key, value)
    return value
  }

  function cacheSet(text: string, translation: string): void {
    const trimmed = translation.trim()
    if (trimmed === '') return
    const key = cacheKey(text)
    if (cache.has(key)) cache.delete(key)
    cache.set(key, translation)
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  function clearDebounceTimers(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
    if (maxWaitTimer !== undefined) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = undefined
    }
  }

  function clearRetryTimer(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  function cancelInFlight(): void {
    const id = inFlightId
    inFlightId = undefined
    inFlightText = undefined
    if (id !== undefined) {
      options.cancel(id)
    }
  }

  function hideOverlay(): void {
    statusKind = 'none'
    bubble.textContent = ''
    bubble.className = 'bubble'
    host.style.setProperty('display', 'none', 'important')
  }

  function updateOverlayPosition(): void {
    if (disposed || statusKind === 'none' || currentVideo === undefined || !currentVideo.isConnected) {
      host.style.setProperty('display', 'none', 'important')
      return
    }
    const rect = currentVideo.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      host.style.setProperty('display', 'none', 'important')
      return
    }
    const bottomOffset = Math.max(28, Math.round(rect.height * 0.14))
    overlay.style.left = `${Math.round(rect.left)}px`
    overlay.style.top = `${Math.round(rect.top)}px`
    overlay.style.width = `${Math.round(rect.width)}px`
    overlay.style.height = `${Math.max(0, Math.round(rect.height - bottomOffset))}px`
  }

  function ensureHostAttached(container: HTMLElement): void {
    const targetParent = container.isConnected ? container : document.documentElement
    if (host.parentElement !== targetParent) {
      targetParent.append(host)
    }
  }

  function renderOverlay(text: string, kind: 'translation' | 'hint' | 'error'): void {
    if (disposed || currentVideo === undefined || currentContainer === undefined) return
    const trimmed = text.trim()
    if (trimmed === '') {
      hideOverlay()
      return
    }
    ensureHostAttached(currentContainer)
    statusKind = kind
    bubble.className = kind === 'translation' ? 'bubble' : kind === 'hint' ? 'bubble is-hint' : 'bubble is-status'
    if (bubble.textContent !== trimmed) {
      bubble.textContent = trimmed
    }
    host.style.setProperty('display', 'block', 'important')
    updateOverlayPosition()
  }

  function invalidateGeneration(clearCacheEntries = false): void {
    generation += 1
    clearDebounceTimers()
    clearRetryTimer()
    cancelInFlight()
    pendingSample = undefined
    activeSourceText = ''
    if (clearCacheEntries) cache.clear()
    hideOverlay()
  }

const CAPTION_RELEVANT_SELECTOR =
  '.ytp-caption-window-container,.ytp-caption-segment,.player-timedtext,.player-timedtext-text-container,video,source,track'

function nodeTouchesSubtitleOrMedia(node: Node): boolean {
  if (node instanceof Element) {
    if (node.matches(CAPTION_RELEVANT_SELECTOR)) return true
    if (node.closest(CAPTION_RELEVANT_SELECTOR) !== null) return true
    if (node.querySelector(CAPTION_RELEVANT_SELECTOR) !== null) return true
    return false
  }
  const parent = node.parentElement
  return parent !== null && parent.closest(CAPTION_RELEVANT_SELECTOR) !== null
}

function hasRelevantSubtitleMutations(mutations: readonly MutationRecord[], container: HTMLElement, host: HTMLElement): boolean {
  for (const mutation of mutations) {
    const target = mutation.target
    if (target === host || (target instanceof Node && host.contains(target))) continue
    if (mutation.type === 'attributes') {
      if (target === container || (target instanceof Element && target.contains(container))) {
        return true
      }
      if (nodeTouchesSubtitleOrMedia(target)) return true
      continue
    }
    if (mutation.type === 'characterData') {
      if (nodeTouchesSubtitleOrMedia(target)) return true
      continue
    }
    if (mutation.type === 'childList') {
      if (nodeTouchesSubtitleOrMedia(target)) return true
      for (let i = 0; i < mutation.addedNodes.length; i += 1) {
        const n = mutation.addedNodes[i]
        if (n !== undefined && n !== host && !host.contains(n) && nodeTouchesSubtitleOrMedia(n)) return true
      }
      for (let i = 0; i < mutation.removedNodes.length; i += 1) {
        const n = mutation.removedNodes[i]
        if (n !== undefined && n !== host && !host.contains(n) && nodeTouchesSubtitleOrMedia(n)) return true
      }
    }
  }
  return false
}

function isTimeDiscontinuous(
  video: HTMLVideoElement,
  requestVideoTime: number,
  requestWallTime: number,
  requestRate: number,
): boolean {
  const currentVideoTime = Number.isFinite(video.currentTime) ? video.currentTime : 0
  const delta = currentVideoTime - requestVideoTime
  if (delta < -1) return true
  const elapsedSec = Math.max(0, (Date.now() - requestWallTime) / 1000)
  const liveRate = Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1
  const rate = Math.max(1, requestRate, liveRate)
  if (delta > elapsedSec * rate + 1) return true
  return false
}

  function buildRequestTexts(sample: SubtitleSample): string[] {
    const texts: string[] = [sample.text]
    let total = sample.text.length
    const seen = new Set<string>([sample.text])
    for (const next of sample.upcoming) {
      if (texts.length >= MAX_BATCH_ITEMS) break
      if (next === '' || seen.has(next) || cacheGet(next) !== undefined) continue
      if (next.length > MAX_CUE_LENGTH || total + next.length > MAX_TOTAL_LENGTH) continue
      seen.add(next)
      texts.push(next)
      total += next.length
    }
    return texts
  }

  function dispatchSample(sample: SubtitleSample): void {
    if (disposed || document.visibilityState === 'hidden') return
    if (sample.video !== currentVideo || !sample.video.isConnected || !isVideoVisible(sample.video)) return
    if (sample.video.seeking || sample.video.ended) {
      cancelInFlight()
      pendingSample = undefined
      activeSourceText = ''
      hideOverlay()
      return
    }
    const container = resolvePlayerContainer(sample.video)
    currentContainer = container
    if (isPlayerAdActive(container)) {
      invalidateGeneration(false)
      return
    }
    if (currentSource !== undefined && sample.source !== currentSource) {
      currentSource = undefined
      invalidateGeneration(true)
      evaluateCurrentState(false)
      return
    }
    const live = readSubtitleSample(sample.video)
    if (live === undefined || live.source !== sample.source || live.text !== sample.text) {
      evaluateCurrentState(false)
      return
    }
    currentSource = live.source
    const activeText = live.text
    if (activeText === '') {
      activeSourceText = ''
      cancelInFlight()
      pendingSample = undefined
      hideOverlay()
      return
    }
    const cached = cacheGet(activeText)
    if (cached !== undefined) {
      activeSourceText = activeText
      pendingSample = undefined
      cancelInFlight()
      renderOverlay(cached, 'translation')
      return
    }
    if (activeSourceText !== activeText) {
      activeSourceText = activeText
      hideOverlay()
    }
    if (inFlightId !== undefined) {
      if (inFlightText === activeText) return
      pendingSample = live
      return
    }
    const now = Date.now()
    if (now < backoffUntil) {
      pendingSample = live
      if (retryTimer === undefined) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          const next = pendingSample
          pendingSample = undefined
          if (next !== undefined) {
            dispatchSample(next)
          } else {
            evaluateCurrentState(false)
          }
        }, Math.max(1, backoffUntil - now))
      }
      return
    }

    const requestTexts = buildRequestTexts(live)
    const requestId = createId()
    const requestGen = generation
    const requestVideo = live.video
    const requestSource = live.source
    const requestVideoSrc = live.video.currentSrc || live.video.getAttribute('src') || ''
    const requestVideoTime = Number.isFinite(live.video.currentTime) ? live.video.currentTime : 0
    const requestWallTime = Date.now()
    const requestRate = Number.isFinite(live.video.playbackRate) && live.video.playbackRate > 0 ? live.video.playbackRate : 1
    inFlightId = requestId
    inFlightText = activeText
    pendingSample = undefined

    void options
      .translate(requestTexts, requestId)
      .then((reply) => {
        if (inFlightId !== requestId) return
        inFlightId = undefined
        inFlightText = undefined
        if (
          disposed ||
          document.visibilityState === 'hidden' ||
          requestGen !== generation ||
          requestVideo !== currentVideo ||
          !requestVideo.isConnected ||
          !isVideoVisible(requestVideo)
        ) {
          return
        }
        if (requestVideo.seeking || requestVideo.ended) {
          hideOverlay()
          return
        }
        const liveContainer = resolvePlayerContainer(requestVideo)
        currentContainer = liveContainer
        if (isPlayerAdActive(liveContainer)) {
          invalidateGeneration(false)
          return
        }
        const liveSrc = requestVideo.currentSrc || requestVideo.getAttribute('src') || ''
        if (liveSrc !== requestVideoSrc) return
        if (isTimeDiscontinuous(requestVideo, requestVideoTime, requestWallTime, requestRate)) {
          invalidateGeneration(false)
          evaluateCurrentState(false)
          return
        }
        const liveSample = readSubtitleSample(requestVideo)
        if (liveSample === undefined || liveSample.source !== requestSource || currentSource !== requestSource) {
          pendingSample = undefined
          evaluateCurrentState(false)
          return
        }
        if (reply.ok && Array.isArray(reply.texts) && reply.texts.length === requestTexts.length) {
          requestTexts.forEach((srcText, idx) => {
            const translated = reply.texts[idx]
            if (typeof translated === 'string' && translated.trim() !== '') {
              cacheSet(srcText, translated)
            }
          })
          if (liveSample.text === activeText) {
            const activeTranslated = cacheGet(activeText) ?? reply.texts[0] ?? ''
            if (activeTranslated.trim() !== '') {
              renderOverlay(activeTranslated, 'translation')
            }
          }
        } else if (!reply.ok && reply.code !== 'cancelled') {
          const waitMs = Math.max(MIN_BACKOFF_MS, reply.retryAfterMs ?? MIN_BACKOFF_MS)
          backoffUntil = Date.now() + waitMs
          if (liveSample.text === activeText) {
            renderOverlay(options.t('wtRetryBubbleTitle'), 'error')
          }
        }

        pendingSample = undefined
        if (liveSample.text !== activeText) {
          evaluateCurrentState(false)
        }
      })
      .catch(() => {
        if (inFlightId !== requestId) return
        inFlightId = undefined
        inFlightText = undefined
        if (
          disposed ||
          document.visibilityState === 'hidden' ||
          requestGen !== generation ||
          requestVideo !== currentVideo ||
          !requestVideo.isConnected ||
          !isVideoVisible(requestVideo) ||
          requestVideo.seeking ||
          requestVideo.ended
        ) {
          return
        }
        const waitMs = MIN_BACKOFF_MS
        backoffUntil = Date.now() + waitMs
        const liveSample = readSubtitleSample(requestVideo)
        if (liveSample !== undefined && liveSample.source === requestSource && liveSample.text === activeText) {
          renderOverlay(options.t('wtRetryBubbleTitle'), 'error')
        }
        pendingSample = undefined
        if (liveSample !== undefined && liveSample.text !== activeText) {
          evaluateCurrentState(false)
        }
      })
  }

  function scheduleDomSample(sample: SubtitleSample): void {
    if (sample.text === '') {
      clearDebounceTimers()
      dispatchSample(sample)
      return
    }
    if (activeSourceText !== sample.text) {
      activeSourceText = sample.text
      hideOverlay()
    }
    const cached = cacheGet(sample.text)
    if (cached !== undefined) {
      clearDebounceTimers()
      dispatchSample(sample)
      return
    }
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    const flush = (): void => {
      clearDebounceTimers()
      if (disposed || currentVideo === undefined) return
      evaluateCurrentState(false)
    }
    debounceTimer = setTimeout(flush, DOM_DEBOUNCE_MS)
    if (maxWaitTimer === undefined) {
      maxWaitTimer = setTimeout(flush, DOM_MAX_WAIT_MS)
    }
  }

  function evaluateCurrentState(fromDomMutation = false): void {
    if (disposed || document.visibilityState === 'hidden') return
    if (currentVideo === undefined || !currentVideo.isConnected || !isVideoVisible(currentVideo)) {
      hideOverlay()
      return
    }
    if (currentVideo.seeking || currentVideo.ended) {
      clearDebounceTimers()
      clearRetryTimer()
      cancelInFlight()
      pendingSample = undefined
      activeSourceText = ''
      hideOverlay()
      return
    }
    const container = resolvePlayerContainer(currentVideo)
    currentContainer = container
    if (isPlayerAdActive(container)) {
      invalidateGeneration(false)
      return
    }
    const nextTrack = findShowingSubtitleTrack(currentVideo)
    if (nextTrack !== currentTrack) {
      detachTrackListener()
      currentTrack = nextTrack
      attachTrackListener()
    }
    const sample = readSubtitleSample(currentVideo)
    if (sample === undefined) {
      clearDebounceTimers()
      clearRetryTimer()
      cancelInFlight()
      pendingSample = undefined
      activeSourceText = ''
      if (isYouTubeHost() || isNetflixHost() || hasImageOnlySubtitles(container) || hasUnsupportedShowingTrack(currentVideo)) {
        renderOverlay(options.t('wtSubtitleWaitingHint'), 'hint')
      } else {
        hideOverlay()
      }
      return
    }
    if (currentSource !== undefined && currentSource !== sample.source) {
      currentSource = sample.source
      invalidateGeneration(true)
    } else {
      currentSource = sample.source
    }
    const isDomSource = !(typeof TextTrack !== 'undefined' && sample.source instanceof TextTrack) && sample.source !== currentTrack
    if (fromDomMutation && isDomSource) {
      scheduleDomSample(sample)
    } else {
      clearDebounceTimers()
      dispatchSample(sample)
    }
  }

  function onCueChange(): void {
    if (disposed) return
    cancelInFlight()
    pendingSample = undefined
    evaluateCurrentState(false)
  }

  function attachTrackListener(): void {
    if (currentTrack === undefined) return
    try {
      currentTrack.addEventListener('cuechange', onCueChange)
    } catch {
      void 0
    }
  }

  function detachTrackListener(): void {
    if (currentTrack === undefined) return
    try {
      currentTrack.removeEventListener('cuechange', onCueChange)
    } catch {
      void 0
    }
    currentTrack = undefined
  }

  function onTrackListChange(): void {
    if (disposed) return
    invalidateGeneration(true)
    evaluateCurrentState(false)
  }

  function onVideoResetEvent(): void {
    if (disposed) return
    const nextSrc = currentVideo ? currentVideo.currentSrc || currentVideo.getAttribute('src') || '' : ''
    const srcChanged = nextSrc !== currentVideoSrc
    currentVideoSrc = nextSrc
    invalidateGeneration(srcChanged)
    if (currentVideo === undefined || currentVideo.seeking || currentVideo.ended) {
      return
    }
    evaluateCurrentState(false)
  }

  function observePlayerDom(container: HTMLElement): void {
    if (observedContainer === container && domObserver !== undefined) return
    domObserver?.disconnect()
    domObserver = undefined
    observedContainer = undefined
    if (!isYouTubeHost() && !isNetflixHost()) return
    if (typeof MutationObserver !== 'function') return
    observedContainer = container
    domObserver = new MutationObserver((mutations) => {
      if (disposed || !hasRelevantSubtitleMutations(mutations, container, host)) return
      evaluateCurrentState(true)
    })
    domObserver.observe(container, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    })
  }

  function bindVideo(video: HTMLVideoElement | undefined): void {
    if (video === currentVideo) {
      if (video !== undefined) {
        const nextSrc = video.currentSrc || video.getAttribute('src') || ''
        if (nextSrc !== currentVideoSrc) {
          currentVideoSrc = nextSrc
          invalidateGeneration(true)
        }
        const container = resolvePlayerContainer(video)
        currentContainer = container
        observePlayerDom(container)
      }
      return
    }
    if (currentVideo !== undefined) {
      currentVideo.removeEventListener('seeking', onVideoResetEvent)
      currentVideo.removeEventListener('seeked', onVideoResetEvent)
      currentVideo.removeEventListener('emptied', onVideoResetEvent)
      currentVideo.removeEventListener('ended', onVideoResetEvent)
      currentVideo.removeEventListener('play', onVideoResetEvent)
      currentVideo.removeEventListener('loadedmetadata', onVideoResetEvent)
      try {
        currentVideo.textTracks?.removeEventListener?.('change', onTrackListChange)
        currentVideo.textTracks?.removeEventListener?.('addtrack', onTrackListChange)
        currentVideo.textTracks?.removeEventListener?.('removetrack', onTrackListChange)
      } catch {
        void 0
      }
    }
    detachTrackListener()
    domObserver?.disconnect()
    domObserver = undefined
    observedContainer = undefined
    currentVideo = video
    currentSource = undefined
    currentContainer = video ? resolvePlayerContainer(video) : undefined
    currentVideoSrc = video ? video.currentSrc || video.getAttribute('src') || '' : ''
    invalidateGeneration(true)
    if (video === undefined) return

    video.addEventListener('seeking', onVideoResetEvent)
    video.addEventListener('seeked', onVideoResetEvent)
    video.addEventListener('emptied', onVideoResetEvent)
    video.addEventListener('ended', onVideoResetEvent)
    video.addEventListener('play', onVideoResetEvent)
    video.addEventListener('loadedmetadata', onVideoResetEvent)
    try {
      video.textTracks?.addEventListener?.('change', onTrackListChange)
      video.textTracks?.addEventListener?.('addtrack', onTrackListChange)
      video.textTracks?.addEventListener?.('removetrack', onTrackListChange)
    } catch {
      void 0
    }
    if (currentContainer !== undefined) {
      observePlayerDom(currentContainer)
    }
  }

  function scanVideos(): void {
    if (disposed) return
    if (document.visibilityState === 'hidden') {
      invalidateGeneration(false)
      return
    }
    const target = selectTargetVideo()
    bindVideo(target)
    if (target !== undefined) {
      evaluateCurrentState(false)
      updateOverlayPosition()
    }
  }

  function onVisibilityChange(): void {
    if (disposed) return
    if (document.visibilityState === 'hidden') {
      invalidateGeneration(false)
    } else {
      scanVideos()
    }
  }

  function onViewportChange(): void {
    if (disposed) return
    updateOverlayPosition()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('fullscreenchange', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)

  scanVideos()
  discoveryTimer = setInterval(scanVideos, DISCOVERY_INTERVAL_MS)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (discoveryTimer !== undefined) {
        clearInterval(discoveryTimer)
        discoveryTimer = undefined
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('fullscreenchange', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
      bindVideo(undefined)
      invalidateGeneration(true)
      host.remove()
    },
  }
}
