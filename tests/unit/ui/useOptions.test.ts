import { fakeBrowser } from 'wxt/testing/fake-browser'
import { REVOKE_DELAY_MS, downloadText } from '../../../src/components/download'
import { clearToasts } from '../../../src/components/toast'
import { useSettings } from '../../../src/components/useSettings'
import { useCustomEntries } from '../../../src/entrypoints/options/useCustomEntries'
import { useExcludedPaths } from '../../../src/entrypoints/options/useExcludedPaths'
import { EXPORT_FILE_NAME } from '../../../src/shared/custom-entries'
import {
  DEFAULT_SETTINGS,
  customEntriesItem,
  getCustomEntries,
  getSettings,
  settingsItem,
  updateSettings,
} from '../../../src/shared/settings'
import { settle, shownToasts, withScope, type Scoped } from './helpers'

const stops: Array<() => void> = []

/** 在作用域内运行，用例结束时停止（共用的设置随最后一个使用者释放，不带到下一个用例） */
function track<T>(factory: () => T): Scoped<T> {
  const scope = withScope(factory)
  stops.push(scope.stop)
  return scope
}

function scoped<T>(factory: () => T): T {
  return track(factory).result
}

function failStorage(area: 'sync' | 'local', method: 'get' | 'set'): void {
  vi.spyOn(fakeBrowser.storage[area], method).mockRejectedValue(new Error('存储不可用'))
}

/** 拦截下载：返回导出的文本 */
function captureDownload(): { readonly text: () => Promise<string>; readonly click: ReturnType<typeof vi.fn> } {
  let blob: Blob | undefined
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blob = value as Blob
    return 'blob:github-chinese/export'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const click = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    click(this.download, this.href)
  })
  return {
    text: async () => {
      if (!blob) throw new Error('未下载')
      return blob.text()
    },
    click,
  }
}

beforeEach(() => {
  fakeBrowser.reset()
})

afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  clearToasts()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useSettings', () => {
  it('读取存储并跟随变化', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, translateTime: false })
    const { settings, loaded, ready } = scoped(useSettings)
    expect(loaded.value).toBe(false)
    expect(ready.value).toBe(false)
    await settle()
    expect(loaded.value).toBe(true)
    expect(ready.value).toBe(true)
    expect(settings.value.translateTime).toBe(false)

    await updateSettings({ translateTitle: false })
    await settle()
    expect(settings.value.translateTitle).toBe(false)
  })

  it('写入成功返回 true', async () => {
    const { settings, update } = scoped(useSettings)
    await settle()
    expect(await update({ translateTitle: false })).toBe(true)
    expect(settings.value.translateTitle).toBe(false)
    expect((await getSettings()).translateTitle).toBe(false)
  })

  it('连续写入不丢失', async () => {
    const { update } = scoped(useSettings)
    await settle()
    await Promise.all([update({ translateTime: false }), update({ translateTitle: false }), update({ enabled: false })])
    expect(await getSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      translateTime: false,
      translateTitle: false,
      enabled: false,
    })
  })

  it('写入失败返回 false，之后仍可写入', async () => {
    const { update } = scoped(useSettings)
    await settle()
    const set = vi.spyOn(fakeBrowser.storage.sync, 'set').mockRejectedValueOnce(new Error('配额'))
    expect(await update({ enabled: false })).toBe(false)
    expect(await update({ translateTime: false })).toBe(true)
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('读取失败', async () => {
    failStorage('sync', 'get')
    const { loadFailed, ready, settings } = scoped(useSettings)
    await settle()
    expect(loadFailed.value).toBe(true)
    expect(ready.value).toBe(true)
    expect(settings.value).toEqual(DEFAULT_SETTINGS)
  })

  it('同一页面内各处共用一份：只读一次存储，一处写入另一处立即可见，并发写入不互相覆盖', async () => {
    const get = vi.spyOn(fakeBrowser.storage.sync, 'get')
    const first = scoped(useSettings)
    const second = scoped(useSettings)
    await settle()
    expect(get).toHaveBeenCalledTimes(1)

    expect(await first.update({ translateTitle: false })).toBe(true)
    expect(second.settings.value.translateTitle).toBe(false)

    await Promise.all([first.update({ enabled: false }), second.update({ translateTime: false })])
    expect(await getSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
      translateTime: false,
      translateTitle: false,
    })
    expect(first.settings.value).toEqual(second.settings.value)
  })

  it('还有使用者时照常跟随；全部结束后停止监听，再次使用时重新读取', async () => {
    const first = track(useSettings)
    const second = track(useSettings)
    await settle()
    first.stop()
    await updateSettings({ translateTitle: false })
    await settle()
    expect(second.result.settings.value.translateTitle).toBe(false)

    second.stop()
    await updateSettings({ translateTitle: true })
    await settle()
    expect(second.result.settings.value.translateTitle).toBe(false)

    const get = vi.spyOn(fakeBrowser.storage.sync, 'get')
    const next = scoped(useSettings)
    await settle()
    expect(get).toHaveBeenCalledTimes(1)
    expect(next.settings.value.translateTitle).toBe(true)
  })
})

describe('useExcludedPaths', () => {
  it('载入现有规则，每行一条', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, excludedPaths: ['/settings', '/*/*/wiki'] })
    const { text } = scoped(useExcludedPaths)
    await settle()
    expect(text.value).toBe('/settings\n/*/*/wiki')
  })

  it('保存：去空行与重复，提示已保存', async () => {
    const { text, markDirty, save } = scoped(useExcludedPaths)
    await settle()
    text.value = ' /settings \n\n/**/wiki\n/settings'
    markDirty()
    await save()
    expect((await getSettings()).excludedPaths).toEqual(['/settings', '/**/wiki'])
    expect(text.value).toBe('/settings\n/**/wiki')
    expect(shownToasts()).toEqual([{ tone: 'success', key: 'saved' }])
  })

  it('格式错误时不保存：标记错误并提示；再输入时清除', async () => {
    const { text, invalid, markDirty, save } = scoped(useExcludedPaths)
    await settle()
    text.value = '/ok\nsettings'
    markDirty()
    await save()
    expect(invalid.value).toBe(true)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'invalidFormat' }])
    expect((await getSettings()).excludedPaths).toEqual([])

    markDirty()
    expect(invalid.value).toBe(false)
    expect(shownToasts()).toEqual([])
  })

  it('写入失败 → 保存失败', async () => {
    const { text, invalid, save } = scoped(useExcludedPaths)
    await settle()
    failStorage('sync', 'set')
    text.value = '/settings'
    await save()
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'saveFailed' }])
    expect(invalid.value).toBe(false)
  })

  it('未编辑时跟随存储，编辑后保留输入', async () => {
    const { text, markDirty } = scoped(useExcludedPaths)
    await settle()
    await updateSettings({ excludedPaths: ['/a'] })
    await settle()
    expect(text.value).toBe('/a')

    text.value = '/draft'
    markDirty()
    await updateSettings({ excludedPaths: ['/b'] })
    await settle()
    expect(text.value).toBe('/draft')
  })

  it('保存后恢复跟随：之后其他页面写入（如弹出页排除此页）时同步', async () => {
    const { text, markDirty, save } = scoped(useExcludedPaths)
    await settle()
    text.value = '/settings'
    markDirty()
    await save()
    await updateSettings({ excludedPaths: ['/settings', '/vuejs/core/issues'] })
    await settle()
    expect(text.value).toBe('/settings\n/vuejs/core/issues')
  })

  it('probeResult：按文本框当前规则（含未保存）实时判定测试网址', async () => {
    const { text, probe, probeResult } = scoped(useExcludedPaths)
    await settle()
    probe.value = 'https://github.com/vuejs/core/wiki'
    await settle()
    expect(probeResult.value).toEqual({ kind: 'included', path: '/vuejs/core/wiki' })

    // 未保存的修改立即生效
    text.value = '/*/*/wiki'
    await settle()
    expect(probeResult.value).toEqual({ kind: 'excluded', path: '/vuejs/core/wiki', pattern: '/*/*/wiki' })

    // 路径输入去查询与片段
    probe.value = '/vuejs/core/settings?tab=x#frag'
    await settle()
    expect(probeResult.value).toEqual({ kind: 'included', path: '/vuejs/core/settings' })
  })

  it('probeResult：空输入提示、无法识别标为无效', async () => {
    const { probe, probeResult } = scoped(useExcludedPaths)
    await settle()
    expect(probeResult.value).toEqual({ kind: 'empty' })
    probe.value = '   '
    await settle()
    expect(probeResult.value).toEqual({ kind: 'empty' })
    probe.value = 'example.com/x'
    await settle()
    expect(probeResult.value).toEqual({ kind: 'invalid' })
    probe.value = 'http://github.com/x'
    await settle()
    expect(probeResult.value).toEqual({ kind: 'invalid' })
  })
})

describe('useCustomEntries', () => {
  it('载入并按新旧排序、搜索', async () => {
    await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
    const { rows, total, query } = scoped(useCustomEntries)
    await settle()
    expect(total.value).toBe(2)
    expect(rows.value).toEqual([
      ['Issues', '议题'],
      ['Code', '代码'],
    ])
    query.value = 'code'
    expect(rows.value).toEqual([['Code', '代码']])
  })

  it('添加、修改、删除', async () => {
    const { entries, add, edit, remove } = scoped(useCustomEntries)
    await settle()

    expect(await add(' Pull  requests ', '拉取请求')).toBe(true)
    expect(await getCustomEntries()).toEqual({ 'Pull requests': '拉取请求' })

    expect(await edit('Pull requests', 'Pull requests', '合并请求')).toBe(true)
    expect(entries.value).toEqual({ 'Pull requests': '合并请求' })

    expect(await edit('Pull requests', 'PRs', '合并请求')).toBe(true)
    expect(await getCustomEntries()).toEqual({ PRs: '合并请求' })

    expect(await remove('PRs')).toBe(true)
    expect(await getCustomEntries()).toEqual({})
    expect(shownToasts()).toEqual([])
  })

  it('保存后通知后台转发给已打开的页面；未保存时不通知', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined as never)
    const { add } = scoped(useCustomEntries)
    await settle()
    expect(await add('Code', '代码')).toBe(true)
    expect(send).toHaveBeenCalledWith({ type: 'gcn:custom-entries-saved' })
    send.mockClear()
    expect(await add('Code', '源码')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('原文重复 → 已存在；空值 → 格式错误', async () => {
    await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
    const { add, edit } = scoped(useCustomEntries)
    await settle()

    expect(await add('Code', '源码')).toBe(false)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'exists' }])
    expect(await edit('Issues', 'Code', '议题')).toBe(false)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'exists' }])
    // 同一处的新提示替换旧的
    expect(await add('  ', '空')).toBe(false)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'invalidFormat' }])
    expect(await getCustomEntries()).toEqual({ Code: '代码', Issues: '议题' })
  })

  it('导入合法 JSON：先预览不写入，确认后合并并提示条数', async () => {
    await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
    const { importText, importPreview, confirmImport } = scoped(useCustomEntries)
    await settle()
    expect(await importText('{"Issues": "问题", "Wiki": "维基", "Bad": 1}')).toBe(true)
    // 解析成功但不写存储：Issues 译文不同算覆盖，Wiki 算新增
    expect(await getCustomEntries()).toEqual({ Code: '代码', Issues: '议题' })
    expect(importPreview.value?.added).toEqual([['Wiki', '维基']])
    expect(importPreview.value?.changed).toEqual([{ source: 'Issues', from: '议题', to: '问题' }])
    expect(shownToasts()).toEqual([])

    expect(await confirmImport(true)).toBe(true)
    expect(importPreview.value).toBeUndefined()
    expect(shownToasts()).toEqual([{ tone: 'success', key: 'imported', params: { count: 2 } }])
    expect(await getCustomEntries()).toEqual({ Code: '代码', Issues: '问题', Wiki: '维基' })
  })

  it('确认时只导入新增：已有原文保留现有译文', async () => {
    await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
    const { importText, confirmImport } = scoped(useCustomEntries)
    await settle()
    await importText('{"Issues": "问题", "Wiki": "维基"}')
    expect(await confirmImport(false)).toBe(true)
    expect(shownToasts()).toEqual([{ tone: 'success', key: 'imported', params: { count: 1 } }])
    expect(await getCustomEntries()).toEqual({ Code: '代码', Issues: '议题', Wiki: '维基' })
  })

  it('取消导入：不写入，预览消失', async () => {
    await customEntriesItem.setValue({ Code: '代码' })
    const { importText, importPreview, cancelImport } = scoped(useCustomEntries)
    await settle()
    await importText('{"Wiki": "维基"}')
    expect(importPreview.value).toBeDefined()
    cancelImport()
    expect(importPreview.value).toBeUndefined()
    expect(await getCustomEntries()).toEqual({ Code: '代码' })
  })

  it('全部相同：提示没有新词条，不进预览', async () => {
    await customEntriesItem.setValue({ Code: '代码' })
    const { importText, importPreview } = scoped(useCustomEntries)
    await settle()
    expect(await importText('{"Code": "代码"}')).toBe(true)
    expect(importPreview.value).toBeUndefined()
    expect(shownToasts()).toEqual([{ tone: 'success', key: 'importNothing', params: { count: 1 } }])
    expect(await getCustomEntries()).toEqual({ Code: '代码' })
  })

  it('预览打开期间词条被其他页面改动：预览实时重算，确认按最新词条合并', async () => {
    await customEntriesItem.setValue({ Code: '代码' })
    const { importText, importPreview, confirmImport } = scoped(useCustomEntries)
    await settle()
    await importText('{"Issues": "问题", "Wiki": "维基"}')
    expect(importPreview.value?.added).toHaveLength(2)

    // 另一个标签页先加了 Issues：预览里它从新增变为覆盖
    await customEntriesItem.setValue({ Code: '代码', Issues: '议题' })
    await settle()
    expect(importPreview.value?.added).toEqual([['Wiki', '维基']])
    expect(importPreview.value?.changed).toEqual([{ source: 'Issues', from: '议题', to: '问题' }])

    expect(await confirmImport(true)).toBe(true)
    expect(shownToasts()).toEqual([{ tone: 'success', key: 'imported', params: { count: 2 } }])
    expect(await getCustomEntries()).toEqual({ Code: '代码', Issues: '问题', Wiki: '维基' })
  })

  it('确认保存失败：保留预览可重试', async () => {
    await customEntriesItem.setValue({ Code: '代码' })
    const { importText, importPreview, confirmImport } = scoped(useCustomEntries)
    await settle()
    await importText('{"Wiki": "维基"}')
    failStorage('local', 'set')
    expect(await confirmImport(true)).toBe(false)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'saveFailed' }])
    expect(importPreview.value?.added).toEqual([['Wiki', '维基']])
  })

  it.each(['not json', '["Code"]', '{"Bad": 1}'])('导入 %j → 格式错误，不写入', async (text) => {
    await customEntriesItem.setValue({ Code: '代码' })
    const { importText, importPreview } = scoped(useCustomEntries)
    await settle()
    expect(await importText(text)).toBe(false)
    expect(importPreview.value).toBeUndefined()
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'invalidFormat' }])
    expect(await getCustomEntries()).toEqual({ Code: '代码' })
  })

  it('导入文件；坏 JSON 与读取失败照旧', async () => {
    const { importFile, confirmImport } = scoped(useCustomEntries)
    await settle()
    expect(await importFile(new File(['{"Code": "代码"}'], 'entries.json'))).toBe(true)
    expect(await confirmImport(true)).toBe(true)
    expect(shownToasts()).toEqual([{ tone: 'success', key: 'imported', params: { count: 1 } }])

    expect(await importFile(new File(['["Code"]'], 'bad.json'))).toBe(false)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'invalidFormat' }])

    const broken = new Blob([])
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('无法读取'))
    expect(await importFile(broken)).toBe(false)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'readFailed' }])
  })

  it('已有预览时再次导入：坏 JSON、读取失败与全同都作废旧预览，新文件确认只写新词条', async () => {
    await customEntriesItem.setValue({ Code: '代码' })
    const { importText, importFile, importPreview, confirmImport } = scoped(useCustomEntries)
    await settle()

    expect(await importText('{"Code": "源码"}')).toBe(true)
    expect(importPreview.value?.changed).toEqual([{ source: 'Code', from: '代码', to: '源码' }])

    expect(await importText('not json')).toBe(false)
    expect(importPreview.value).toBeUndefined()
    expect(await confirmImport(true)).toBe(false)
    expect(await getCustomEntries()).toEqual({ Code: '代码' })

    expect(await importText('{"Code": "源码"}')).toBe(true)
    const broken = new Blob([])
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('无法读取'))
    expect(await importFile(broken)).toBe(false)
    expect(importPreview.value).toBeUndefined()
    expect(await confirmImport(true)).toBe(false)
    expect(await getCustomEntries()).toEqual({ Code: '代码' })

    expect(await importText('{"Code": "源码"}')).toBe(true)
    expect(await importText('{"Code": "代码"}')).toBe(true)
    expect(importPreview.value).toBeUndefined()
    expect(shownToasts()).toEqual([{ tone: 'success', key: 'importNothing', params: { count: 1 } }])
    expect(await confirmImport(true)).toBe(false)
    expect(await getCustomEntries()).toEqual({ Code: '代码' })

    expect(await importText('{"Code": "源码"}')).toBe(true)
    expect(await importFile(new File(['{"Wiki": "维基"}'], 'b.json'))).toBe(true)
    expect(importPreview.value?.added).toEqual([['Wiki', '维基']])
    expect(importPreview.value?.changed).toEqual([])
    expect(await confirmImport(true)).toBe(true)
    expect(await getCustomEntries()).toEqual({ Code: '代码', Wiki: '维基' })
  })

  it('导出为 JSON 文件', async () => {
    await customEntriesItem.setValue({ Code: '代码' })
    const download = captureDownload()
    const { exportFile } = scoped(useCustomEntries)
    await settle()
    exportFile()
    expect(download.click).toHaveBeenCalledWith(EXPORT_FILE_NAME, 'blob:github-chinese/export')
    expect(JSON.parse(await download.text())).toEqual({ Code: '代码' })
  })

  it('其他页面修改时同步', async () => {
    const { entries } = scoped(useCustomEntries)
    await settle()
    await customEntriesItem.setValue({ Wiki: '维基' })
    await settle()
    expect(entries.value).toEqual({ Wiki: '维基' })
  })

  it('读取失败 → 加载失败（状态，不弹提示）；写入失败 → 提示保存失败', async () => {
    failStorage('local', 'get')
    const { add, loadFailed } = scoped(useCustomEntries)
    await settle()
    expect(loadFailed.value).toBe(true)
    expect(shownToasts()).toEqual([])

    failStorage('local', 'set')
    expect(await add('Code', '代码')).toBe(false)
    expect(shownToasts()).toEqual([{ tone: 'danger', key: 'saveFailed' }])
    expect(loadFailed.value).toBe(true)
  })

  it('加载失败后收到词条（其他页面写入、本页保存成功）：不再算加载失败', async () => {
    failStorage('local', 'get')
    const first = scoped(useCustomEntries)
    await settle()
    expect(first.loadFailed.value).toBe(true)
    await customEntriesItem.setValue({ Wiki: '维基' })
    await settle()
    expect(first.loadFailed.value).toBe(false)
    expect(first.entries.value).toEqual({ Wiki: '维基' })

    const second = scoped(useCustomEntries)
    await settle()
    expect(second.loadFailed.value).toBe(true)
    expect(await second.add('Code', '代码')).toBe(true)
    expect(second.loadFailed.value).toBe(false)
  })
})

describe('downloadText', () => {
  it('创建链接下载并延迟释放对象 URL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const download = captureDownload()
    downloadText('a.json', '{}')
    expect(download.click).toHaveBeenCalledWith('a.json', 'blob:github-chinese/export')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:github-chinese/export')
    expect(await download.text()).toBe('{}')
  })
})
