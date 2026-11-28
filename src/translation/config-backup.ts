import { DEFAULT_TRANSLATION_CONFIG, normalizeBaseUrl, sanitizeTranslationConfig, type TranslationConfig } from './config'
import { isConfigShape, type TranslationConfigPatch } from './messages'

export const CONFIG_BACKUP_VERSION = 1
export const MAX_CONFIG_BACKUP_BYTES = 1024 * 1024

function portableSettings(config: TranslationConfig) {
  // 站点访问与快捷键由浏览器管理。自由格式请求参数可能嵌套第三方凭据。
  const {
    autoOrigins: _auto, siteScopeMode: _mode, siteScopeHosts: _scope, inputReplaceKey: _shortcut,
    customHeadersRevision: _headers, requestParams: _params, ...settings
  } = config
  return settings
}

export function configBackupPatch(imported: TranslationConfig, current: TranslationConfig): TranslationConfigPatch {
  const settings = portableSettings(imported)
  const previousOrigin = current.baseUrl === '' ? '' : new URL(current.baseUrl).origin
  const nextOrigin = settings.baseUrl === '' ? '' : new URL(settings.baseUrl).origin
  return previousOrigin === nextOrigin ? settings : { ...settings, requestParams: {} }
}

export interface ConfigBackupPayload {
  readonly version: typeof CONFIG_BACKUP_VERSION
  readonly exportedAt: string
  readonly excludesSecrets: true
  readonly config: ReturnType<typeof portableSettings>
}

export type ConfigBackupParseResult =
  | { readonly ok: true; readonly config: TranslationConfig }
  | { readonly ok: false; readonly error: string }

/** 导出不含 API Key 与自定义请求头凭据的纯配置文件 JSON。 */
export function exportConfigBackup(config: TranslationConfig, now: Date = new Date()): string {
  const sanitized = sanitizeTranslationConfig(config)
  const payload: ConfigBackupPayload = {
    version: CONFIG_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    excludesSecrets: true,
    config: portableSettings(sanitized),
  }
  return JSON.stringify(payload, null, 2)
}

/** 解析并清洗导入的配置 JSON，拒绝超大文件或非法结构，确保不引入未知字段或凭据。 */
export function parseConfigBackup(raw: string): ConfigBackupParseResult {
  if (raw.length > MAX_CONFIG_BACKUP_BYTES || new TextEncoder().encode(raw).byteLength > MAX_CONFIG_BACKUP_BYTES) {
    return { ok: false, error: '配置文件体积过大（上限 1 MiB）' }
  }
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
  if (record.version !== CONFIG_BACKUP_VERSION || typeof record.config !== 'object' || record.config === null || Array.isArray(record.config)) {
    return { ok: false, error: '不支持的配置备份版本或缺少 config 字段' }
  }
  const config = {
    ...record.config, autoOrigins: [], siteScopeHosts: [], siteScopeMode: DEFAULT_TRANSLATION_CONFIG.siteScopeMode,
    inputReplaceKey: DEFAULT_TRANSLATION_CONFIG.inputReplaceKey, customHeadersRevision: '', requestParams: {},
  }
  if (!isConfigShape(config) || (config.baseUrl !== '' && normalizeBaseUrl(config.baseUrl) === '')) {
    return { ok: false, error: '备份中的翻译配置不完整或无效' }
  }
  return { ok: true, config: sanitizeTranslationConfig(config) }
}
