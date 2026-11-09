export const DEFAULT_INPUT_REPLACE_KEY = 'Tab'

export interface ParsedHotkey {
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly key: string
}

const MODIFIER_ONLY_KEYS: ReadonlySet<string> = new Set([
  'control',
  'ctrl',
  'shift',
  'alt',
  'option',
  'meta',
  'command',
  'cmd',
  'os',
  'super',
  'hyper',
  'altgraph',
  'capslock',
  'numlock',
  'scrolllock',
  'fn',
  'fnlock',
  'symbol',
  'symbollock',
])

const IGNORED_EVENT_KEYS: ReadonlySet<string> = new Set([
  'process',
  'dead',
  'unidentified',
  'compose',
  'kanamode',
  'hangulmode',
  'hanjamode',
  'junjamode',
  'zenkaku',
  'hankaku',
  'zenkakuhankaku',
  'convert',
  'nonconvert',
  'accept',
  'modechange',
])

const SPECIAL_KEY_CANONICAL: Readonly<Record<string, string>> = {
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  escape: 'Escape',
  esc: 'Escape',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
  // 「+」与分隔符冲突，规范写作 Plus
  plus: 'Plus',
}

const BARE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
])

function canonicalKeyName(raw: string): string | undefined {
  if (raw === ' ') return 'Space'
  if (raw === '+') return 'Plus'
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const lower = trimmed.toLowerCase()
  if (MODIFIER_ONLY_KEYS.has(lower) || IGNORED_EVENT_KEYS.has(lower)) return undefined
  const special = SPECIAL_KEY_CANONICAL[lower]
  if (special !== undefined) return special
  if (trimmed.length === 1) {
    const code = trimmed.charCodeAt(0)
    if (code <= 32 || code === 127) return undefined
    return trimmed.toUpperCase()
  }
  return undefined
}

function isPrintableSingleKey(key: string): boolean {
  return key.length === 1 || key === 'Plus'
}

function isLegalHotkey(parsed: ParsedHotkey): boolean {
  if (parsed.key === 'Escape') return false
  const hasPrimaryModifier = parsed.ctrl || parsed.alt || parsed.meta
  if (!hasPrimaryModifier && !parsed.shift) {
    return BARE_ALLOWED_KEYS.has(parsed.key)
  }
  if (!hasPrimaryModifier && parsed.shift) {
    return !isPrintableSingleKey(parsed.key)
  }
  return true
}

function serializeHotkey(parsed: ParsedHotkey): string {
  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  if (parsed.meta) parts.push('Meta')
  parts.push(parsed.key)
  return parts.join('+')
}

export function parseHotkey(value: unknown): ParsedHotkey | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  // 末段为「+」本身（如 Ctrl++）时按 Plus 解析
  const tokens = (trimmed.endsWith('++') ? `${trimmed.slice(0, -1)}Plus` : trimmed === '+' ? 'Plus' : trimmed).split('+')
  if (tokens.some((token) => token.trim() === '')) return undefined
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const mod = tokens[i]!.trim().toLowerCase()
    if (mod === 'ctrl' || mod === 'control' || mod === '⌃') {
      if (ctrl) return undefined
      ctrl = true
    } else if (mod === 'alt' || mod === 'option' || mod === 'opt' || mod === '⌥') {
      if (alt) return undefined
      alt = true
    } else if (mod === 'shift' || mod === '⇧') {
      if (shift) return undefined
      shift = true
    } else if (mod === 'meta' || mod === 'cmd' || mod === 'command' || mod === 'win' || mod === 'super' || mod === '⌘') {
      if (meta) return undefined
      meta = true
    } else {
      return undefined
    }
  }
  const key = canonicalKeyName(tokens[tokens.length - 1]!)
  if (key === undefined) return undefined
  const parsed: ParsedHotkey = { ctrl, alt, shift, meta, key }
  if (!isLegalHotkey(parsed)) return undefined
  return parsed
}

export function normalizeHotkey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.trim() === '') return ''
  const parsed = parseHotkey(value)
  if (parsed === undefined) return undefined
  return serializeHotkey(parsed)
}

export function hotkeyFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> & {
    readonly isComposing?: boolean
    readonly keyCode?: number
  },
): string | undefined {
  if (event.isComposing === true || event.keyCode === 229) return undefined
  const key = canonicalKeyName(event.key)
  if (key === undefined) return undefined
  return serializeHotkey({
    ctrl: Boolean(event.ctrlKey),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    meta: Boolean(event.metaKey),
    key,
  })
}

export function matchesHotkey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> & {
    readonly isComposing?: boolean
    readonly keyCode?: number
    readonly repeat?: boolean
  },
  hotkey: string,
): boolean {
  if (event.isComposing === true || event.keyCode === 229 || event.repeat === true) return false
  if (hotkey.trim() === '') return false
  const parsed = parseHotkey(hotkey)
  if (parsed === undefined) return false
  if (
    Boolean(event.ctrlKey) !== parsed.ctrl ||
    Boolean(event.altKey) !== parsed.alt ||
    Boolean(event.shiftKey) !== parsed.shift ||
    Boolean(event.metaKey) !== parsed.meta
  ) {
    return false
  }
  const eventKey = canonicalKeyName(event.key)
  return eventKey !== undefined && eventKey === parsed.key
}

export function formatHotkey(hotkey: string, isMac = false): string {
  if (hotkey.trim() === '') return ''
  const parsed = parseHotkey(hotkey)
  if (parsed === undefined) return ''
  if (!isMac) return serializeHotkey(parsed)
  const parts: string[] = []
  if (parsed.ctrl) parts.push('⌃')
  if (parsed.alt) parts.push('⌥')
  if (parsed.shift) parts.push('⇧')
  if (parsed.meta) parts.push('⌘')
  parts.push(parsed.key)
  return parts.join('+')
}
