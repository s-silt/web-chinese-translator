export interface DocumentEditorRequest {
  readonly elementId: string
  readonly action: 'read' | 'replace'
  readonly expectedText?: string
  readonly text?: string
}

export type DocumentEditorResult =
  | { readonly status: 'ok'; readonly text: string; readonly canReplace: boolean }
  | { readonly status: 'changed' | 'unsupported' | 'failed' }

interface CkNode {
  is(type: string, name?: string): boolean
  readonly name?: string
  readonly data?: unknown
  getAttributes?(): Iterable<unknown>
  getChildren?(): Iterable<CkNode>
}

interface CkWriter {
  remove(range: unknown): void
  createRangeIn(node: unknown): unknown
  createElement(name: string): unknown
  append(element: unknown, parent: unknown): void
  appendText(text: string, element: unknown): void
  setSelection(...args: unknown[]): void
}

interface CkEditor {
  isReadOnly?: boolean
  ui?: { getEditableElement?(): unknown }
  editing?: { view?: { getDomRoot?(): unknown } }
  model?: {
    document?: { getRoot?(): { getChildren?(): Iterable<CkNode> } }
    change?(fn: (writer: CkWriter) => void): void
  }
}

interface Cm5Editor {
  getWrapperElement(): Element
  getValue(): string
  getOption?(name: string): unknown
  posFromIndex(index: number): unknown
  replaceRange(next: string, from: unknown, to: unknown, origin?: string): void
}

interface Cm6View {
  readonly dom: unknown
  readonly contentDOM: unknown
  readonly state: {
    readonly doc: { toString(): string; readonly length: number }
    readonly readOnly?: boolean
  }
  dispatch(spec: {
    changes: { from: number; to: number; insert: string }
    selection: { anchor: number }
  }): void
  readonly editable?: boolean
  readonly parent?: unknown
  readonly view?: unknown
}

interface TinyEditor {
  getBody?(): unknown
  getDoc?(): unknown
  readonly?: boolean
  readonly mode?: unknown
  getParam?(name: string, defaultValue?: unknown): unknown
  getContent?(options: { format: string }): unknown
  setContent?(html: string): void
  undoManager?: { transact?(fn: () => void): void }
  fire?(name: string): void
  dispatch?(name: string): void
  save?(): void
}

export function documentEditorInMainWorld(request: DocumentEditorRequest): DocumentEditorResult {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
  const doc = document
  const TOKEN_ATTRIBUTE = 'data-wt-document-input'
  const MAX_SCAN_ROOTS = 64
  const MAX_SCAN_ELEMENTS = 2000
  const MAX_SOURCE_TEXT = 6000
  const MAX_RESULT_TEXT = 18000
  const MAX_MODEL_NODES = 20000
  const MAX_MODEL_CHARS = 60000
  const MAX_ANCESTOR_DEPTH = 64
  const SENSITIVE_AUTOCOMPLETE = /^(?:username|current-password|new-password|one-time-code|cc-[a-z-]+)$/i
  const SENSITIVE_METADATA_PATTERN =
    /(?:pass(?:word|code|phrase)?|pwd|token|secret|api[-_\s]?key|private[-_\s]?key|access[-_\s]?key|auth(?:entication)?[-_\s]?(?:code|key|token)?|otp|totp|2fa|mfa|verif(?:y|ication)[-_\s]?code|security[-_\s]?code|card[-_\s]?(?:number|no|num)|credit[-_\s]?card|debit[-_\s]?card|cvv|cvc|csc|pin(?:\b|[-_\s]?code)|ssn|tax[-_\s]?id|bank[-_\s]?account|routing[-_\s]?number|iban|swift|mnemonic|seed[-_\s]?phrase|密码|口令|密钥|秘钥|私钥|令牌|验证码|动态码|安全码|校验码|银行卡|信用卡|卡号|身份证|社保|支付密码|助记词|パスワード|暗証番号|トークン|シークレット|秘密鍵|APIキー|認証コード|確認コード|ワンタイム|セキュリティコード|カード番号|クレジットカード|口座番号)/i
  const SENSITIVE_FIELD_ATTRIBUTES = ['name', 'id', 'aria-label', 'placeholder', 'title', 'autocomplete', 'role']
  const TINYMCE_FORMATTING_TAGS = new Set([
    'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'FONT', 'SPAN',
    'CODE', 'PRE', 'CITE', 'Q', 'ABBR', 'ACRONYM', 'MARK', 'SMALL', 'BIG', 'TT',
  ])
  const TINYMCE_UNSUPPORTED_TAGS = new Set([
    'IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'MATH',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'BUTTON', 'SCRIPT', 'STYLE', 'LINK', 'META', 'HR', 'PICTURE', 'SOURCE', 'TRACK',
    'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  ])

  function fail(status: 'changed' | 'unsupported' | 'failed'): DocumentEditorResult {
    return { status }
  }
  function ok(text: string, canReplace: boolean): DocumentEditorResult {
    return { status: 'ok', text, canReplace }
  }

  function deepActiveElement(root: Document | ShadowRoot): Element | null {
    let active: Element | null = root.activeElement
    for (let depth = 0; depth < 32 && active?.shadowRoot?.activeElement != null; depth += 1) {
      active = active.shadowRoot.activeElement
    }
    return active
  }

  function composedParent(element: Element): Element | null {
    if (element.parentElement !== null) return element.parentElement
    const root = element.getRootNode()
    return root instanceof ShadowRoot ? (root.host as Element | null) : null
  }

  function composedContains(ancestor: Element, element: Element): boolean {
    let current: Element | null = element
    while (current !== null) {
      if (current === ancestor) return true
      current = composedParent(current)
    }
    return false
  }

  function closestComposed(element: Element, selector: string): Element | null {
    let current: Element | null = element
    while (current !== null) {
      if (current.matches(selector)) return current
      current = composedParent(current)
    }
    return null
  }

  function isHiddenOrDisabled(element: Element): boolean {
    if (!element.isConnected) return true
    let current: Element | null = element
    let depth = 0
    while (current !== null) {
      if (depth >= MAX_ANCESTOR_DEPTH) return true
      depth += 1
      const el = current as HTMLElement
      if (el.hidden === true || current.hasAttribute('hidden')) return true
      if ((el as { inert?: unknown }).inert === true || current.hasAttribute('inert')) return true
      if (current.getAttribute('aria-hidden') === 'true') return true
      if (current.getAttribute('aria-disabled') === 'true' || current.getAttribute('aria-readonly') === 'true') {
        return true
      }
      if (current.getAttribute('contenteditable') === 'false') return true
      const tag = current.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
        const control = current as HTMLInputElement
        if (control.disabled === true) return true
        if ((tag === 'INPUT' || tag === 'TEXTAREA') && control.readOnly === true) return true
      }
      try {
        const style = getComputedStyle(current)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          return true
        }
      } catch {
        return true
      }
      current = composedParent(current)
    }
    return false
  }

  let labelTexts: Map<string, string> | undefined
  function labelTextFor(id: string): string {
    if (labelTexts === undefined) {
      labelTexts = new Map()
      try {
        for (const label of doc.querySelectorAll('label[for]')) {
          const htmlFor =
            (label as HTMLLabelElement).htmlFor !== ''
              ? (label as HTMLLabelElement).htmlFor
              : (label.getAttribute('for') ?? '')
          if (htmlFor !== '') {
            labelTexts.set(htmlFor, `${labelTexts.get(htmlFor) ?? ''} ${label.textContent ?? ''}`)
          }
        }
      } catch {
        labelTexts = new Map()
      }
    }
    return labelTexts.get(id) ?? ''
  }

  function elementSensitiveMetadata(element: Element): string {
    const parts: string[] = []
    for (const attr of SENSITIVE_FIELD_ATTRIBUTES) {
      const value = element.getAttribute(attr)
      if (typeof value === 'string' && value !== '') parts.push(value)
    }
    const labelledby = element.getAttribute('aria-labelledby')
    if (typeof labelledby === 'string' && labelledby !== '') {
      for (const id of labelledby.split(/\s+/)) {
        if (id === '') continue
        const ref = doc.getElementById(id)
        if (ref !== null) parts.push(ref.textContent ?? '')
      }
    }
    const id = element.getAttribute('id')
    if (typeof id === 'string' && id !== '') parts.push(labelTextFor(id))
    let ancestor = composedParent(element)
    while (ancestor !== null && ancestor.tagName !== 'HTML') {
      if (ancestor.tagName === 'LABEL') parts.push(ancestor.textContent ?? '')
      ancestor = composedParent(ancestor)
    }
    return parts.join(' ')
  }

  function isSensitiveField(element: Element): boolean {
    if (closestComposed(element, '[data-sensitive],[data-wt-root]') !== null) return true
    let current: Element | null = element
    let depth = 0
    while (current !== null) {
      if (depth >= MAX_ANCESTOR_DEPTH) return true
      depth += 1
      const autoComplete = (current.getAttribute('autocomplete') ?? '').trim().toLowerCase()
      if (autoComplete !== '' && autoComplete.split(/\s+/).some((token) => SENSITIVE_AUTOCOMPLETE.test(token))) {
        return true
      }
      const tag = current.tagName
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && (current as HTMLInputElement).type === 'password') {
        return true
      }
      const metadata = elementSensitiveMetadata(current)
      if (metadata !== '' && SENSITIVE_METADATA_PATTERN.test(metadata)) return true
      if (tag === 'FORM') {
        const action = current.getAttribute('action')
        if (typeof action === 'string' && action !== '' && SENSITIVE_METADATA_PATTERN.test(action)) return true
        if (current.querySelector('input[type="password" i]') !== null) return true
      }
      if (tag === 'HTML') break
      current = composedParent(current)
    }
    return false
  }

  function findTokenedRoot(token: string): { root: Element | null; matches: number; exhausted: boolean } {
    const matches: Element[] = []
    const roots: Array<Document | ShadowRoot> = [doc]
    let scanned = 0
    let exhausted = false
    for (let index = 0; index < roots.length; index += 1) {
      if (index >= MAX_SCAN_ROOTS) {
        exhausted = true
        break
      }
      const root = roots[index]!
      const walker = doc.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT)
      let node = walker.nextNode()
      while (node !== null) {
        if (scanned >= MAX_SCAN_ELEMENTS) {
          exhausted = true
          break
        }
        scanned += 1
        const element = node as Element
        if (element.shadowRoot !== null) {
          if (roots.length < MAX_SCAN_ROOTS) roots.push(element.shadowRoot)
          else exhausted = true
        }
        if (element.getAttribute(TOKEN_ATTRIBUTE) === token) {
          matches.push(element)
        }
        node = walker.nextNode()
      }
      if (exhausted) break
    }
    return { root: matches.length === 1 && !exhausted ? matches[0]! : null, matches: matches.length, exhausted }
  }

  function candidateUsable(root: Element): boolean {
    if (root.getAttribute('contenteditable') === 'false') return false
    return !isHiddenOrDisabled(root) && !isSensitiveField(root)
  }

  function focusedWithin(root: Element): boolean {
    const active = deepActiveElement(doc)
    return active !== null && composedContains(root, active)
  }

  function hasUnsafeDescendant(root: Element): boolean {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    let scanned = 0
    let node = walker.nextNode()
    while (node !== null) {
      if (scanned >= MAX_SCAN_ELEMENTS) return true
      scanned += 1
      const element = node as Element
      const tag = element.tagName
      if (element.getAttribute('contenteditable') === 'false') return true
      if (element.hasAttribute('data-sensitive') || element.hasAttribute('data-wt-root')) return true
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (tag === 'INPUT' && (element as HTMLInputElement).type === 'password') return true
        const auto = (element.getAttribute('autocomplete') ?? '').trim().toLowerCase()
        if (auto !== '' && SENSITIVE_AUTOCOMPLETE.test(auto)) return true
      }
      const metadata = elementSensitiveMetadata(element)
      if (metadata !== '' && SENSITIVE_METADATA_PATTERN.test(metadata)) return true
      node = walker.nextNode()
    }
    return false
  }

  function boundedText(text: string): string | undefined {
    if (text.trim() === '') return undefined
    if (text.length > (request.action === 'read' ? MAX_SOURCE_TEXT : MAX_RESULT_TEXT)) return undefined
    return text
  }

  function ckEditor(root: Element): CkEditor | undefined {
    const candidate = (root as unknown as { ckeditorInstance?: unknown }).ckeditorInstance
    if (!isRecord(candidate)) return undefined
    const editor = candidate as unknown as CkEditor
    try {
      const editable = typeof editor.ui?.getEditableElement === 'function' ? editor.ui.getEditableElement() : undefined
      const domRoot = typeof editor.editing?.view?.getDomRoot === 'function' ? editor.editing.view.getDomRoot() : undefined
      if (editable === root || domRoot === root) return editor
    } catch {
      return undefined
    }
    return undefined
  }

  function ckAttributesFlagged(node: CkNode): boolean {
    if (typeof node.getAttributes !== 'function') return false
    try {
      for (const _attribute of node.getAttributes()) return true
    } catch {
      return true
    }
    return false
  }

  function ckModelText(editor: CkEditor): { text: string; canReplace: boolean; complex: boolean } {
    const getRoot = editor.model?.document?.getRoot
    const rootNode = typeof getRoot === 'function' ? getRoot.call(editor.model!.document) : undefined
    const children = typeof rootNode?.getChildren === 'function' ? rootNode.getChildren() : undefined
    if (children === undefined) return { text: '', canReplace: false, complex: true }
    const lines: string[] = []
    let canReplace = true
    let complex = false
    let nodes = 0
    let chars = 0
    for (const block of children) {
      if (complex) break
      nodes += 1
      if (nodes > MAX_MODEL_NODES || chars > MAX_MODEL_CHARS) {
        complex = true
        break
      }
      if (typeof block.is !== 'function' || !block.is('element') || block.name !== 'paragraph') {
        complex = true
        break
      }
      if (ckAttributesFlagged(block)) canReplace = false
      const blockChildren = typeof block.getChildren === 'function' ? block.getChildren() : undefined
      if (blockChildren === undefined) {
        complex = true
        break
      }
      let line = ''
      for (const child of blockChildren) {
        nodes += 1
        if (nodes > MAX_MODEL_NODES) {
          complex = true
          break
        }
        if (typeof child.is !== 'function') {
          complex = true
          break
        }
        if (child.is('$text') || child.is('$textProxy')) {
          if (typeof child.data !== 'string') {
            complex = true
            break
          }
          chars += child.data.length
          if (chars > MAX_MODEL_CHARS) {
            complex = true
            break
          }
          if (ckAttributesFlagged(child)) canReplace = false
          line += child.data
        } else if (child.is('element', 'softBreak') || (child.is('element') && child.name === 'softBreak')) {
          canReplace = false
          line += '\n'
          chars += 1
        } else {
          complex = true
          break
        }
      }
      if (complex) break
      lines.push(line)
    }
    return { text: lines.join('\n'), canReplace, complex }
  }

  function readCK(root: Element): { text: string; canReplace: boolean } | 'unsupported' {
    const editor = ckEditor(root)
    if (editor === undefined || editor.isReadOnly === true) return 'unsupported'
    const snapshot = ckModelText(editor)
    if (snapshot.complex) return 'unsupported'
    const text = boundedText(snapshot.text)
    if (text === undefined) return 'unsupported'
    return { text, canReplace: snapshot.canReplace }
  }

  function writeCK(root: Element, expected: string, next: string): 'ok' | 'changed' | 'unsupported' | 'failed' {
    const editor = ckEditor(root)
    const change = editor?.model?.change
    const getRoot = editor?.model?.document?.getRoot
    if (editor === undefined || editor.isReadOnly === true || typeof change !== 'function' || typeof getRoot !== 'function') {
      return 'unsupported'
    }
    const before = ckModelText(editor)
    if (before.complex || !before.canReplace || before.text !== expected) return 'changed'
    if (!focusedWithin(root) || !candidateUsable(root)) return 'failed'
    try {
      const modelRoot = getRoot.call(editor.model!.document)
      change.call(editor.model, (writer: CkWriter) => {
        writer.remove(writer.createRangeIn(modelRoot))
        for (const line of next.split('\n')) {
          const paragraph = writer.createElement('paragraph')
          writer.append(paragraph, modelRoot)
          if (line !== '') writer.appendText(line, paragraph)
        }
        writer.setSelection(modelRoot, 'end')
      })
    } catch {
      return 'failed'
    }
    const after = ckModelText(editor)
    return !after.complex && after.text === next ? 'ok' : 'failed'
  }

  function tinyEditors(): TinyEditor[] {
    const found: TinyEditor[] = []
    const collect = (tiny: unknown): void => {
      if (!isRecord(tiny)) return
      let editors: unknown = tiny.editors
      if (!Array.isArray(editors) && typeof tiny.get === 'function') {
        try {
          editors = (tiny.get as () => unknown).call(tiny)
        } catch {
          return
        }
      }
      if (!Array.isArray(editors)) return
      for (const editor of editors) {
        if (isRecord(editor)) found.push(editor as unknown as TinyEditor)
      }
    }
    try {
      collect((window as unknown as { tinymce?: unknown }).tinymce)
    } catch {
      void 0
    }
    try {
      const parentTiny = (window.parent as unknown as { tinymce?: unknown } | null)?.tinymce
      collect(parentTiny)
    } catch {
      void 0
    }
    return found
  }

  function tinyEditorFor(root: Element): TinyEditor | undefined {
    for (const editor of tinyEditors()) {
      try {
        if (typeof editor.getBody === 'function' && typeof editor.getDoc === 'function') {
          if (editor.getBody() === root && editor.getDoc() === doc) return editor
        }
      } catch {
        void 0
      }
    }
    return undefined
  }

  function tinyModeReadonly(mode: unknown): boolean {
    if (mode === 'readonly') return true
    if (isRecord(mode) && typeof mode.get === 'function') {
      try {
        return (mode.get as () => unknown).call(mode) === 'readonly'
      } catch {
        return true
      }
    }
    return false
  }

  function tinyReadOnly(editor: TinyEditor): boolean {
    try {
      if (editor.readonly === true || tinyModeReadonly(editor.mode)) return true
      if (typeof editor.getParam === 'function') {
        const value = editor.getParam('readonly', false)
        if (value !== undefined && value !== false && value !== 0 && value !== 'false') return true
      }
    } catch {
      return true
    }
    return false
  }

  function tinyDomScan(root: Element): { embedded: boolean; formatted: boolean } {
    let formatted = false
    let embedded = false
    let paragraphs = 0
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '') formatted = true
    }
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    let scanned = 0
    let node = walker.nextNode()
    while (node !== null) {
      if (scanned >= MAX_SCAN_ELEMENTS) {
        embedded = true
        break
      }
      scanned += 1
      const element = node as Element
      const tag = element.tagName
      if (tag === 'P') paragraphs += 1
      if (paragraphs > 1 || tag === 'DIV' || (tag === 'P' && element.parentElement !== root)) formatted = true
      if (TINYMCE_UNSUPPORTED_TAGS.has(tag)) {
        embedded = true
      } else if (TINYMCE_FORMATTING_TAGS.has(tag)) {
        formatted = true
      } else if (tag !== 'P' && tag !== 'DIV' && tag !== 'BR' && tag !== 'BODY') {
        embedded = true
      }
      for (const attr of Array.from(element.attributes)) {
        if (!attr.name.startsWith('data-mce-')) formatted = true
      }
      if (embedded) break
      node = walker.nextNode()
    }
    return { embedded, formatted }
  }

  function tinyCollapsesWhitespace(text: string): boolean {
    return /\t| {2,}|\n | \n/.test(text.trim())
  }

  function readTiny(root: Element): { text: string; canReplace: boolean } | 'unsupported' {
    const editor = tinyEditorFor(root)
    if (editor === undefined || tinyReadOnly(editor) || typeof editor.getContent !== 'function') {
      return 'unsupported'
    }
    let text: unknown
    try {
      text = editor.getContent({ format: 'text' })
    } catch {
      return 'unsupported'
    }
    if (typeof text !== 'string') return 'unsupported'
    const bounded = boundedText(text)
    if (bounded === undefined) return 'unsupported'
    const scan = tinyDomScan(root)
    if (scan.embedded) return 'unsupported'
    return { text: bounded, canReplace: !scan.formatted }
  }

  function writeTiny(root: Element, expected: string, next: string): 'ok' | 'changed' | 'unsupported' | 'failed' {
    const editor = tinyEditorFor(root)
    const transact = editor?.undoManager?.transact
    if (
      editor === undefined ||
      tinyReadOnly(editor) ||
      typeof editor.getContent !== 'function' ||
      typeof editor.setContent !== 'function' ||
      typeof transact !== 'function'
    ) {
      return 'unsupported'
    }
    const scan = tinyDomScan(root)
    if (scan.embedded || scan.formatted) return 'unsupported'
    let before: unknown
    try {
      before = editor.getContent({ format: 'text' })
    } catch {
      return 'failed'
    }
    if (before !== expected) return 'changed'
    if (tinyCollapsesWhitespace(next)) return 'unsupported'
    if (!focusedWithin(root) || !candidateUsable(root)) return 'failed'
    const escaped = next.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    try {
      transact.call(editor.undoManager, () => {
        editor.setContent!(`<p>${escaped.replace(/\n/g, '<br>')}</p>`)
      })
      const emit = typeof editor.dispatch === 'function' ? editor.dispatch : editor.fire
      emit?.call(editor, 'input')
      emit?.call(editor, 'change')
      editor.save?.()
    } catch {
      return 'failed'
    }
    let after: unknown
    try {
      after = editor.getContent({ format: 'text' })
    } catch {
      return 'failed'
    }
    if (typeof after !== 'string') return 'failed'
    const normalize = (value: string): string => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    return normalize(after) === normalize(next) ? 'ok' : 'failed'
  }

  function cm5Instance(root: Element): Cm5Editor | undefined {
    const candidate = (root as unknown as { CodeMirror?: unknown }).CodeMirror
    if (!isRecord(candidate)) return undefined
    const cm = candidate as unknown as Cm5Editor
    try {
      if (typeof cm.getWrapperElement === 'function' && cm.getWrapperElement() === root && typeof cm.getValue === 'function') {
        return cm
      }
    } catch {
      return undefined
    }
    return undefined
  }

  function cm5ReadOnly(cm: Cm5Editor): boolean {
    if (typeof cm.getOption !== 'function') return false
    let value: unknown
    try {
      value = cm.getOption('readOnly')
    } catch {
      return true
    }
    return value !== false && value !== undefined
  }

  function readCM5(root: Element): { text: string; canReplace: boolean } | 'unsupported' {
    const cm = cm5Instance(root)
    if (cm === undefined || cm5ReadOnly(cm)) return 'unsupported'
    let text: unknown
    try {
      text = cm.getValue()
    } catch {
      return 'unsupported'
    }
    if (typeof text !== 'string') return 'unsupported'
    const bounded = boundedText(text)
    if (bounded === undefined) return 'unsupported'
    return { text: bounded, canReplace: true }
  }

  function writeCM5(root: Element, expected: string, next: string): 'ok' | 'changed' | 'unsupported' | 'failed' {
    const cm = cm5Instance(root)
    if (cm === undefined || cm5ReadOnly(cm)) return 'unsupported'
    let before: unknown
    try {
      before = cm.getValue()
    } catch {
      return 'failed'
    }
    if (before !== expected) return 'changed'
    if (!focusedWithin(root) || !candidateUsable(root)) return 'failed'
    try {
      cm.replaceRange(next, { line: 0, ch: 0 }, cm.posFromIndex(String(before).length), '+input')
    } catch {
      return 'failed'
    }
    try {
      return cm.getValue() === next ? 'ok' : 'failed'
    } catch {
      return 'failed'
    }
  }

  function isCm6View(value: unknown, root: Element, contentDOM: Element): value is Cm6View {
    if (!isRecord(value)) return false
    const candidate = value as unknown as Cm6View
    try {
      if (candidate.dom !== root || candidate.contentDOM !== contentDOM) return false
      const doc = candidate.state?.doc
      if (doc === undefined || typeof doc.toString !== 'function') return false
      if (typeof doc.length !== 'number' || !Number.isFinite(doc.length) || doc.length < 0) return false
      return typeof candidate.dispatch === 'function'
    } catch {
      return false
    }
  }

  function cm6View(root: Element, contentDOM: Element): Cm6View | undefined {
    const direct = (window as unknown as { cmEditorView?: unknown }).cmEditorView
    if (isCm6View(direct, root, contentDOM)) return direct
    const tile = (contentDOM as unknown as { cmTile?: unknown }).cmTile
    if (isRecord(tile) && tile.dom === contentDOM && isCm6View(tile.view, root, contentDOM)) {
      return tile.view
    }
    let current: unknown = (contentDOM as unknown as { cmView?: unknown }).cmView
    for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
      const record = isRecord(current) ? current : undefined
      const inner = record?.view
      if (isCm6View(inner, root, contentDOM)) return inner as Cm6View
      if (isCm6View(current, root, contentDOM)) return current
      current = record?.parent
    }
    return undefined
  }

  function cm6Editable(view: Cm6View, contentDOM: Element): boolean {
    try {
      if (view.editable === false || view.state.readOnly === true) return false
      return (contentDOM as HTMLElement).isContentEditable === true
    } catch {
      return false
    }
  }

  function readCM6(root: Element): { text: string; canReplace: boolean } | 'unsupported' {
    const contentDOM = root.querySelector('.cm-content')
    if (contentDOM === null) return 'unsupported'
    const view = cm6View(root, contentDOM)
    if (view === undefined || !cm6Editable(view, contentDOM)) return 'unsupported'
    let text: unknown
    try {
      text = view.state.doc.toString()
    } catch {
      return 'unsupported'
    }
    if (typeof text !== 'string') return 'unsupported'
    const bounded = boundedText(text)
    if (bounded === undefined) return 'unsupported'
    return { text: bounded, canReplace: true }
  }

  function writeCM6(root: Element, expected: string, next: string): 'ok' | 'changed' | 'unsupported' | 'failed' {
    const contentDOM = root.querySelector('.cm-content')
    if (contentDOM === null) return 'unsupported'
    const view = cm6View(root, contentDOM)
    if (view === undefined || !cm6Editable(view, contentDOM)) return 'unsupported'
    let before: unknown
    try {
      before = view.state.doc.toString()
    } catch {
      return 'failed'
    }
    if (before !== expected) return 'changed'
    if (!focusedWithin(root) || !candidateUsable(root)) return 'failed'
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor: next.length },
      })
    } catch {
      return 'failed'
    }
    try {
      return view.state.doc.toString() === next ? 'ok' : 'failed'
    } catch {
      return 'failed'
    }
  }

  interface EditorAdapter {
    readonly read: () => { text: string; canReplace: boolean } | 'unsupported'
    readonly write: (next: string) => 'ok' | 'changed' | 'unsupported' | 'failed'
  }

  let expectedGuard = ''

  function detectAdapter(root: Element): EditorAdapter | undefined {
    if (typeof (root as unknown as { ckeditorInstance?: unknown }).ckeditorInstance !== 'undefined' ||
        root.classList?.contains('ck-editor__editable') === true) {
      return {
        read: () => readCK(root),
        write: (next) => writeCK(root, expectedGuard, next),
      }
    }
    if (root.classList?.contains('mce-content-body') === true) {
      return {
        read: () => readTiny(root),
        write: (next) => writeTiny(root, expectedGuard, next),
      }
    }
    if (root.classList?.contains('CodeMirror') === true || cm5Instance(root) !== undefined) {
      return {
        read: () => readCM5(root),
        write: (next) => writeCM5(root, expectedGuard, next),
      }
    }
    if (root.classList?.contains('cm-editor') === true) {
      return {
        read: () => readCM6(root),
        write: (next) => writeCM6(root, expectedGuard, next),
      }
    }
    return undefined
  }

  try {
    if (!isRecord(request)) return fail('failed')
    if (typeof request.elementId !== 'string' || request.elementId === '') return fail('failed')
    if (request.action !== 'read' && request.action !== 'replace') return fail('failed')

    const found = findTokenedRoot(request.elementId)
    if (found.exhausted || found.matches !== 1 || found.root === null) return fail('unsupported')
    const root = found.root
    if (!candidateUsable(root) || !focusedWithin(root) || hasUnsafeDescendant(root)) return fail('unsupported')

    const adapter = detectAdapter(root)
    if (adapter === undefined) return fail('unsupported')

    if (request.action === 'read') {
      const snapshot = adapter.read()
      if (snapshot === 'unsupported') return fail('unsupported')
      return ok(snapshot.text, snapshot.canReplace)
    }

    if (typeof request.expectedText !== 'string' || request.expectedText.length < 1 || request.expectedText.length > MAX_RESULT_TEXT) {
      return fail('failed')
    }
    if (typeof request.text !== 'string' || request.text.length < 1 || request.text.length > MAX_RESULT_TEXT) {
      return fail('failed')
    }
    if (request.text.trim() === '') return fail('failed')
    expectedGuard = request.expectedText
    const outcome = adapter.write(request.text)
    if (outcome !== 'ok') return fail(outcome)
    const snapshot = adapter.read()
    return snapshot === 'unsupported' ? fail('failed') : ok(snapshot.text, snapshot.canReplace)
  } catch {
    return fail('failed')
  }
}

export function isDocumentEditorResult(value: unknown): value is DocumentEditorResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const status = record.status
  if (status === 'changed' || status === 'unsupported' || status === 'failed') {
    return Object.keys(record).length === 1
  }
  if (status !== 'ok') return false
  return (
    Object.keys(record).length === 3 &&
    typeof record.text === 'string' &&
    record.text.length <= 18000 &&
    typeof record.canReplace === 'boolean'
  )
}
