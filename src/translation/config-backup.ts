import { sanitizeTranslationConfig, type TranslationConfig } from './config'

export const CONFIG_BACKUP_VERSION = 1

export interface ConfigBackupPayload {
  readonly version: typeof CONFIG_BACKUP_VERSION
  readonly exportedAt: string
  readonly excludesSecrets: true
  readonly config: Omit<TranslationConfig, 'customHeadersRevision'>
}

export type ConfigBackupParseResult =
  | { readonly ok: true; readonly config: TranslationConfig }
  | { readonly ok: false; readonly error: string }

/** 导出不含 API Key 与自定义请求头凭据的纯配置文件 JSON。 */
export function exportConfigBackup(config: TranslationConfig, now: Date = new Date()): string {
  const sanitized = sanitizeTranslationConfig(config)
  const { customHeadersRevision: _ignored, ...safeConfig } = sanitized
  const payload: ConfigBackupPayload = {
    version: CONFIG_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    excludesSecrets: true,
    config: safeConfig,
  }
  return JSON.stringify(payload, null, 2)
}

/** 解析并清洗导入的配置 JSON，拒绝超大文件或非法结构，确保不引入未知字段或凭据。 */
export function parseConfigBackup(raw: string): ConfigBackupParseResult {
  if (raw.length > 256_000) return { ok: false, error: '配置文件体积过大（上限 256 KB）' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: '配置文件不是有效的 JSON 格式' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '配置文件格式不正确' }
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== CONFIG_BACKUP_VERSION || typeof record.config !== 'object' || record.config === null) {
    return { ok: false, error: '不支持的配置备份版本或缺少 config 字段' }
  }
  const next = sanitizeTranslationConfig({ ...(record.config as Record<string, unknown>), customHeadersRevision: '' })
  return { ok: true, config: next }
}
