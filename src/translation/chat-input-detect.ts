export type ChatReplacementStatus = 'ok' | 'changed' | 'unsupported' | 'failed'

export interface ChatReplacementRequest {
  readonly elementId: string
  readonly expectedText: string
  readonly text: string
}

const EXACT_CHAT_HOSTS = new Set([
  'chatgpt.com',
  'github.com',
  'claude.ai',
  'web.telegram.org',
  'web.whatsapp.com',
  'teams.microsoft.com',
  'teams.live.com',
  'teams.cloud.microsoft',
  'x.com',
  'www.x.com',
  'pro.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'tweetdeck.twitter.com',
  'www.reddit.com',
  'reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'sh.reddit.com',
  'www.threads.net',
  'threads.net',
  'www.threads.com',
  'threads.com',
  'bsky.app',
  'www.facebook.com',
  'facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'www.messenger.com',
  'messenger.com',
  'www.instagram.com',
  'instagram.com',
  'www.linkedin.com',
  'linkedin.com',
  'www.zhihu.com',
  'zhihu.com',
  'zhuanlan.zhihu.com',
  'weibo.com',
  'www.weibo.com',
  's.weibo.com',
  'm.weibo.cn',
  'www.xiaohongshu.com',
  'xiaohongshu.com',
  'www.douyin.com',
  'douyin.com',
  'www.twitch.tv',
  'twitch.tv',
  'dashboard.twitch.tv',
  'substack.com',
  'medium.com',
  'dev.to',
  'www.quora.com',
  'quora.com',
  'www.producthunt.com',
  'producthunt.com',
  'linux.do',
  'v2ex.com',
  'www.v2ex.com',
  'nodeseek.com',
  'www.nodeseek.com',
  'gemini.google.com',
  'aistudio.google.com',
  'notebooklm.google.com',
  'grok.com',
  'www.grok.com',
  'chat.deepseek.com',
  'www.deepseek.com',
  'www.perplexity.ai',
  'perplexity.ai',
  'poe.com',
  'www.poe.com',
  'chat.mistral.ai',
  'copilot.microsoft.com',
  'kimi.moonshot.cn',
  'www.kimi.com',
  'kimi.com',
  'www.doubao.com',
  'doubao.com',
  'yuanbao.tencent.com',
  'chat.qwen.ai',
  'qwen.ai',
  'tongyi.aliyun.com',
  'www.tongyi.com',
  'qianwen.com',
  'www.qianwen.com',
  'chatglm.cn',
  'www.chatglm.cn',
  'huggingface.co',
  'openrouter.ai',
  'devin.ai',
  'app.devin.ai',
  'cursor.com',
  'www.cursor.com',
  'bolt.new',
  'lovable.dev',
  'replit.com',
  'v0.dev',
  'linear.app',
  'www.notion.so',
  'notion.so',
])
const BLOCKED_CHAT_PATH = /(?:^|\/)(?:settings|api[-_]?keys?|secrets|passwords?|oauth|checkout|payments?|billing|accounts?|auth|sign-?in|sign-?up|log-?in|register)(?:\/|$)/i
const SLACK_CHAT_PATH = /^\/(?:client|messages)(?:\/|$)/
const ALLOWED_CHAT_TAGS = new Set(['DIV', 'P', 'SPAN', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S'])
const BLOCKED_CHAT_SELECTOR = 'img,svg,canvas,button,input,textarea,a,ul,ol,li,table,pre,code,.ProseMirror-widget,[data-node-view-wrapper],[data-decoration-id],[data-mention],[data-lexical-decorator],[data-lexical-mention],[data-slate-void="true"]'

function isSlackChatHost(host: string): boolean {
  return host === 'app.slack.com' || host.endsWith('.slack.com')
}

function isTeamsChatHost(host: string): boolean {
  return host === 'teams.microsoft.com' || host === 'teams.live.com' || host === 'teams.cloud.microsoft'
}

function isTwitterChatHost(host: string): boolean {
  return (
    host === 'x.com' ||
    host === 'www.x.com' ||
    host === 'pro.x.com' ||
    host === 'twitter.com' ||
    host === 'www.twitter.com' ||
    host === 'mobile.twitter.com' ||
    host === 'tweetdeck.twitter.com'
  )
}

function isMetaLexicalHost(host: string): boolean {
  return (
    host === 'web.whatsapp.com' ||
    host === 'www.facebook.com' ||
    host === 'facebook.com' ||
    host === 'm.facebook.com' ||
    host === 'web.facebook.com' ||
    host === 'www.messenger.com' ||
    host === 'messenger.com' ||
    host === 'www.instagram.com' ||
    host === 'instagram.com' ||
    host === 'www.threads.net' ||
    host === 'threads.net' ||
    host === 'www.threads.com' ||
    host === 'threads.com'
  )
}

export function isSupportedChatUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    const slack = isSlackChatHost(host)
    if (!slack && !EXACT_CHAT_HOSTS.has(host)) return false
    if (host === 'web.telegram.org' && !/^\/(?:a|k)(?:\/|$)/.test(url.pathname)) return false
    if (slack && !SLACK_CHAT_PATH.test(url.pathname)) return false
    return !BLOCKED_CHAT_PATH.test(url.pathname)
  } catch {
    return false
  }
}

export type ChatEditorKind = 'pm' | 'lexical' | 'quill' | 'rooster' | 'draft' | 'slate'

function pageHost(): string {
  try {
    return new URL(location.href).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function closestAcrossShadow(element: Element, selector: string): Element | null {
  let current: Element | null = element
  for (let depth = 0; current !== null && depth < 64; depth += 1) {
    const match = current.closest(selector)
    if (match !== null) return match
    const root = current.getRootNode()
    current = root instanceof ShadowRoot ? root.host : null
  }
  return null
}

export function chatEditorKind(element: HTMLElement): ChatEditorKind | undefined {
  if (element.getAttribute('contenteditable') !== 'true') return undefined
  if (element.matches('.ProseMirror')) return 'pm'
  if (element.matches('[data-lexical-editor="true"],[data-lexical-editor=""]')) return 'lexical'
  if (element.matches('.ql-editor')) return 'quill'
  if (
    element.matches('.public-DraftEditor-content') ||
    closestAcrossShadow(element, '.DraftEditor-root') !== null ||
    element.querySelector('[data-contents="true"],[data-block="true"]') !== null
  ) {
    return 'draft'
  }
  if (element.matches('[data-slate-editor="true"],[data-slate-editor=""]')) return 'slate'
  const host = pageHost()
  if (isMetaLexicalHost(host)) return 'lexical'
  if (isSlackChatHost(host) || host === 'gemini.google.com' || host === 'www.linkedin.com' || host === 'linkedin.com') {
    return 'quill'
  }
  if (isTeamsChatHost(host)) return 'rooster'
  if (isTwitterChatHost(host)) return 'draft'
  return undefined
}

export function isChatEditorCandidate(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && isSupportedChatUrl(location.href) && chatEditorKind(element) !== undefined
}

function isAllowedChatMarkup(element: HTMLElement): boolean {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT)
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    if (!(current instanceof Element) || isIgnoredChatSubtree(current)) continue
    if (!ALLOWED_CHAT_TAGS.has(current.tagName)) return false
  }
  return true
}

function hasBlockedChatContent(element: HTMLElement): boolean {
  for (const node of element.querySelectorAll(BLOCKED_CHAT_SELECTOR)) {
    if (!isIgnoredChatSubtree(node)) return true
  }
  return false
}

function isLexicalManagedBreak(node: Node): boolean {
  return node instanceof HTMLBRElement && node.getAttribute('data-lexical-managed-linebreak') === 'true'
}

function isDraftManagedBreak(node: Node): boolean {
  return node instanceof HTMLBRElement && node.getAttribute('data-text') === 'true'
}

function isIgnoredChatSubtree(node: Element): boolean {
  if (isLexicalManagedBreak(node) || isDraftManagedBreak(node)) return true
  return node.classList.contains('ProseMirror-trailingBreak') ||
    node.classList.contains('ProseMirror-separator') ||
    node.classList.contains('ProseMirror-gapcursor') ||
    node.classList.contains('public-DraftEditorPlaceholder-root') ||
    node.hasAttribute('data-placeholder') ||
    node.hasAttribute('data-slate-zero-width') ||
    node.hasAttribute('data-slate-placeholder') ||
    node.closest('.public-DraftEditorPlaceholder-root,[data-placeholder],[data-slate-zero-width],[data-slate-placeholder]') !== null
}

function directChatBlocks(element: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = []
  for (const child of element.children) {
    if (child instanceof HTMLElement && !isIgnoredChatSubtree(child) && (child.tagName === 'P' || child.tagName === 'DIV')) {
      blocks.push(child)
    }
  }
  return blocks
}

function flatChatBlocks(element: HTMLElement): boolean {
  const blocks = directChatBlocks(element)
  let nonIgnoredChildren = 0
  for (const child of element.children) {
    if (!isIgnoredChatSubtree(child)) nonIgnoredChildren += 1
  }
  if (blocks.length === 0 || blocks.length !== nonIgnoredChildren) return false
  for (const block of blocks) {
    if (block.querySelector('p,div') !== null) return false
  }
  return true
}

function draftChatBlocks(element: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = []
  for (const node of element.querySelectorAll('[data-block="true"]')) {
    if (node instanceof HTMLElement && !isIgnoredChatSubtree(node)) blocks.push(node)
  }
  return blocks
}

function validDraftChatBlocks(element: HTMLElement): boolean {
  const blocks = draftChatBlocks(element)
  if (blocks.length === 0) return flatChatBlocks(element)
  for (const block of blocks) {
    if (block.querySelector('[data-block="true"],p') !== null) return false
  }
  return true
}

function slateChatBlocks(element: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = []
  for (const child of element.children) {
    if (child instanceof HTMLElement && !isIgnoredChatSubtree(child) && child.getAttribute('data-slate-node') === 'element') {
      blocks.push(child)
    }
  }
  return blocks
}

function validSlateChatBlocks(element: HTMLElement): boolean {
  if (element.querySelector('[data-slate-node="element"] [data-slate-node="element"]') !== null) return false
  const blocks = slateChatBlocks(element)
  return blocks.length > 0 || flatChatBlocks(element)
}

export function isChatPlainEditor(element: Element): element is HTMLElement {
  if (!isChatEditorCandidate(element) || !element.isConnected) return false
  if (element.getAttribute('aria-readonly') === 'true' || element.getAttribute('aria-disabled') === 'true') return false
  if (element.hidden || element.inert || closestAcrossShadow(element, '[hidden],[inert],[aria-hidden="true"],[data-sensitive],[data-wt-root]') !== null) {
    return false
  }
  const style = element.style
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const kind = chatEditorKind(element)
  if (kind === 'draft') {
    if (!validDraftChatBlocks(element)) return false
  } else if (kind === 'slate') {
    if (!validSlateChatBlocks(element)) return false
  } else if (kind !== 'pm' && !flatChatBlocks(element)) {
    return false
  }
  if (!isAllowedChatMarkup(element)) return false
  if (hasBlockedChatContent(element)) return false
  for (const locked of element.querySelectorAll('[contenteditable]')) {
    if (!isIgnoredChatSubtree(locked)) return false
  }
  return true
}

function readChatNode(node: Node, block: HTMLElement): string {
  if (node instanceof Element && isIgnoredChatSubtree(node)) return ''
  if (node instanceof Text) return node.data
  if (!(node instanceof Element)) return ''
  const meaningful: Node[] = []
  for (const child of node.childNodes) {
    if (child instanceof Element && isIgnoredChatSubtree(child)) continue
    if (child instanceof Text && child.data === '') continue
    meaningful.push(child)
  }
  if (node === block && meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement &&
    block.querySelector('.ProseMirror-trailingBreak') === null) return ''
  let text = ''
  for (const child of node.childNodes) {
    if (child instanceof Element && isIgnoredChatSubtree(child)) continue
    if (child instanceof Text) {
      text += child.data
    } else if (child instanceof HTMLBRElement) {
      text += '\n'
    } else if (child instanceof Element) {
      text += readChatNode(child, block)
    }
  }
  return text
}

function meaningfulChatChildren(node: Node): Node[] {
  const meaningful: Node[] = []
  for (const child of node.childNodes) {
    if (child instanceof Element && isIgnoredChatSubtree(child)) continue
    if (child instanceof Text && child.data === '') continue
    meaningful.push(child)
  }
  return meaningful
}

function readInlineChat(node: Node): string {
  let text = ''
  for (const child of node.childNodes) {
    if (child instanceof Element && isIgnoredChatSubtree(child)) continue
    if (child instanceof Text) text += child.data
    else if (child instanceof HTMLBRElement) text += '\n'
    else if (child instanceof Element) text += readInlineChat(child)
  }
  return text
}

function readLexicalBlock(block: HTMLElement): string {
  return readInlineChat(block)
}

function readQuillBlock(block: HTMLElement): string {
  const meaningful = meaningfulChatChildren(block)
  if (meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement) return ''
  return readInlineChat(block)
}

function readRoosterBlock(block: HTMLElement): string {
  const meaningful = meaningfulChatChildren(block)
  if (meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement) return ''
  let text = readInlineChat(block)
  const last = meaningful[meaningful.length - 1]
  if (last instanceof HTMLBRElement && text.endsWith('\n')) text = text.slice(0, -1)
  return text
}

function readJoinedChat(element: HTMLElement, readBlock: (block: HTMLElement) => string, separator: string): string {
  if (!flatChatBlocks(element)) return ''
  return directChatBlocks(element).map((block) => readBlock(block)).join(separator)
}

export function readChatDraft(element: HTMLElement): string {
  const kind = chatEditorKind(element)
  if (kind === 'lexical') return readJoinedChat(element, readLexicalBlock, '\n\n')
  if (kind === 'quill') return readJoinedChat(element, readQuillBlock, '\n')
  if (kind === 'rooster') return readJoinedChat(element, readRoosterBlock, '\n')
  if (kind === 'draft') {
    if (!validDraftChatBlocks(element)) return ''
    const blocks = draftChatBlocks(element)
    if (blocks.length > 0) return blocks.map((block) => readQuillBlock(block)).join('\n')
    return readJoinedChat(element, readQuillBlock, '\n')
  }
  if (kind === 'slate') {
    if (!validSlateChatBlocks(element)) return ''
    const blocks = slateChatBlocks(element)
    if (blocks.length > 0) return blocks.map((block) => readInlineChat(block)).join('\n')
    return readJoinedChat(element, readInlineChat, '\n')
  }
  const blocks = directChatBlocks(element)
  if (blocks.length === 0) return readChatNode(element, element)
  return blocks.map((block) => readChatNode(block, block)).join('\n')
}
