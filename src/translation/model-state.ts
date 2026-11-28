import { getTranslationConfig, type TranslationConfig, type TranslationModelConfig } from './config'
import { credentialOrigin, readApiKey, readCustomHeaders } from './secrets'

export interface ModelSnapshot {
  readonly config: TranslationConfig
  readonly apiKey: string
  readonly customHeaders?: Readonly<Record<string, string>>
  readonly revision: number
}

export function modelRequestConfig(snapshot: ModelSnapshot): TranslationModelConfig {
  return { ...snapshot.config, customHeaders: snapshot.customHeaders ?? {} }
}

let revision = 0
let mutationTail: Promise<unknown> = Promise.resolve()

export function currentRevision(): number {
  return revision
}

export function invalidateModelState(invalidate: () => void): void {
  revision += 1
  invalidate()
}

/** 只有传入 invalidate 才在任务开始前立即作废；否则由任务按实际变更决定作废范围。 */
export function serializeMutation(task: () => Promise<void>, invalidate?: () => void): Promise<void> {
  if (invalidate !== undefined) invalidateModelState(invalidate)
  const run = mutationTail.then(task, task)
  mutationTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function afterModelMutations(): Promise<void> {
  for (;;) {
    const pending = mutationTail
    await pending
    if (pending === mutationTail) return
  }
}

export async function readConsistentModelState<T>(
  read: (config: TranslationConfig, revision: number) => Promise<T>,
): Promise<T> {
  for (;;) {
    const pending = mutationTail
    await pending
    if (pending !== mutationTail) continue
    const rev = revision
    try {
      const config = await getTranslationConfig()
      const value = await read(config, rev)
      if (pending === mutationTail && rev === revision) return value
    } catch (error) {
      if (pending === mutationTail && rev === revision) throw error
    }
  }
}

type ModelScene = 'page' | 'selection' | 'text' | 'input'

export function sceneProfile(config: TranslationConfig, scene: ModelScene) {
  return scene === 'page' ? undefined : config.modelProfiles.find((profile) => profile.id === config.selectionProfileId)
}

export function modelSnapshot(scene: ModelScene = 'page'): Promise<ModelSnapshot> {
  return readConsistentModelState(async (config, revision) => {
    const snapshot = resolveSceneSnapshot({ config, revision, apiKey: '', customHeaders: {} }, scene)
    if (config.baseUrl === '' || credentialOrigin(config.baseUrl) !== credentialOrigin(snapshot.config.baseUrl)) return snapshot
    return {
      ...snapshot,
      apiKey: await readApiKey(config.baseUrl),
      customHeaders: config.customHeadersRevision === '' ? {} : await readCustomHeaders(config.baseUrl, config.customHeadersRevision),
    }
  })
}

/** 划词、输入和独立窗口使用选定的配置档，凭据仅在来源相同的接口间复用。 */
export function resolveSceneSnapshot(
  snapshot: ModelSnapshot,
  scene: ModelScene,
): ModelSnapshot {
  const profile = sceneProfile(snapshot.config, scene)
  if (!profile) return snapshot
  const sameOrigin = credentialOrigin(profile.baseUrl) === credentialOrigin(snapshot.config.baseUrl)
  // 本机只保存一套来源绑定的凭据。其他来源的配置档可以使用匿名接口。
  return {
    ...snapshot,
    apiKey: sameOrigin ? snapshot.apiKey : '',
    customHeaders: sameOrigin ? snapshot.customHeaders ?? {} : {},
    config: {
      ...snapshot.config,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiType: profile.apiType,
      temperature: profile.temperature,
      ...(sameOrigin ? {} : { customHeadersRevision: '', requestParams: {} }),
    },
  }
}
