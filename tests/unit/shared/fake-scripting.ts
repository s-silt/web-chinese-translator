import { fakeBrowser } from 'wxt/testing/fake-browser'

/** 注册的内容脚本（只记测试关心的字段） */
export interface RegisteredScript {
  readonly id: string
  readonly matches?: readonly string[]
  readonly excludeMatches?: readonly string[]
  readonly js?: readonly string[]
  readonly runAt?: string
  readonly allFrames?: boolean
  /** 是否跨会话保留；测试直接放入、不带该字段的注册模拟不返回它的浏览器 */
  readonly persistAcrossSessions?: boolean
}

export interface FakeContentScripts {
  /** 注册表：测试可直接放入已有的注册 */
  readonly registered: RegisteredScript[]
  /** 模拟重启浏览器：只保留持久的注册 */
  restart(): void
  /** 模拟安装、更新扩展：清空全部注册（Chromium、Firefox 都是） */
  updateExtension(): void
}

/**
 * fakeBrowser 未实现动态内容脚本：用内存表模拟 scripting 的注册、查询、更新、注销。按 Chromium 的实现：
 * - 查询返回的 matches 按字符串排序、去重，并带 persistAcrossSessions；
 * - 注册不带 persistAcrossSessions 时持久，更新不带时改为仅本次会话（与文档不符）；
 * - 重复注册同一 ID、更新或注销未注册的 ID 时报错
 */
export function fakeContentScripts(): FakeContentScripts {
  const registered: RegisteredScript[] = []
  const has = (id: string): boolean => registered.some((script) => script.id === id)
  vi.spyOn(fakeBrowser.scripting, 'getRegisteredContentScripts').mockImplementation((async (filter?: {
    ids?: string[]
  }) =>
    registered
      .filter((script) => !filter?.ids || filter.ids.includes(script.id))
      .map((script) =>
        script.matches ? { ...script, matches: [...new Set(script.matches)].sort() } : script,
      )) as never)
  vi.spyOn(fakeBrowser.scripting, 'registerContentScripts').mockImplementation((async (scripts: RegisteredScript[]) => {
    for (const script of scripts) {
      if (has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`)
      registered.push({ ...script, persistAcrossSessions: script.persistAcrossSessions ?? true })
    }
  }) as never)
  vi.spyOn(fakeBrowser.scripting, 'updateContentScripts').mockImplementation((async (scripts: RegisteredScript[]) => {
    for (const script of scripts) {
      const index = registered.findIndex((item) => item.id === script.id)
      if (index < 0) throw new Error(`Nonexistent script ID '${script.id}'`)
      registered[index] = {
        ...registered[index]!,
        ...script,
        persistAcrossSessions: script.persistAcrossSessions ?? false,
      }
    }
  }) as never)
  vi.spyOn(fakeBrowser.scripting, 'unregisterContentScripts').mockImplementation((async (filter?: {
    ids?: string[]
  }) => {
    for (const id of filter?.ids ?? registered.map((script) => script.id)) {
      const index = registered.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`Nonexistent script ID '${id}'`)
      registered.splice(index, 1)
    }
  }) as never)
  return {
    registered,
    restart() {
      const kept = registered.filter((script) => script.persistAcrossSessions !== false)
      registered.splice(0, registered.length, ...kept)
    },
    updateExtension() {
      registered.splice(0)
    },
  }
}
