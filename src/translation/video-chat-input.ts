import { closestComposed } from './sites'

export type NativeVideoChatKind = 'youtube' | 'bilibili'

const NATIVE_VIDEO_HOST_KINDS: ReadonlyArray<readonly [string, NativeVideoChatKind]> = [
  ['www.youtube.com', 'youtube'],
  ['youtube.com', 'youtube'],
  ['www.bilibili.com', 'bilibili'],
  ['bilibili.com', 'bilibili'],
  ['live.bilibili.com', 'bilibili'],
]

const RICH_MANAGED_SELECTOR = '.ProseMirror,[data-lexical-editor],[data-slate-editor],.ql-editor'

const NATIVE_VIDEO_ALLOWED_TAGS = new Set(['DIV', 'P', 'SPAN', 'BR'])

function hostKind(url: URL): NativeVideoChatKind | undefined {
  for (const [host, kind] of NATIVE_VIDEO_HOST_KINDS) {
    if (url.hostname === host) return kind
  }
  return undefined
}

export function nativeVideoChatKind(element: HTMLElement): NativeVideoChatKind | undefined {
  let url: URL
  try {
    url = new URL(element.ownerDocument.location.href)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  const kind = hostKind(url)
  if (kind === undefined) return undefined
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return undefined
  const rawEditable = element.getAttribute('contenteditable')
  if (rawEditable === null) return undefined
  const contentEditable = rawEditable.trim().toLowerCase()
  if (contentEditable !== 'true' && contentEditable !== '' && contentEditable !== 'plaintext-only') {
    return undefined
  }
  if (closestComposed(element, RICH_MANAGED_SELECTOR) !== null) return undefined
  if (kind === 'youtube') {
    if (element.id === 'contenteditable-root') return 'youtube'
    if (
      element.id === 'input' &&
      (element.classList.contains('yt-live-chat-text-input-field-renderer') ||
        closestComposed(element, 'yt-live-chat-text-input-field-renderer,yt-live-chat-message-input-renderer') !== null)
    ) {
      return 'youtube'
    }
    return undefined
  }
  if (
    (element.matches('.brt-editor') && closestComposed(element, 'bili-comment-rich-textarea') !== null) ||
    element.matches('.reply-box-textarea')
  ) {
    return 'bilibili'
  }
  return undefined
}

function isHiddenNode(node: HTMLElement): boolean {
  const style = getComputedStyle(node)
  return style.display === 'none' || style.visibility === 'hidden'
}

function isPlainNativeVideoTree(root: HTMLElement): boolean {
  if (isHiddenNode(root)) return false
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ALL)
  let visited = 0
  for (let node = walker.nextNode(); node !== null && visited <= 12000; node = walker.nextNode()) {
    visited += 1
    if (node instanceof Text) continue
    if (node.nodeType === Node.COMMENT_NODE) continue
    if (!(node instanceof HTMLElement)) return false
    if (!NATIVE_VIDEO_ALLOWED_TAGS.has(node.tagName)) return false
    if (node.hasAttribute('contenteditable')) return false
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) return false
    if (node.classList.contains('mention')) return false
    if (node.hasAttribute('data-mention')) return false
    const nodeType = node.getAttribute('data-type') ?? node.getAttribute('data-node-type') ?? ''
    if (nodeType === 'mention') return false
    if (isHiddenNode(node)) return false
  }
  return visited <= 12000
}

export function isNativeVideoChatEditor(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return false
  if (nativeVideoChatKind(element) === undefined) return false
  return isPlainNativeVideoTree(element)
}

export function readNativeVideoChatDraft(element: HTMLElement): string {
  const text = element.innerText
  if (typeof text !== 'string') return ''
  return text.replace(/\r\n?/g, '\n')
}

export interface NativeVideoChatPlan {
  readonly lines: readonly string[]
  readonly trailingBreaks: number
}

const MAX_NATIVE_EDIT_LINES = 128

// 保守限制：当前原生 insertLineBreak 命令序列在有内容末尾会生成额外占位 <br>，
// 因而 t >= 2 个末尾 LF 需执行 t - 1 次命令，而单个末尾 LF（t === 1）无法由该命令序列精确写回
// （并非任意 HTML 都无法表示单个末尾 LF）。
export function planNativeVideoChatDraft(text: string): NativeVideoChatPlan | undefined {
  const normalized = text.replace(/\r\n?/g, '\n')
  const trailing = /\n*$/.exec(normalized)![0].length
  const body = normalized.slice(0, normalized.length - trailing)
  if (body === '' || trailing === 1) return undefined
  const lines = body.split('\n')
  const trailingBreaks = trailing >= 2 ? trailing - 1 : 0
  if (lines.length + trailingBreaks > MAX_NATIVE_EDIT_LINES) return undefined
  return { lines, trailingBreaks }
}

