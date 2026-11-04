export type AssistTrigger = 'selection' | 'revisit'
export type RequestedAssistIntent = 'define' | 'explain'

export interface AssistInput {
  readonly text: string
  readonly context: string
  readonly pageTitle: string
  readonly site: string
  readonly trigger: AssistTrigger
  readonly requestedIntent?: RequestedAssistIntent
  readonly signals: {
    readonly method: 'mouse' | 'keyboard' | 'none'
    readonly dwellMs: number
    readonly visits: number
  }
}

export interface AssistResult {
  readonly decision: 'show' | 'silent'
  readonly intent: 'translate' | 'define' | 'explain' | 'none'
  readonly translation: string
  readonly explanation: string
}

const SELECTION_TEXT_MAX = 6000
const REVISIT_TEXT_MIN = 30
const REVISIT_TEXT_MAX = 1200
const CONTEXT_MAX = 1200
const TITLE_MAX = 160
const SITE_MAX = 253
const DWELL_MAX = 60000
const VISITS_MAX = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSiteHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SITE_MAX) return false
  try {
    return new URL(`https://${value}`).hostname === value.toLowerCase()
  } catch {
    return false
  }
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function isAssistInput(value: unknown): value is AssistInput {
  if (!isRecord(value)) return false
  const trigger = value.trigger
  if (trigger !== 'selection' && trigger !== 'revisit') return false
  if (
    value.requestedIntent !== undefined &&
    (trigger !== 'selection' || (value.requestedIntent !== 'define' && value.requestedIntent !== 'explain'))
  ) return false
  if (typeof value.text !== 'string') return false
  const textLength = value.text.trim().length
  if (trigger === 'selection' && (textLength < 1 || value.text.length > SELECTION_TEXT_MAX)) return false
  if (trigger === 'revisit' && (textLength < REVISIT_TEXT_MIN || textLength > REVISIT_TEXT_MAX)) return false
  if (typeof value.context !== 'string' || value.context.length > CONTEXT_MAX) return false
  if (typeof value.pageTitle !== 'string' || value.pageTitle.length > TITLE_MAX) return false
  if (!isSiteHost(value.site)) return false
  const signals = value.signals
  if (!isRecord(signals)) return false
  if (signals.method !== 'mouse' && signals.method !== 'keyboard' && signals.method !== 'none') return false
  if (!isBoundedInteger(signals.dwellMs, 0, DWELL_MAX)) return false
  if (!isBoundedInteger(signals.visits, 1, VISITS_MAX)) return false
  return true
}

export function canonicalAssistInput(input: AssistInput): AssistInput {
  return {
    text: input.text,
    context: input.context.slice(0, CONTEXT_MAX),
    pageTitle: input.pageTitle.slice(0, TITLE_MAX),
    site: input.site,
    trigger: input.trigger,
    ...(input.requestedIntent === undefined ? {} : { requestedIntent: input.requestedIntent }),
    signals: {
      method: input.signals.method,
      dwellMs: Math.min(Math.max(Math.trunc(input.signals.dwellMs), 0), DWELL_MAX),
      visits: Math.min(Math.max(Math.trunc(input.signals.visits), 1), VISITS_MAX),
    },
  }
}

const RESULT_KEYS: readonly string[] = ['decision', 'intent', 'translation', 'explanation']

export function parseAssistResult(value: unknown): AssistResult | undefined {
  if (!isRecord(value)) return undefined
  if (!Object.keys(value).every((key) => RESULT_KEYS.includes(key))) return undefined
  const { decision, intent, translation, explanation } = value
  if (decision !== 'show' && decision !== 'silent') return undefined
  if (intent !== 'translate' && intent !== 'define' && intent !== 'explain' && intent !== 'none') return undefined
  if (typeof translation !== 'string' || typeof explanation !== 'string') return undefined
  if (translation.length > 18000 || explanation.length > 1600) return undefined
  if (decision === 'silent') {
    if (intent !== 'none' || translation !== '' || explanation !== '') return undefined
    return { decision, intent, translation, explanation }
  }
  if (intent === 'none') return undefined
  if (translation.trim() === '' && explanation.trim() === '') return undefined
  return { decision, intent, translation, explanation }
}
