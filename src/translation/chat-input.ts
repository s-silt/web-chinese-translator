export type ChatReplacementStatus = 'ok' | 'changed' | 'unsupported' | 'failed'

export interface ChatReplacementRequest {
  readonly elementId: string
  readonly expectedText: string
  readonly text: string
}

const EXACT_CHAT_HOSTS = new Set([
  'chatgpt.com',
  'claude.ai',
  'web.telegram.org',
  'web.whatsapp.com',
  'teams.microsoft.com',
  'teams.live.com',
  'teams.cloud.microsoft',
])
const BLOCKED_CHAT_PATH = /(?:^|\/)(?:settings|api[-_]?keys?|secrets|passwords?|oauth|checkout|payments?|billing|accounts?|auth|sign-?in|sign-?up|log-?in|register)(?:\/|$)/i
const SLACK_CHAT_PATH = /^\/(?:client|messages)(?:\/|$)/
const ALLOWED_CHAT_TAGS = new Set(['DIV', 'P', 'SPAN', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S'])
const BLOCKED_CHAT_SELECTOR = 'img,svg,canvas,button,input,textarea,a,ul,ol,li,table,pre,code,.ProseMirror-widget,[data-node-view-wrapper],[data-decoration-id],[data-mention],[data-lexical-decorator],[data-lexical-mention]'

function isSlackChatHost(host: string): boolean {
  return host === 'app.slack.com' || host.endsWith('.slack.com')
}

function isTeamsChatHost(host: string): boolean {
  return host === 'teams.microsoft.com' || host === 'teams.live.com' || host === 'teams.cloud.microsoft'
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

export type ChatEditorKind = 'pm' | 'lexical' | 'quill' | 'rooster'

function pageHost(): string {
  try {
    return new URL(location.href).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function chatEditorKind(element: HTMLElement): ChatEditorKind | undefined {
  if (element.getAttribute('contenteditable') !== 'true') return undefined
  if (element.matches('.ProseMirror')) return 'pm'
  if (element.matches('[data-lexical-editor="true"]')) return 'lexical'
  if (element.matches('.ql-editor')) return 'quill'
  const host = pageHost()
  if (host === 'web.whatsapp.com') return 'lexical'
  if (isSlackChatHost(host)) return 'quill'
  if (isTeamsChatHost(host)) return 'rooster'
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

function isIgnoredChatSubtree(node: Element): boolean {
  if (isLexicalManagedBreak(node)) return true
  return node.classList.contains('ProseMirror-trailingBreak') ||
    node.classList.contains('ProseMirror-separator') ||
    node.classList.contains('ProseMirror-gapcursor') ||
    node.hasAttribute('data-slate-zero-width') ||
    node.hasAttribute('data-slate-placeholder') ||
    node.closest('[data-slate-zero-width],[data-slate-placeholder]') !== null
}

function directChatBlocks(element: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = []
  for (const child of element.children) {
    if (child instanceof HTMLElement && (child.tagName === 'P' || child.tagName === 'DIV')) blocks.push(child)
  }
  return blocks
}

function flatChatBlocks(element: HTMLElement): boolean {
  const blocks = directChatBlocks(element)
  if (blocks.length === 0 || blocks.length !== element.childElementCount) return false
  for (const block of blocks) {
    if (block.querySelector('p,div') !== null) return false
  }
  return true
}

export function isChatPlainEditor(element: Element): element is HTMLElement {
  if (!isChatEditorCandidate(element) || !element.isConnected) return false
  if (element.getAttribute('aria-readonly') === 'true' || element.getAttribute('aria-disabled') === 'true') return false
  if (element.hidden || element.inert || element.closest('[hidden],[inert],[aria-hidden="true"],[data-sensitive],[data-wt-root]') !== null) {
    return false
  }
  const style = element.style
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const kind = chatEditorKind(element)
  if (kind !== 'pm' && !flatChatBlocks(element)) return false
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
  const blocks = directChatBlocks(element)
  if (blocks.length === 0) return readChatNode(element, element)
  return blocks.map((block) => readChatNode(block, block)).join('\n')
}

export function replaceChatDraftInMainWorld(request: ChatReplacementRequest): ChatReplacementStatus {
  try {
    return commitChatReplacement(request)
  } catch {
    return 'failed'
  }

  function commitChatReplacement(input: ChatReplacementRequest): ChatReplacementStatus {
    if (typeof input !== 'object' || input === null) return 'failed'
    const elementId = input.elementId
    const expectedText = input.expectedText
    const text = input.text
    if (typeof elementId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(elementId)) {
      return 'failed'
    }
    if (typeof expectedText !== 'string' || typeof text !== 'string') return 'failed'
    if (expectedText.length < 1 || expectedText.length > 6000 || text.length < 1 || text.length > 6000) return 'failed'
    if (!chatUrl(location.href) || document.visibilityState === 'hidden') return 'failed'
    const matches = document.querySelectorAll(`[data-wt-chat-input="${elementId}"]`)
    if (matches.length !== 1) return 'failed'
    const element = matches[0]
    if (!(element instanceof HTMLElement) || !plainEditor(element)) return 'failed'
    if (draftText(element) !== expectedText) return 'changed'
    const view = findHandle(element)
    if (view === undefined) return 'unsupported'
    const before = readActual(view)
    if (before === undefined) return 'unsupported'
    if (before !== expectedText) return 'changed'
    const blocked = guardHandle(view)
    if (blocked !== undefined) return blocked
    try {
      element.focus({ preventScroll: true })
    } catch {
      return 'failed'
    }
    if (!element.isConnected || element.getAttribute('data-wt-chat-input') !== elementId || !plainEditor(element)) {
      return 'failed'
    }
    if (draftText(element) !== expectedText) return 'changed'
    const freshView = findHandle(element)
    if (freshView === undefined) return 'unsupported'
    const freshBlocked = guardHandle(freshView)
    if (freshBlocked !== undefined) return freshBlocked
    const fresh = readActual(freshView)
    if (fresh === undefined) return 'unsupported'
    if (fresh !== expectedText) return 'changed'
    const normalized = text.replace(/\r\n?/g, '\n')
    return writeHandle(freshView, normalized, expectedText)
  }

  function chatUrl(value: string): boolean {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:') return false
      const host = url.hostname.toLowerCase()
      const slack = host === 'app.slack.com' || host.endsWith('.slack.com')
      if (!slack && host !== 'chatgpt.com' && host !== 'claude.ai' && host !== 'web.telegram.org' &&
        host !== 'web.whatsapp.com' && host !== 'teams.microsoft.com' && host !== 'teams.live.com' &&
        host !== 'teams.cloud.microsoft') return false
      if (host === 'web.telegram.org' && !/^\/(?:a|k)(?:\/|$)/.test(url.pathname)) return false
      if (slack && !/^\/(?:client|messages)(?:\/|$)/.test(url.pathname)) return false
      return !/(?:^|\/)(?:settings|api[-_]?keys?|secrets|passwords?|oauth|checkout|payments?|billing|accounts?|auth|sign-?in|sign-?up|log-?in|register)(?:\/|$)/i.test(url.pathname)
    } catch {
      return false
    }
  }

  function managedBreak(node: Node): boolean {
    return node instanceof HTMLBRElement && node.getAttribute('data-lexical-managed-linebreak') === 'true'
  }

  function ignoredSubtree(node: Element): boolean {
    if (managedBreak(node)) return true
    return node.classList.contains('ProseMirror-trailingBreak') ||
      node.classList.contains('ProseMirror-separator') ||
      node.classList.contains('ProseMirror-gapcursor') ||
      node.hasAttribute('data-slate-zero-width') ||
      node.hasAttribute('data-slate-placeholder') ||
      node.closest('[data-slate-zero-width],[data-slate-placeholder]') !== null
  }

  function allowedMarkup(element: HTMLElement): boolean {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT)
    for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
      if (!(current instanceof Element) || ignoredSubtree(current)) continue
      const tag = current.tagName
      if (tag !== 'DIV' && tag !== 'P' && tag !== 'SPAN' && tag !== 'BR' && tag !== 'STRONG' && tag !== 'EM' &&
        tag !== 'B' && tag !== 'I' && tag !== 'U' && tag !== 'S') return false
    }
    return true
  }

  function blockedContent(element: HTMLElement): boolean {
    for (const node of element.querySelectorAll('img,svg,canvas,button,input,textarea,a,ul,ol,li,table,pre,code,.ProseMirror-widget,[data-node-view-wrapper],[data-decoration-id],[data-mention],[data-lexical-decorator],[data-lexical-mention]')) {
      if (!ignoredSubtree(node)) return true
    }
    return false
  }

  function mainKind(element: HTMLElement): 'pm' | 'lexical' | 'quill' | 'rooster' | undefined {
    if (element.getAttribute('contenteditable') !== 'true') return undefined
    if (element.matches('.ProseMirror')) return 'pm'
    if (element.matches('[data-lexical-editor="true"]')) return 'lexical'
    if (element.matches('.ql-editor')) return 'quill'
    let host: string
    try {
      host = new URL(location.href).hostname.toLowerCase()
    } catch {
      return undefined
    }
    if (host === 'web.whatsapp.com') return 'lexical'
    if (host === 'app.slack.com' || host.endsWith('.slack.com')) return 'quill'
    if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host === 'teams.cloud.microsoft') return 'rooster'
    return undefined
  }

  function mainBlocks(element: HTMLElement): HTMLElement[] {
    const blocks: HTMLElement[] = []
    for (const child of element.children) {
      if (child instanceof HTMLElement && (child.tagName === 'P' || child.tagName === 'DIV')) blocks.push(child)
    }
    return blocks
  }

  function mainFlat(element: HTMLElement): boolean {
    const blocks = mainBlocks(element)
    if (blocks.length === 0 || blocks.length !== element.childElementCount) return false
    for (const block of blocks) {
      if (block.querySelector('p,div') !== null) return false
    }
    return true
  }

  function plainEditor(element: HTMLElement): boolean {
    const kind = mainKind(element)
    if (kind === undefined || !element.isConnected) return false
    if (element.getAttribute('aria-readonly') === 'true' || element.getAttribute('aria-disabled') === 'true') return false
    if (element.hidden || element.inert || element.closest('[hidden],[inert],[aria-hidden="true"],[data-sensitive],[data-wt-root]') !== null) {
      return false
    }
    const style = element.style
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (kind !== 'pm' && !mainFlat(element)) return false
    if (!allowedMarkup(element)) return false
    if (blockedContent(element)) return false
    for (const locked of element.querySelectorAll('[contenteditable]')) {
      if (!ignoredSubtree(locked)) return false
    }
    return !sensitiveField(element)
  }

  function labelText(element: HTMLElement): string {
    const parts: string[] = []
    const push = (value: string | null | undefined): void => {
      if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim())
    }
    push(element.getAttribute('name'))
    push(element.getAttribute('id'))
    push(element.getAttribute('placeholder'))
    push(element.getAttribute('aria-label'))
    push(element.getAttribute('title'))
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy !== null && labelledBy.trim() !== '') {
      for (const id of labelledBy.trim().split(/\s+/)) push(element.ownerDocument.getElementById(id)?.textContent)
    }
    const parentLabel = element.closest('label')
    if (parentLabel !== null) push(parentLabel.textContent)
    return parts.join(' ')
  }

  function sensitiveField(element: HTMLElement): boolean {
    const autoComplete = (element.getAttribute('autocomplete') ?? '').trim().toLowerCase()
    if (autoComplete !== '' && autoComplete.split(/\s+/).some((token) => /^(?:username|current-password|new-password|one-time-code|cc-[a-z-]+)$/i.test(token))) {
      return true
    }
    const metadata = labelText(element)
    if (metadata !== '' && /(?:pass(?:word|code|phrase)?|pwd|token|secret|api[-_\s]?key|private[-_\s]?key|access[-_\s]?key|auth(?:entication)?[-_\s]?(?:code|key|token)?|otp|totp|2fa|mfa|verif(?:y|ication)[-_\s]?code|security[-_\s]?code|card[-_\s]?(?:number|no|num)|credit[-_\s]?card|debit[-_\s]?card|cvv|cvc|csc|pin(?:\b|[-_\s]?code)|ssn|tax[-_\s]?id|bank[-_\s]?account|routing[-_\s]?number|iban|swift|mnemonic|seed[-_\s]?phrase|密码|口令|密钥|秘钥|私钥|令牌|验证码|动态码|安全码|校验码|银行卡|信用卡|卡号|身份证|社保|支付密码|助记词|パスワード|暗証番号|トークン|シークレット|秘密鍵|APIキー|認証コード|確認コード|ワンタイム|セキュリティコード|カード番号|クレジットカード|口座番号)/i.test(metadata)) {
      return true
    }
    const form = element.closest('form')
    if (form === null) return false
    if (form.querySelector('input[type="password" i]') !== null) return true
    const formMeta = [form.getAttribute('name'), form.getAttribute('id'), form.getAttribute('action'), form.getAttribute('aria-label')]
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .join(' ')
    return formMeta !== '' && /(?:pass(?:word|code|phrase)?|pwd|token|secret|api[-_\s]?key|private[-_\s]?key|密码|口令|密钥|验证码|パスワード|暗証番号)/i.test(formMeta)
  }

  function readNode(node: Node, block: HTMLElement): string {
    if (node instanceof Element && ignoredSubtree(node)) return ''
    if (!(node instanceof Element)) return ''
    const meaningful: Node[] = []
    for (const child of node.childNodes) {
      if (child instanceof Element && ignoredSubtree(child)) continue
      if (child instanceof Text && child.data === '') continue
      meaningful.push(child)
    }
    if (node === block && meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement &&
      block.querySelector('.ProseMirror-trailingBreak') === null) return ''
    let text = ''
    for (const child of node.childNodes) {
      if (child instanceof Element && ignoredSubtree(child)) continue
      if (child instanceof Text) text += child.data
      else if (child instanceof HTMLBRElement) text += '\n'
      else if (child instanceof Element) text += readNode(child, block)
    }
    return text
  }

  function mainMeaningful(node: Node): Node[] {
    const meaningful: Node[] = []
    for (const child of node.childNodes) {
      if (child instanceof Element && ignoredSubtree(child)) continue
      if (child instanceof Text && child.data === '') continue
      meaningful.push(child)
    }
    return meaningful
  }

  function mainInline(node: Node): string {
    let text = ''
    for (const child of node.childNodes) {
      if (child instanceof Element && ignoredSubtree(child)) continue
      if (child instanceof Text) text += child.data
      else if (child instanceof HTMLBRElement) text += '\n'
      else if (child instanceof Element) text += mainInline(child)
    }
    return text
  }

  function mainQuillBlock(block: HTMLElement): string {
    const meaningful = mainMeaningful(block)
    if (meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement) return ''
    return mainInline(block)
  }

  function mainRoosterBlock(block: HTMLElement): string {
    const meaningful = mainMeaningful(block)
    if (meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement) return ''
    let text = mainInline(block)
    const last = meaningful[meaningful.length - 1]
    if (last instanceof HTMLBRElement && text.endsWith('\n')) text = text.slice(0, -1)
    return text
  }

  function draftText(element: HTMLElement): string {
    const kind = mainKind(element)
    if (kind === 'lexical' || kind === 'quill' || kind === 'rooster') {
      if (!mainFlat(element)) return ''
      const separator = kind === 'lexical' ? '\n\n' : '\n'
      const readBlock = kind === 'quill' ? mainQuillBlock : kind === 'rooster' ? mainRoosterBlock : mainInline
      return mainBlocks(element).map((block) => readBlock(block)).join(separator)
    }
    const blocks = mainBlocks(element)
    if (blocks.length === 0) return readNode(element, element)
    return blocks.map((block) => readNode(block, block)).join('\n')
  }

  function isDataRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function isPlainDoc(doc: PmDoc): boolean {
    if (typeof doc.descendants !== 'function') return false
    let nodes = 0
    let ok = true
    doc.descendants((node) => {
      nodes += 1
      if (nodes > 12000 || !withinDepth(node, 0)) {
        ok = false
        return false
      }
      const name = node.type?.name
      if (name !== 'doc' && name !== 'paragraph' && name !== 'text' && name !== 'hard_break' && name !== 'hardBreak') {
        ok = false
        return false
      }
      return name === 'doc' || name === 'paragraph'
    })
    return ok && withinDepth(doc, 0)
  }

  function withinDepth(node: PmNode, depth: number): boolean {
    if (depth > 32) return false
    const content = node.content
    if (content === undefined || typeof content.forEach !== 'function') return true
    let ok = true
    content.forEach((child) => {
      if (!withinDepth(child, depth + 1)) ok = false
    })
    return ok
  }

  function canonicalText(doc: PmDoc): string | undefined {
    const size = doc.content?.size
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > 12000) return undefined
    if (typeof doc.textBetween !== 'function' || !isPlainDoc(doc)) return undefined
    const text = doc.textBetween(0, size, '\n', '\n')
    if (typeof text !== 'string' || text.length > 6000) return undefined
    return text
  }

  function readLexicalJson(json: unknown): string | undefined {
    if (!isDataRecord(json)) return undefined
    const root = json.root
    if (!isDataRecord(root) || root.type !== 'root' || !Array.isArray(root.children)) return undefined
    const state = { nodes: 1, chars: 0 }
    const parts: string[] = []
    for (const child of root.children) {
      state.nodes += 1
      if (state.nodes > 12000) return undefined
      if (!isDataRecord(child) || child.type !== 'paragraph' || !Array.isArray(child.children)) return undefined
      const text = readLexicalInline(child.children, 2, state)
      if (text === undefined) return undefined
      parts.push(text)
    }
    const joined = parts.join('\n\n')
    if (joined.length > 6000 || state.chars > 6000) return undefined
    return joined
  }

  function readLexicalInline(children: readonly unknown[], depth: number, state: { nodes: number; chars: number }): string | undefined {
    if (depth > 32) return undefined
    let text = ''
    for (const child of children) {
      state.nodes += 1
      if (state.nodes > 12000) return undefined
      if (!isDataRecord(child)) return undefined
      if (child.type === 'linebreak') {
        text += '\n'
        continue
      }
      if (child.type !== 'text' || typeof child.text !== 'string' || child.text.length > 6000) return undefined
      if (child.mode !== undefined && child.mode !== 'normal') return undefined
      text += child.text
      state.chars += child.text.length
      if (state.chars > 6000) return undefined
    }
    return text
  }

  function readLexicalNodeMap(nodeMap: Map<unknown, unknown>): string | undefined {
    const root = nodeMap.get('root')
    if (!isDataRecord(root) || root.__type !== 'root') return undefined
    const seen = new Set<string>(['root'])
    let nodes = 1
    let chars = 0
    const parts: string[] = []
    let blockKey: unknown = root.__first
    while (blockKey !== null) {
      if (typeof blockKey !== 'string' || seen.has(blockKey)) return undefined
      seen.add(blockKey)
      nodes += 1
      if (nodes > 12000) return undefined
      const block = nodeMap.get(blockKey)
      if (!isDataRecord(block) || (block.__type !== 'paragraph' && block.__type !== 'bidi-paragraph')) {
        return undefined
      }
      let text = ''
      let childKey: unknown = block.__first
      while (childKey !== null) {
        if (typeof childKey !== 'string' || seen.has(childKey)) return undefined
        seen.add(childKey)
        nodes += 1
        if (nodes > 12000) return undefined
        const child = nodeMap.get(childKey)
        if (!isDataRecord(child)) return undefined
        if (child.__type === 'linebreak') {
          text += '\n'
        } else if (
          child.__type === 'text' &&
          child.__mode === 0 &&
          typeof child.__text === 'string' &&
          child.__text.length <= 6000
        ) {
          text += child.__text
          chars += child.__text.length
          if (chars > 6000) return undefined
        } else {
          return undefined
        }
        childKey = child.__next
      }
      parts.push(text)
      blockKey = block.__next
    }
    const joined = parts.join('\n\n')
    if (joined.length > 6000 || chars > 6000) return undefined
    return joined
  }

  function readLexicalState(editor: LexicalEditorHandle): string | undefined {
    try {
      const editorState = editor.getEditorState()
      if (!isDataRecord(editorState)) return undefined
      if (editorState._nodeMap instanceof Map) {
        return readLexicalNodeMap(editorState._nodeMap)
      }
      if (typeof editorState.toJSON !== 'function') return undefined
      return readLexicalJson(editorState.toJSON())
    } catch {
      return undefined
    }
  }

  function readQuillModel(editor: QuillEditorHandle): string | undefined {
    const contents = editor.getContents()
    if (!isDataRecord(contents) || !Array.isArray(contents.ops) || contents.ops.length > 12000) return undefined
    let concat = ''
    for (const op of contents.ops) {
      if (!isDataRecord(op) || typeof op.insert !== 'string') return undefined
      if (op.attributes !== undefined && (!isDataRecord(op.attributes) || Object.keys(op.attributes).length > 0)) return undefined
      concat += op.insert
      if (concat.length > 6001) return undefined
    }
    const live = editor.getText()
    if (typeof live !== 'string' || live.length > 6001 || !live.endsWith('\n') || live !== concat) return undefined
    return live.slice(0, -1)
  }

  function roosterTextUnsafe(segment: Record<string, unknown>): boolean {
    if ('link' in segment || 'code' in segment || 'decorator' in segment || 'entity' in segment || 'data' in segment || 'dataset' in segment || 'mention' in segment) {
      return true
    }
    const format = segment.format
    if (format === undefined) return false
    if (!isDataRecord(format)) return true
    return Object.keys(format).some((key) => /link|code|decorator|entity|mention|href/i.test(key))
  }

  function readRoosterModel(model: unknown): string | undefined {
    if (!isDataRecord(model) || model.blockGroupType !== 'Document' || !Array.isArray(model.blocks)) return undefined
    if (model.blocks.length > 12000) return undefined
    const lines: string[] = []
    let nodes = 1
    let chars = 0
    for (const block of model.blocks) {
      nodes += 1
      if (nodes > 12000) return undefined
      if (!isDataRecord(block) || block.blockType !== 'Paragraph' || !Array.isArray(block.segments)) return undefined
      let line = ''
      for (const segment of block.segments) {
        nodes += 1
        if (nodes > 12000) return undefined
        if (!isDataRecord(segment)) return undefined
        if (segment.segmentType === 'SelectionMarker') continue
        if (segment.segmentType === 'Br') {
          lines.push(line)
          line = ''
          continue
        }
        if (segment.segmentType !== 'Text' || typeof segment.text !== 'string' || segment.text.length > 6000 || roosterTextUnsafe(segment)) {
          return undefined
        }
        line += segment.text
        chars += segment.text.length
        if (chars > 6000) return undefined
      }
      if (line !== '') lines.push(line)
    }
    const text = lines.join('\n')
    if (text.length > 6000) return undefined
    return text
  }

  function readActual(view: ChatEditorHandle): string | undefined {
    try {
      if (view.kind === 'pm') return canonicalText(view.value.state.doc)
      if (view.kind === 'lexical') return readLexicalState(view.value)
      if (view.kind === 'quill') return readQuillModel(view.value)
      return readRoosterModel(view.value.getContentModelCopy('clean'))
    } catch {
      return undefined
    }
  }

  function guardHandle(view: ChatEditorHandle): ChatReplacementStatus | undefined {
    try {
      if (view.kind === 'pm') {
        if (view.value.composing === true || view.value.editable === false) return 'failed'
        return undefined
      }
      if (view.kind === 'lexical') {
        if (view.value.isEditable() !== true || view.value.isComposing() === true) return 'failed'
        return undefined
      }
      if (view.kind === 'quill') {
        if (view.value.isEnabled() !== true) return 'failed'
        return undefined
      }
      if (view.value.isDisposed() === true) return 'failed'
      return undefined
    } catch {
      return 'failed'
    }
  }

  function writeModel(view: EditorViewHandle, normalized: string): string | undefined {
    const schema = view.state.schema
    const lines = normalized.split('\n')
    const paragraphType = schema.nodes?.paragraph
    const hardBreak = schema.nodes?.hard_break ?? schema.nodes?.hardBreak
    if (paragraphType === undefined || typeof paragraphType.create !== 'function' || typeof schema.text !== 'function') {
      return undefined
    }
    if (lines.length > 1 && (hardBreak === undefined || typeof hardBreak.create !== 'function')) return undefined
    const inline: unknown[] = []
    for (let index = 0; index < lines.length; index += 1) {
      if (index > 0) {
        if (hardBreak === undefined || typeof hardBreak.create !== 'function') return undefined
        inline.push(hardBreak.create())
      }
      const line = lines[index] ?? ''
      if (line !== '') inline.push(schema.text(line))
    }
    const paragraph = paragraphType.create(null, inline)
    const transactionHost = view.state.tr
    if (transactionHost === undefined || typeof transactionHost.replaceWith !== 'function' || typeof view.dispatch !== 'function') {
      return undefined
    }
    const size = view.state.doc.content?.size
    if (typeof size !== 'number') return undefined
    const transaction = transactionHost.replaceWith(0, size, paragraph)
    view.dispatch(transaction)
    const next = view.state.doc
    const nextSize = next.content?.size
    if (typeof nextSize !== 'number' || typeof next.textBetween !== 'function' || !isPlainDoc(next)) return undefined
    const written = next.textBetween(0, nextSize, '\n', '\n')
    return typeof written === 'string' ? written : undefined
  }

  function writeLexical(editor: LexicalEditorHandle, normalized: string): string | undefined {
    const children: unknown[] = []
    normalized.split('\n').forEach((line, index) => {
      if (index > 0) children.push({ type: 'linebreak', version: 1 })
      if (line !== '') children.push({ type: 'text', version: 1, text: line, detail: 0, format: 0, mode: 'normal', style: '' })
    })
    const paragraph = { type: 'paragraph', version: 1, children, direction: null, format: '', indent: 0, textFormat: 0, textStyle: '' }
    const serialized = { root: { type: 'root', version: 1, children: [paragraph], direction: null, format: '', indent: 0 } }
    const next = editor.parseEditorState(JSON.stringify(serialized))
    editor.setEditorState(next, { tag: 'history-push' })
    editor.focus?.(undefined, { defaultSelection: 'rootEnd' })
    return readLexicalState(editor)
  }

  function writeQuill(editor: QuillEditorHandle, normalized: string): string | undefined {
    editor.setText(normalized + '\n', 'user')
    editor.setSelection?.(normalized.length, 0, 'silent')
    return readQuillModel(editor)
  }

  function writeRooster(editor: RoosterEditorHandle, normalized: string, expectedText: string): ChatReplacementStatus {
    const blocks: RoosterWriteBlock[] = normalized.split('\n').map((line) => ({
      blockType: 'Paragraph',
      format: {},
      segments: line === ''
        ? [{ segmentType: 'Br', format: {} }]
        : [{ segmentType: 'Text', text: line, format: {} }],
    }))
    blocks[blocks.length - 1]!.segments.push({ segmentType: 'SelectionMarker', isSelected: true, format: {} })
    const outcome: { status: ChatReplacementStatus } = { status: 'failed' }
    editor.formatContentModel((model) => {
      const live = readRoosterModel(model)
      if (live === undefined) {
        outcome.status = 'unsupported'
        return false
      }
      if (live !== expectedText) {
        outcome.status = 'changed'
        return false
      }
      model.blocks = blocks
      outcome.status = 'ok'
      return true
    }, { apiName: 'inputTranslation', changeSource: 'inputTranslation' })
    if (outcome.status !== 'ok') return outcome.status
    const verified = readRoosterModel(editor.getContentModelCopy('clean'))
    return verified === normalized ? 'ok' : 'failed'
  }

  function writeHandle(view: ChatEditorHandle, normalized: string, expectedText: string): ChatReplacementStatus {
    try {
      if (view.kind === 'rooster') return writeRooster(view.value, normalized, expectedText)
      const written = view.kind === 'pm'
        ? writeModel(view.value, normalized)
        : view.kind === 'lexical'
          ? writeLexical(view.value, normalized)
          : writeQuill(view.value, normalized)
      if (written === undefined) return 'unsupported'
      return written === normalized ? 'ok' : 'failed'
    } catch {
      return 'failed'
    }
  }

  function acceptView(value: unknown, root: HTMLElement): EditorViewHandle | undefined {
    if (!isDataRecord(value) || value.dom !== root) return undefined
    const state = value.state
    if (!isDataRecord(state) || !isDataRecord(state.schema) || !isDataRecord(state.doc)) return undefined
    if (!isDataRecord(state.tr) || typeof value.dispatch !== 'function') return undefined
    if (typeof state.doc.textBetween !== 'function') return undefined
    return value as unknown as EditorViewHandle
  }

  function acceptLexical(value: unknown, root: HTMLElement): LexicalEditorHandle | undefined {
    if (!isDataRecord(value)) return undefined
    if (typeof value.getRootElement !== 'function' || typeof value.getEditorState !== 'function' ||
      typeof value.parseEditorState !== 'function' || typeof value.setEditorState !== 'function' ||
      typeof value.isEditable !== 'function' || typeof value.isComposing !== 'function') return undefined
    try {
      if (value.getRootElement() !== root) return undefined
    } catch {
      return undefined
    }
    return value as unknown as LexicalEditorHandle
  }

  function acceptQuill(value: unknown, root: HTMLElement): QuillEditorHandle | undefined {
    if (!isDataRecord(value)) return undefined
    if (typeof value.getContents !== 'function' || typeof value.getText !== 'function' ||
      typeof value.setText !== 'function' || typeof value.isEnabled !== 'function') return undefined
    try {
      if (value.root !== root) return undefined
    } catch {
      return undefined
    }
    return value as unknown as QuillEditorHandle
  }

  function acceptRooster(value: unknown, root: HTMLElement): RoosterEditorHandle | undefined {
    if (!isDataRecord(value)) return undefined
    if (typeof value.getCore !== 'function' || typeof value.getContentModelCopy !== 'function' ||
      typeof value.formatContentModel !== 'function' || typeof value.isDisposed !== 'function') return undefined
    try {
      const core = value.getCore()
      if (!isDataRecord(core) || core.physicalRoot !== root) return undefined
    } catch {
      return undefined
    }
    return value as unknown as RoosterEditorHandle
  }

  function acceptHandle(value: unknown, root: HTMLElement): ChatEditorHandle | undefined {
    const view = acceptView(value, root)
    if (view !== undefined) return { kind: 'pm', value: view }
    const lexical = acceptLexical(value, root)
    if (lexical !== undefined) return { kind: 'lexical', value: lexical }
    const quill = acceptQuill(value, root)
    if (quill !== undefined) return { kind: 'quill', value: quill }
    const rooster = acceptRooster(value, root)
    if (rooster !== undefined) return { kind: 'rooster', value: rooster }
    return undefined
  }

  function considerCandidate(value: unknown, root: HTMLElement, seen: Set<unknown>, depth: number): ChatEditorHandle | undefined {
    if (depth > 16 || typeof value !== 'object' || value === null || seen.has(value)) return undefined
    seen.add(value)
    const direct = acceptHandle(value, root)
    if (direct !== undefined) return direct
    if (Array.isArray(value)) return value.length > 0 ? considerCandidate(value[0], root, seen, depth + 1) : undefined
    if (!isDataRecord(value)) return undefined
    for (const key of ['view', 'editor', 'current', 'quill', '_editor'] as const) {
      if (key in value) {
        const nested = considerCandidate(value[key], root, seen, depth + 1)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  function holderOn(record: Record<string, unknown>, root: HTMLElement, seen: Set<unknown>): ChatEditorHandle | undefined {
    for (const key of ['editor', 'view', 'quill', '_editor'] as const) {
      if (key in record) {
        const nested = considerCandidate(record[key], root, seen, 0)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  function editorOnFiber(fiber: unknown, root: HTMLElement): ChatEditorHandle | undefined {
    if (!isDataRecord(fiber)) return undefined
    const seen = new Set<unknown>()
    try {
      const props = fiber.memoizedProps
      if (isDataRecord(props)) {
        const fromProps = holderOn(props, root, seen)
        if (fromProps !== undefined) return fromProps
      }
      const stateNode = fiber.stateNode
      if (isDataRecord(stateNode)) {
        const fromNode = holderOn(stateNode, root, seen)
        if (fromNode !== undefined) return fromNode
      }
      let hook: unknown = fiber.memoizedState
      const seenHooks = new Set<unknown>()
      for (let count = 0; count < 80 && isDataRecord(hook); count += 1) {
        if (seenHooks.has(hook)) break
        seenHooks.add(hook)
        const fromHook = considerCandidate(hook.memoizedState, root, seen, 0)
        if (fromHook !== undefined) return fromHook
        hook = hook.next
      }
      const dependencies = fiber.dependencies
      if (!isDataRecord(dependencies)) return undefined
      let context: unknown = dependencies.firstContext
      const seenContexts = new Set<unknown>()
      for (let count = 0; count < 30 && isDataRecord(context); count += 1) {
        if (seenContexts.has(context)) break
        seenContexts.add(context)
        if (isDataRecord(context.memoizedValue)) {
          const fromContext = holderOn(context.memoizedValue, root, seen)
          if (fromContext !== undefined) return fromContext
        }
        const directContext = considerCandidate(context.memoizedValue, root, seen, 0)
        if (directContext !== undefined) return directContext
        context = context.next
      }
    } catch {
      return undefined
    }
    return undefined
  }

  function fiberKey(node: Element): string | undefined {
    return Object.keys(node).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'))
  }

  function findHandle(element: HTMLElement): ChatEditorHandle | undefined {
    try {
      const bound = (element as unknown as { editor?: unknown }).editor
      const fromBinding = considerCandidate(bound, element, new Set(), 0)
      if (fromBinding !== undefined) return fromBinding
      const lexicalBinding = (element as unknown as { __lexicalEditor?: unknown }).__lexicalEditor
      const fromLexical = considerCandidate(lexicalBinding, element, new Set(), 0)
      if (fromLexical !== undefined) return fromLexical
      const parentQuill = (element.parentElement as (HTMLElement & { __quill?: unknown }) | null)?.__quill
      const fromQuill = considerCandidate(parentQuill, element, new Set(), 0)
      if (fromQuill !== undefined) return fromQuill
      if (element.matches('.ql-editor')) {
        try {
          const quillGlobal = (window as unknown as { Quill?: { find?: (container: Element, bubble: boolean) => unknown } }).Quill
          const container = element.closest('.ql-container')
          if (container !== null && typeof quillGlobal?.find === 'function') {
            const fromFind = considerCandidate(quillGlobal.find(container, true), element, new Set(), 0)
            if (fromFind !== undefined) return fromFind
          }
        } catch { void 0 }
      }
      let host: Element | null = element
      for (let hop = 0; hop <= 6 && host !== null; hop += 1) {
        const key = fiberKey(host)
        if (key !== undefined) {
          let fiber: unknown = (host as unknown as Record<string, unknown>)[key]
          const seenFibers = new Set<unknown>()
          for (let depth = 0; depth < 80 && typeof fiber === 'object' && fiber !== null; depth += 1) {
            if (seenFibers.has(fiber)) break
            seenFibers.add(fiber)
            const view = editorOnFiber(fiber, element)
            if (view !== undefined) return view
            fiber = isDataRecord(fiber) ? fiber.return : undefined
          }
          return undefined
        }
        host = host.parentElement
      }
    } catch {
      return undefined
    }
    return undefined
  }
}

interface PmNode {
  readonly type?: { readonly name?: string }
  readonly content?: { forEach(callback: (child: PmNode) => void): void }
}

interface PmDoc extends PmNode {
  readonly content?: { readonly size?: number; forEach(callback: (child: PmNode) => void): void }
  textBetween?(from: number, to: number, blockSeparator: string, leafText: string): string
  descendants?(callback: (node: PmNode) => boolean | void): void
}

interface EditorViewHandle {
  readonly dom: HTMLElement
  readonly editable?: boolean
  readonly composing?: boolean
  readonly state: {
    readonly schema: {
      text?: (value: string) => unknown
      readonly nodes?: {
        readonly paragraph?: { create(attrs: null, content: readonly unknown[]): unknown }
        readonly hard_break?: { create(): unknown }
        readonly hardBreak?: { create(): unknown }
      }
    }
    readonly doc: PmDoc
    readonly tr?: { replaceWith(from: number, to: number, content: unknown): unknown }
  }
  dispatch(transaction: unknown): void
}

interface LexicalEditorHandle {
  getRootElement(): HTMLElement | null
  getEditorState(): { readonly _nodeMap?: unknown; toJSON?(): unknown }
  parseEditorState(state: string): unknown
  setEditorState(state: unknown, options?: { tag?: string }): void
  isEditable(): boolean
  isComposing(): boolean
  focus?(callback?: undefined, options?: { defaultSelection?: 'rootEnd' }): void
}

interface QuillEditorHandle {
  readonly root: HTMLElement
  getContents(): unknown
  getText(): string
  setText(text: string, source: 'user'): void
  isEnabled(): boolean
  setSelection?(index: number, length: number, source: 'silent'): void
}

interface RoosterTextSegment {
  segmentType: 'Text'
  text: string
  format: Record<string, never>
}

interface RoosterBrSegment {
  segmentType: 'Br'
  format: Record<string, never>
}

interface RoosterSelectionSegment {
  segmentType: 'SelectionMarker'
  isSelected: true
  format: Record<string, never>
}

type RoosterWriteSegment = RoosterTextSegment | RoosterBrSegment | RoosterSelectionSegment

interface RoosterWriteBlock {
  blockType: 'Paragraph'
  format: Record<string, never>
  segments: RoosterWriteSegment[]
}

interface RoosterEditorHandle {
  getCore(): { physicalRoot?: unknown; logicalRoot?: unknown }
  getContentModelCopy(mode: 'clean'): unknown
  formatContentModel(
    formatter: (model: { blocks: RoosterWriteBlock[] }) => boolean,
    options: { apiName: string; changeSource: string },
  ): void
  isDisposed(): boolean
}

type ChatEditorHandle =
  | { kind: 'pm'; value: EditorViewHandle }
  | { kind: 'lexical'; value: LexicalEditorHandle }
  | { kind: 'quill'; value: QuillEditorHandle }
  | { kind: 'rooster'; value: RoosterEditorHandle }
