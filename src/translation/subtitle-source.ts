export interface SubtitleSample {
  readonly video: HTMLVideoElement
  readonly container: HTMLElement
  readonly source: object
  readonly text: string
  readonly upcoming: readonly string[]
}

const MAX_CUE_LENGTH = 1500
const MAX_TOTAL_LENGTH = 4000
const MAX_UPCOMING_COUNT = 4
const UPCOMING_WINDOW_SEC = 15
const SUPPORTED_TRACK_LANG = /^(?:en|ja)(?:-|$)/i

function isExactHostOrSubdomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === domain || host.endsWith(`.${domain}`)
}

export function isYouTubeHost(hostname: string = location.hostname): boolean {
  return isExactHostOrSubdomain(hostname, 'youtube.com')
}

export function isNetflixHost(hostname: string = location.hostname): boolean {
  return isExactHostOrSubdomain(hostname, 'netflix.com')
}

function normalizeSubtitleText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(0, MAX_CUE_LENGTH)
}

function readCueText(cue: TextTrackCue): string {
  const candidate = cue as TextTrackCue & {
    getCueAsHTML?: () => DocumentFragment
    text?: string
  }
  if (typeof candidate.getCueAsHTML === 'function') {
    try {
      const fragment = candidate.getCueAsHTML()
      if (fragment !== null && typeof fragment.textContent === 'string') {
        const extracted = normalizeSubtitleText(fragment.textContent)
        if (extracted !== '') return extracted
      }
    } catch {
      void 0
    }
  }
  if (typeof candidate.text === 'string') {
    return normalizeSubtitleText(candidate.text)
  }
  return ''
}

function isSupportedTrack(track: TextTrack): boolean {
  if (track.mode !== 'showing') return false
  if (track.kind !== 'subtitles' && track.kind !== 'captions') return false
  const lang = (track.language ?? '').trim()
  return lang === '' || SUPPORTED_TRACK_LANG.test(lang)
}

export function findShowingSubtitleTrack(video: HTMLVideoElement): TextTrack | undefined {
  const tracks = video.textTracks
  if (tracks === undefined || tracks === null) return undefined
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]
    if (track !== undefined && isSupportedTrack(track)) return track
  }
  return undefined
}

function readTextTrackSample(video: HTMLVideoElement, container: HTMLElement): SubtitleSample | undefined {
  const track = findShowingSubtitleTrack(video)
  if (track === undefined) return undefined
  const activeCues = track.activeCues
  const activeTexts: string[] = []
  if (activeCues !== null && activeCues !== undefined) {
    for (let i = 0; i < activeCues.length; i += 1) {
      const cue = activeCues[i]
      if (cue === undefined) continue
      const text = readCueText(cue)
      if (text !== '') activeTexts.push(text)
    }
  }
  const text = normalizeSubtitleText(activeTexts.join('\n'))
  const upcoming: string[] = []
  if (text !== '' && track.cues !== null && track.cues !== undefined) {
    const now = Number.isFinite(video.currentTime) ? video.currentTime : 0
    const seen = new Set<string>([text])
    let totalChars = text.length
    for (let i = 0; i < track.cues.length; i += 1) {
      if (upcoming.length >= MAX_UPCOMING_COUNT) break
      const cue = track.cues[i]
      if (cue === undefined) continue
      if (cue.startTime < now || cue.startTime > now + UPCOMING_WINDOW_SEC) continue
      const cueText = readCueText(cue)
      if (cueText === '' || seen.has(cueText)) continue
      if (cueText.length > MAX_CUE_LENGTH || totalChars + cueText.length > MAX_TOTAL_LENGTH) continue
      seen.add(cueText)
      upcoming.push(cueText)
      totalChars += cueText.length
    }
  }
  return {
    video,
    container,
    source: track,
    text,
    upcoming,
  }
}

export function isSubtitleElementVisible(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current !== null; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  }
  return true
}

function readYouTubeDomSample(video: HTMLVideoElement): SubtitleSample | undefined {
  const player = video.closest<HTMLElement>('#movie_player,.html5-video-player')
  if (player === null) return undefined
  if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
    return undefined
  }
  const windowContainer = player.querySelector<HTMLElement>('.ytp-caption-window-container')
  if (windowContainer === null || !isSubtitleElementVisible(windowContainer)) return undefined
  const segments = windowContainer.querySelectorAll<HTMLElement>('.ytp-caption-segment')
  const lines: string[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    if (seg === undefined || !isSubtitleElementVisible(seg)) continue
    const part = (seg.textContent ?? '').replace(/[ \t\f\v]+/g, ' ').trim()
    if (part !== '') lines.push(part)
  }
  if (lines.length === 0) return undefined
  return {
    video,
    container: player,
    source: windowContainer,
    text: normalizeSubtitleText(lines.join('\n')),
    upcoming: [],
  }
}

function readVisibleSubtitleText(node: Node): string {
  if (node instanceof Text) return node.data
  if (!(node instanceof HTMLElement) || !isSubtitleElementVisible(node)) return ''
  if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return ''
  if (node.tagName === 'BR') return '\n'
  const text = Array.from(node.childNodes, readVisibleSubtitleText).join('')
  return getComputedStyle(node).display === 'block' ? `${text}\n` : text
}

function readNetflixDomSample(video: HTMLVideoElement): SubtitleSample | undefined {
  const player = video.closest<HTMLElement>('.watch-video--player-view') ?? video.parentElement
  if (player === null) return undefined
  const timedText = player.querySelector<HTMLElement>('.player-timedtext')
  const containers = player.querySelectorAll<HTMLElement>('.player-timedtext-text-container')
  if (timedText === null && containers.length === 0) return undefined
  if (timedText !== null && !isSubtitleElementVisible(timedText)) return undefined
  if (
    containers.length === 0 &&
    timedText !== null &&
    timedText.querySelector('svg,img,canvas,image') !== null
  ) {
    return undefined
  }
  const lines: string[] = []
  for (const container of containers) {
    const text = normalizeSubtitleText(readVisibleSubtitleText(container))
    if (text !== '') lines.push(text)
  }
  if (lines.length === 0) return undefined
  return {
    video,
    container: player,
    source: timedText ?? player,
    text: normalizeSubtitleText(lines.join('\n')),
    upcoming: [],
  }
}

export function resolvePlayerContainer(video: HTMLVideoElement): HTMLElement {
  if (isYouTubeHost()) {
    const yt = video.closest<HTMLElement>('#movie_player,.html5-video-player')
    if (yt !== null) return yt
  }
  if (isNetflixHost()) {
    const nf = video.closest<HTMLElement>('.watch-video--player-view')
    if (nf !== null) return nf
  }
  return video.parentElement ?? document.documentElement
}

export function readSubtitleSample(video: HTMLVideoElement): SubtitleSample | undefined {
  if (!video.isConnected || !isSubtitleElementVisible(video)) return undefined
  const container = resolvePlayerContainer(video)
  if (
    isYouTubeHost() &&
    (container.classList.contains('ad-showing') || container.classList.contains('ad-interrupting'))
  ) {
    return undefined
  }
  const trackSample = readTextTrackSample(video, container)
  if (trackSample !== undefined && trackSample.text !== '') return trackSample
  if (isYouTubeHost()) {
    const ytSample = readYouTubeDomSample(video)
    if (ytSample !== undefined) {
      if (ytSample.text !== '' || trackSample === undefined) return ytSample
    }
  }
  if (isNetflixHost()) {
    const nfSample = readNetflixDomSample(video)
    if (nfSample !== undefined) {
      if (nfSample.text !== '' || trackSample === undefined) return nfSample
    }
  }
  return trackSample
}
