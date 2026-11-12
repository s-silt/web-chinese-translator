/** 输入翻译替换方式与自动替换等待时间；不依赖其他模块，供内容脚本直接引用 */
export type InputReplaceMode = 'auto'

export function isInputReplaceMode(value: unknown): value is InputReplaceMode {
  return value === 'auto'
}

export const INPUT_AUTO_REPLACE_DELAY_MIN = 500
export const INPUT_AUTO_REPLACE_DELAY_MAX = 10_000
export const INPUT_AUTO_REPLACE_DELAY_DEFAULT = 1000
export const INPUT_AUTO_REPLACE_DELAY_PRESETS = [1000, 2000, 3000, 5000] as const

export function isInputAutoReplaceDelay(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= INPUT_AUTO_REPLACE_DELAY_MIN &&
    value <= INPUT_AUTO_REPLACE_DELAY_MAX &&
    value % 100 === 0
  )
}
