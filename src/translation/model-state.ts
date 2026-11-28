import { getTranslationConfig, type TranslationConfig, type TranslationModelConfig } from './config'
import { readApiKey, readCustomHeaders } from './secrets'

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

export function modelSnapshot(): Promise<ModelSnapshot> {
  return readConsistentModelState(async (config, revision) => ({
    config,
    apiKey: config.baseUrl === '' ? '' : await readApiKey(config.baseUrl),
    customHeaders:
      config.baseUrl === '' || config.customHeadersRevision === ''
        ? {}
        : await readCustomHeaders(config.baseUrl, config.customHeadersRevision),
    revision,
  }))
}

/** 若用户为划词/独立窗口指定了独立模型配置档且存在有效凭据，则返回覆盖后的快照。 */
export async function resolveSceneSnapshot(
  snapshot: ModelSnapshot,
  scene: 'page' | 'selection' | 'text',
): Promise<ModelSnapshot> {
  if (scene === 'page') return snapshot
  const targetId = snapshot.config.selectionProfileId
  if (targetId === '') return snapshot
  const profile = snapshot.config.modelProfiles.find((item) => item.id === targetId)
  if (!profile) return snapshot
  const sameOrigin = profile.baseUrl === snapshot.config.baseUrl
  const apiKey = sameOrigin ? snapshot.apiKey : await readApiKey(profile.baseUrl)
  return {
    ...snapshot,
    apiKey,
    config: {
      ...snapshot.config,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiType: profile.apiType,
      temperature: profile.temperature,
    },
  }
}
