export type DiscordReplacementStatus = 'ok' | 'changed' | 'unsupported' | 'failed'

export interface DiscordReplacementRequest {
  readonly elementId: string
  readonly expectedText: string
  readonly text: string
}

const DISCORD_HOSTS = new Set(['discord.com', 'canary.discord.com', 'ptb.discord.com'])
const SLATE_ROOT_SELECTOR = '[data-slate-editor="true"][contenteditable="true"][role="textbox"]'
const NESTED_BLOCK_SELECTOR = '[data-slate-node="element"] [data-slate-node="element"]'
const ALLOWED_DISCORD_TAGS = new Set(['DIV', 'P', 'SPAN', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S'])

export function isDiscordChatUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    return DISCORD_HOSTS.has(url.hostname.toLowerCase()) && url.pathname.startsWith('/channels/')
  } catch {
    return false
  }
}

function isAllowedDiscordMarkup(element: HTMLElement): boolean {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT)
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    if (!(current instanceof Element) || !ALLOWED_DISCORD_TAGS.has(current.tagName)) return false
  }
  return true
}

function isHarmlessLockedDescendant(node: Element): boolean {
  return node.hasAttribute('data-slate-zero-width') || node.hasAttribute('data-slate-placeholder') ||
    node.closest('[data-slate-zero-width]') !== null
}

export function isDiscordPlainEditor(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (!isDiscordChatUrl(location.href)) return false
  if (!element.matches(SLATE_ROOT_SELECTOR) || !element.isConnected) return false
  if (element.getAttribute('aria-readonly') === 'true' || element.getAttribute('aria-disabled') === 'true') return false
  if (element.hidden || element.inert || element.closest('[hidden],[inert],[aria-hidden="true"],[data-sensitive]') !== null) {
    return false
  }
  if (!isAllowedDiscordMarkup(element)) return false
  if (element.querySelector('[data-slate-void="true"],img,svg,canvas,button,input,textarea,a') !== null) return false
  if (element.querySelector(NESTED_BLOCK_SELECTOR) !== null) return false
  for (const locked of element.querySelectorAll('[contenteditable="false"]')) {
    if (!isHarmlessLockedDescendant(locked)) return false
  }
  return true
}

function readDiscordNode(node: Node): string {
  if (node instanceof Element && (node.hasAttribute('data-slate-zero-width') || node.hasAttribute('data-slate-placeholder'))) return ''
  if (node instanceof Text) return node.data
  if (node instanceof Element && node.tagName === 'BR') return '\n'
  let text = ''
  for (const child of node.childNodes) text += readDiscordNode(child)
  return text
}

export function readDiscordDraft(element: HTMLElement): string {
  const blocks: Element[] = []
  for (const child of element.children) {
    if (child.getAttribute('data-slate-node') === 'element') blocks.push(child)
  }
  if (blocks.length === 0) return readDiscordNode(element)
  return blocks.map((block) => readDiscordNode(block)).join('\n')
}

export function replaceDiscordDraftInMainWorld(request: DiscordReplacementRequest): DiscordReplacementStatus {
  try {
    return commitDiscordReplacement(request)
  } catch {
    return 'failed'
  }

  function commitDiscordReplacement(input: DiscordReplacementRequest): DiscordReplacementStatus {
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
    const matches = document.querySelectorAll(`[data-wt-discord-input="${elementId}"]`)
    if (matches.length !== 1) return 'failed'
    const element = matches[0]
    if (!(element instanceof HTMLElement) || !plainEditor(element)) return 'failed'
    if (draftText(element) !== expectedText) return 'changed'
    const editor = findEditor(element, expectedText)
    if (editor === undefined) return 'unsupported'
    try {
      element.focus({ preventScroll: true })
    } catch {
      return 'failed'
    }
    if (!element.isConnected || element.getAttribute('data-wt-discord-input') !== elementId || !plainEditor(element)) {
      return 'failed'
    }
    if (draftText(element) !== expectedText) return 'changed'
    const fresh = readEditorModel(editor.children)
    if (fresh === undefined) return 'unsupported'
    if (fresh.text !== expectedText) return 'changed'
    const normalized = text.replace(/\r\n?/g, '\n')
    editor.apply({
      type: 'set_selection',
      properties: editor.selection,
      newProperties: {
        anchor: { path: fresh.firstPath.slice(), offset: 0 },
        focus: { path: fresh.lastPath.slice(), offset: fresh.lastText.length },
      },
    })
    editor.insertText(normalized)
    const written = readEditorModel(editor.children)
    return written !== undefined && written.text === normalized ? 'ok' : 'failed'
  }

  function chatUrl(value: string): boolean {
    try {
      const url = new URL(value)
      const host = url.hostname.toLowerCase()
      return url.protocol === 'https:' &&
        (host === 'discord.com' || host === 'canary.discord.com' || host === 'ptb.discord.com') &&
        url.pathname.startsWith('/channels/')
    } catch {
      return false
    }
  }

  function allowedMarkup(element: HTMLElement): boolean {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT)
    for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
      if (!(current instanceof Element)) continue
      const tag = current.tagName
      if (tag !== 'DIV' && tag !== 'P' && tag !== 'SPAN' && tag !== 'BR' && tag !== 'STRONG' && tag !== 'EM' &&
        tag !== 'B' && tag !== 'I' && tag !== 'U' && tag !== 'S') return false
    }
    return true
  }

  function harmlessLock(node: Element): boolean {
    return node.hasAttribute('data-slate-zero-width') || node.hasAttribute('data-slate-placeholder') ||
      node.closest('[data-slate-zero-width]') !== null
  }

  function plainEditor(element: HTMLElement): boolean {
    if (!element.matches('[data-slate-editor="true"][contenteditable="true"][role="textbox"]') || !element.isConnected) {
      return false
    }
    if (element.getAttribute('aria-readonly') === 'true' || element.getAttribute('aria-disabled') === 'true') return false
    if (element.hidden || element.inert || element.closest('[hidden],[inert],[aria-hidden="true"],[data-sensitive],[data-wt-root]') !== null) {
      return false
    }
    const style = element.style
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (!allowedMarkup(element)) return false
    if (element.querySelector('[data-slate-void="true"],img,svg,canvas,button,input,textarea,a') !== null) return false
    if (element.querySelector('[data-slate-node="element"] [data-slate-node="element"]') !== null) return false
    for (const locked of element.querySelectorAll('[contenteditable="false"]')) {
      if (!harmlessLock(locked)) return false
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

  function draftText(element: HTMLElement): string {
    const readNode = (node: Node): string => {
      if (node instanceof Element && (node.hasAttribute('data-slate-zero-width') || node.hasAttribute('data-slate-placeholder'))) return ''
      if (node instanceof Text) return node.data
      if (node instanceof Element && node.tagName === 'BR') return '\n'
      let text = ''
      for (const child of node.childNodes) text += readNode(child)
      return text
    }
    const blocks: Element[] = []
    for (const child of element.children) {
      if (child.getAttribute('data-slate-node') === 'element') blocks.push(child)
    }
    if (blocks.length === 0) return readNode(element)
    return blocks.map((block) => readNode(block)).join('\n')
  }

  function isDataRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function readEditorModel(children: unknown): ModelRead | undefined {
    if (!Array.isArray(children) || children.length === 0 || children.length > 12000) return undefined
    const state = { nodes: 0, chars: 0 }
    const leaves: LeafHit[] = []
    const parts: string[] = []
    for (let index = 0; index < children.length; index += 1) {
      const blockLeaves: LeafHit[] = []
      if (!walkNode(children[index], [index], 0, state, blockLeaves)) return undefined
      let block = ''
      for (const leaf of blockLeaves) {
        block += leaf.text
        leaves.push(leaf)
      }
      parts.push(block)
    }
    const text = parts.join('\n')
    const first = leaves[0]
    const last = leaves[leaves.length - 1]
    if (first === undefined || last === undefined || text.length > 6000) return undefined
    return { text, firstPath: first.path.slice(), lastPath: last.path.slice(), lastText: last.text }
  }

  function walkNode(node: unknown, path: number[], depth: number, state: WalkState, leaves: LeafHit[]): boolean {
    if (state.nodes >= 12000 || depth > 32) return false
    state.nodes += 1
    if (typeof node !== 'object' || node === null) return false
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string' && !Array.isArray(record.children)) {
      if (state.chars + record.text.length > 6000) return false
      state.chars += record.text.length
      leaves.push({ path: path.slice(), text: record.text })
      return true
    }
    if (!Array.isArray(record.children) || record.children.length > 12000) return false
    for (let index = 0; index < record.children.length; index += 1) {
      const childPath = path.slice()
      childPath.push(index)
      if (!walkNode(record.children[index], childPath, depth + 1, state, leaves)) return false
    }
    return true
  }

  function asEditor(value: unknown, expected: string): EditorHandle | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (!Array.isArray(record.children) || typeof record.apply !== 'function' || typeof record.insertText !== 'function') {
      return undefined
    }
    let model: ModelRead | undefined
    try {
      model = readEditorModel(record.children)
    } catch {
      return undefined
    }
    if (model === undefined || model.text !== expected) return undefined
    const apply = record.apply
    const insertText = record.insertText
    return {
      get children() {
        return (value as { children: unknown }).children
      },
      get selection() {
        return (value as { selection: unknown }).selection
      },
      apply(operation) {
        apply.call(value, operation)
      },
      insertText(next) {
        insertText.call(value, next)
      },
    }
  }

  function considerValue(value: unknown, expected: string): EditorHandle | undefined {
    const direct = asEditor(value, expected)
    if (direct !== undefined) return direct
    if (isDataRecord(value) && 'current' in value) {
      const fromRef = asEditor(value.current, expected)
      if (fromRef !== undefined) return fromRef
    }
    if (Array.isArray(value) && value.length > 0) return asEditor(value[0], expected)
    return undefined
  }

  function considerContext(value: unknown, expected: string): EditorHandle | undefined {
    const direct = asEditor(value, expected)
    if (direct !== undefined) return direct
    if (isDataRecord(value) && 'editor' in value) return asEditor(value.editor, expected)
    return undefined
  }

  function editorOnFiber(fiber: unknown, expected: string): EditorHandle | undefined {
    if (!isDataRecord(fiber)) return undefined
    try {
      const props = fiber.memoizedProps
      if (isDataRecord(props) && 'editor' in props) {
        const fromProps = asEditor(props.editor, expected)
        if (fromProps !== undefined) return fromProps
      }
      let hook: unknown = fiber.memoizedState
      const seenHooks = new Set<unknown>()
      for (let count = 0; count < 80 && isDataRecord(hook); count += 1) {
        if (seenHooks.has(hook)) break
        seenHooks.add(hook)
        const fromHook = considerValue(hook.memoizedState, expected)
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
        const fromContext = considerContext(context.memoizedValue, expected)
        if (fromContext !== undefined) return fromContext
        context = context.next
      }
    } catch {
      return undefined
    }
    return undefined
  }

  function findEditor(element: HTMLElement, expected: string): EditorHandle | undefined {
    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'))
    if (key === undefined) return undefined
    let fiber: unknown = (element as unknown as Record<string, unknown>)[key]
    const seen = new Set<unknown>()
    for (let depth = 0; depth < 80 && (typeof fiber === 'object' && fiber !== null); depth += 1) {
      if (seen.has(fiber)) break
      seen.add(fiber)
      const editor = editorOnFiber(fiber, expected)
      if (editor !== undefined) return editor
      fiber = isDataRecord(fiber) ? fiber.return : undefined
    }
    return undefined
  }
}

interface WalkState {
  nodes: number
  chars: number
}

interface LeafHit {
  path: number[]
  text: string
}

interface ModelRead {
  text: string
  firstPath: number[]
  lastPath: number[]
  lastText: string
}

interface SelectionPoint {
  path: number[]
  offset: number
}

interface SelectionOperation {
  type: 'set_selection'
  properties: unknown
  newProperties: { anchor: SelectionPoint; focus: SelectionPoint }
}

interface EditorHandle {
  readonly children: unknown
  readonly selection: unknown
  apply(operation: SelectionOperation): void
  insertText(text: string): void
}
