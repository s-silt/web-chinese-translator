import { browser } from 'wxt/browser'
import type { ScriptPublicPath } from 'wxt/utils/inject-script'

export const INPUT_FRAME_SCRIPT_ID = 'wt-input-frames'
export const INPUT_FRAME_SCRIPT_FILES: ScriptPublicPath[] = ['/input-frame.js']

export interface InputFrameSnapshot {
  readonly url: string
  readonly topUrl: string
  readonly focused: boolean
}

export interface InputFrameDocument {
  readonly frameId: number
  readonly documentId: string
  readonly snapshot: InputFrameSnapshot
}

function parseYouTubeUrl(value: string): URL | undefined {
  if (typeof value !== 'string' || value === '' || value.length > 8192) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
      return undefined
    }
    if (url.hostname !== 'youtube.com' && url.hostname !== 'www.youtube.com') {
      return undefined
    }
    return url
  } catch {
    return undefined
  }
}

export function isYouTubePageUrl(value: string): boolean {
  return parseYouTubeUrl(value) !== undefined
}

export function isYouTubeLiveChatUrl(value: string): boolean {
  const url = parseYouTubeUrl(value)
  return url !== undefined && url.pathname === '/live_chat'
}

export function isYouTubeInputFramePair(topUrl: string, frameUrl: string): boolean {
  const top = parseYouTubeUrl(topUrl)
  const frame = parseYouTubeUrl(frameUrl)
  if (top === undefined || frame === undefined) return false
  return frame.pathname === '/live_chat' && top.origin === frame.origin
}

export function currentYouTubeInputFrameTopUrl(): string | undefined {
  try {
    if (window.top === null || window.top === window) return undefined
    const topUrl = window.top.location.href
    const frameUrl = location.href
    if (typeof topUrl !== 'string' || typeof frameUrl !== 'string') return undefined
    return isYouTubeInputFramePair(topUrl, frameUrl) ? topUrl : undefined
  } catch {
    return undefined
  }
}

export function inputFrameUrl(topUrl: string, frameUrl: string): string | undefined {
  try {
    const top = new URL(topUrl)
    if (!['https:', 'http:'].includes(top.protocol) || top.username !== '' || top.password !== '') {
      return undefined
    }
    if (frameUrl === 'about:blank' || frameUrl === 'about:srcdoc') return top.href
    const frame = new URL(frameUrl)
    return frame.origin === top.origin &&
      ['https:', 'http:'].includes(frame.protocol) &&
      frame.username === '' &&
      frame.password === ''
      ? frame.href
      : undefined
  } catch {
    return undefined
  }
}

export function currentInputFrameTopUrl(): string | undefined {
  try {
    if (window.top === null || window.top === window) return undefined
    const topUrl = window.top.location.href
    const frameUrl = location.href
    if (typeof topUrl !== 'string' || typeof frameUrl !== 'string') return undefined
    return inputFrameUrl(topUrl, frameUrl) === undefined ? undefined : topUrl
  } catch {
    return undefined
  }
}

export function readInputFrameSnapshot(): InputFrameSnapshot | undefined {
  try {
    const url = typeof location?.href === 'string' ? location.href : ''
    const topUrl = typeof window.top?.location?.href === 'string' ? window.top.location.href : ''
    if (url === '' || topUrl === '') return undefined
    let active: Element | null = document.activeElement
    for (
      let depth = 0;
      depth < 32 && active?.shadowRoot?.activeElement !== undefined && active?.shadowRoot?.activeElement !== null;
      depth += 1
    ) {
      active = active.shadowRoot.activeElement
    }
    const tag = active?.tagName?.toUpperCase() ?? ''
    const focused =
      document.hasFocus() &&
      active?.tagName !== 'IFRAME' &&
      active?.tagName !== 'FRAME' &&
      tag !== 'IFRAME' &&
      tag !== 'FRAME'
    return { url, topUrl, focused }
  } catch {
    return undefined
  }
}

export function isInputFrameSnapshot(value: unknown): value is InputFrameSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.url === 'string' &&
    record.url.length > 0 &&
    record.url.length <= 8192 &&
    typeof record.topUrl === 'string' &&
    record.topUrl.length > 0 &&
    record.topUrl.length <= 8192 &&
    typeof record.focused === 'boolean'
  )
}

export function parseInputFrameDocument(value: unknown): InputFrameDocument | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entry = value as { frameId?: unknown; documentId?: unknown; result?: unknown }
  if (
    typeof entry.frameId !== 'number' ||
    !Number.isSafeInteger(entry.frameId) ||
    entry.frameId < 0 ||
    typeof entry.documentId !== 'string' ||
    entry.documentId.length === 0 ||
    entry.documentId.length > 256 ||
    !isInputFrameSnapshot(entry.result)
  ) {
    return undefined
  }
  return {
    frameId: entry.frameId,
    documentId: entry.documentId,
    snapshot: entry.result,
  }
}

export async function readInputFrameDocuments(tabId: number): Promise<InputFrameDocument[]> {
  const scripting = browser.scripting
  if (typeof scripting?.executeScript !== 'function') return []
  try {
    let results: unknown
    try {
      results = await scripting.executeScript({
        target: { tabId, allFrames: true },
        func: readInputFrameSnapshot,
      })
    } catch {
      results = await scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: readInputFrameSnapshot,
      })
    }
    if (!Array.isArray(results)) return []
    const documents: InputFrameDocument[] = []
    for (const item of results) {
      const parsed = parseInputFrameDocument(item)
      if (parsed !== undefined) documents.push(parsed)
    }
    return documents
  } catch {
    return []
  }
}
