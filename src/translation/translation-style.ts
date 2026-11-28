import type { PromptGlossaryEntry, TranslationStyle } from './preferences-extra'
import type { TargetLanguage } from './target-language'

const STYLE_ADDONS: Readonly<Record<TranslationStyle, string>> = {
  natural: '',
  technical:
    ' Use precise software and engineering terminology, keep API names, CLI flags, symbols and identifiers verbatim, and prefer crisp technical phrasing.',
  academic:
    ' Use formal academic register with rigorous terminology, objective phrasing, and faithful preservation of hedging, citations and logical qualifiers.',
  concise:
    ' Keep the translation compact and direct, trimming verbal padding while preserving every concrete fact, caveat and key detail.',
}

/** Shared writing guidance for page translation and reading assistance. */
export function translationStyleInstruction(
  language: TargetLanguage,
  style: TranslationStyle = 'natural',
): string {
  const general =
    'Read each complete input unit before translating. Write fluent, idiomatic prose with natural word order, clear references and smooth transitions. Preserve all facts, negation, uncertainty and logical relationships; do not embellish, summarize or add explanations. Keep technical terminology consistent and preserve code, identifiers, URLs, numbers and markup. Match the source register: keep interface labels short, and avoid expanding fragments into invented sentences. Before returning the result, silently check grammar, collocations and coherence, revising awkward literal phrasing without changing the meaning.'
  const base =
    language !== 'zh-CN' && language !== 'zh-TW'
      ? general
      : `${general} For Chinese, prefer concise, natural Chinese syntax over English-shaped clauses. Resolve the subject and object from the available text, use appropriate measure words and particles, and avoid dangling modifiers, ambiguous references, redundant connectives and excessive nominalization. Add no information that the source does not support.`
  const addon = STYLE_ADDONS[style] ?? ''
  return addon === '' ? base : `${base}${addon}`
}

/** 将命中的用户术语表格式化为模型指令片段。 */
export function glossaryPromptInstruction(entries: readonly PromptGlossaryEntry[]): string {
  if (entries.length === 0) return ''
  const pairs = entries.map((entry) => `"${entry.source}" => "${entry.target}"`).join('; ')
  return ` Follow this user terminology glossary consistently whenever these terms appear: ${pairs}.`
}
