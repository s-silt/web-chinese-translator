import type { MessageKey } from '../../i18n'

export interface ModelPreset {
  readonly id: string
  readonly key: MessageKey
  readonly url: string
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  { id: 'deepseek', key: 'wtPresetDeepSeek', url: 'https://api.deepseek.com' },
  { id: 'openai', key: 'wtPresetOpenAI', url: 'https://api.openai.com/v1' },
  { id: 'claude', key: 'wtPresetClaude', url: 'https://api.anthropic.com/v1' },
  { id: 'custom', key: 'wtPresetCustom', url: '' },
]
