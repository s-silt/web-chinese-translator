import type { TargetLanguage } from './target-language'

/** Shared writing guidance for page translation and reading assistance. */
export function translationStyleInstruction(language: TargetLanguage): string {
  const general = 'Read each complete input unit before translating. Write fluent, idiomatic prose with natural word order, clear references and smooth transitions. Preserve all facts, negation, uncertainty and logical relationships; do not embellish, summarize or add explanations. Keep technical terminology consistent and preserve code, identifiers, URLs, numbers and markup. Match the source register: keep interface labels short, and avoid expanding fragments into invented sentences. Before returning the result, silently check grammar, collocations and coherence, revising awkward literal phrasing without changing the meaning.'
  if (language !== 'zh-CN' && language !== 'zh-TW') return general
  return `${general} For Chinese, prefer concise, natural Chinese syntax over English-shaped clauses. Resolve the subject and object from the available text, use appropriate measure words and particles, and avoid dangling modifiers, ambiguous references, redundant connectives and excessive nominalization. Add no information that the source does not support.`
}
