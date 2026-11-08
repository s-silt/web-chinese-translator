import { computed, onScopeDispose, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import { downloadText } from '../../components/download'
import { createToastSource } from '../../components/toast'
import type { MessageKey } from '../../i18n'
import {
  EXPORT_FILE_NAME,
  addEntry,
  editEntry,
  filterEntries,
  mergeEntries,
  normalizeEntry,
  parseCustomEntriesJson,
  previewImport,
  removeEntry,
  serializeEntries,
  type EntryEditResult,
  type EntryPair,
  type ImportPreview,
} from '../../shared/custom-entries'
import { getCustomEntries, setCustomEntries, watchCustomEntries, type CustomEntries } from '../../shared/settings'
import { sendToBackground } from '../../shared/tab-messages'

export interface UseCustomEntries {
  readonly entries: Readonly<Ref<CustomEntries>>
  /** 搜索词 */
  readonly query: Ref<string>
  /** 筛选后的词条，新添加的在前 */
  readonly rows: ComputedRef<EntryPair[]>
  readonly total: ComputedRef<number>
  /** 读取存储失败、之后也没收到词条：列表为空时显示加载失败 */
  readonly loadFailed: Readonly<Ref<boolean>>
  /** 列表行的键：改原文后沿用原来的键，同一行就地更新，焦点与同行未提交的输入都保留 */
  rowKey(source: string): number
  add(source: string, target: string): Promise<boolean>
  edit(original: string, source: string, target: string): Promise<boolean>
  remove(source: string): Promise<boolean>
  importText(text: string): Promise<boolean>
  importFile(file: Blob): Promise<boolean>
  /** 待确认导入的预览；没有待确认导入时为 undefined。随词条变化实时重算 */
  readonly importPreview: ComputedRef<ImportPreview | undefined>
  /** 确认导入：overwrite 为 false 时只写入新增词条 */
  confirmImport(overwrite: boolean): Promise<boolean>
  cancelImport(): void
  exportFile(): void
}

const RESULT_MESSAGE: Readonly<Record<'invalid' | 'exists', MessageKey>> = {
  invalid: 'invalidFormat',
  exists: 'exists',
}

/** 请后台通知已打开的 GitHub 页面重新读取词条；失败时这些页面刷新后才用上新词条 */
function notifySaved(): void {
  sendToBackground({ type: 'gcn:custom-entries-saved' }).catch(() => undefined)
}

/**
 * 自定义词条管理。操作结果（已导入、已存在、格式错误、保存失败、读取失败）在页面顶部提示。
 * 须在组件 setup 或 effectScope 内调用
 */
export function useCustomEntries(): UseCustomEntries {
  const entries = shallowRef<CustomEntries>({})
  const query = ref('')
  const loadFailed = ref(false)
  const toast = createToastSource()
  /** 已解析、待用户确认的导入内容 */
  const pending = shallowRef<CustomEntries>()
  let changed = false

  const stopWatch = watchCustomEntries((next) => {
    changed = true
    loadFailed.value = false
    entries.value = next
  })
  onScopeDispose(stopWatch)

  getCustomEntries().then(
    (value) => {
      if (!changed) entries.value = value
    },
    () => {
      if (!changed) loadFailed.value = true
    },
  )

  const rows = computed(() => filterEntries(entries.value, query.value))
  const total = computed(() => Object.keys(entries.value).length)
  const importPreview = computed<ImportPreview | undefined>(() =>
    pending.value === undefined ? undefined : previewImport(entries.value, pending.value),
  )

  const rowIds = new Map<string, number>()
  let nextRowId = 0

  function rowKey(source: string): number {
    let id = rowIds.get(source)
    if (id === undefined) {
      id = nextRowId++
      rowIds.set(source, id)
    }
    return id
  }

  async function save(next: CustomEntries): Promise<boolean> {
    try {
      changed = true
      entries.value = await setCustomEntries(next)
      loadFailed.value = false
      notifySaved()
      return true
    } catch {
      toast.show('danger', 'saveFailed')
      return false
    }
  }

  async function apply(result: EntryEditResult): Promise<boolean> {
    if (!result.ok) {
      toast.show('danger', RESULT_MESSAGE[result.reason])
      return false
    }
    toast.clear()
    return save(result.entries)
  }

  function add(source: string, target: string): Promise<boolean> {
    return apply(addEntry(entries.value, source, target))
  }

  async function edit(original: string, source: string, target: string): Promise<boolean> {
    const result = editEntry(entries.value, original, source, target)
    const renamed = result.ok ? normalizeEntry(source, target)?.[0] : undefined
    if (renamed === undefined || renamed === original) return apply(result)
    // 保存期间新旧原文共用一个键：保存前（列表仍是原文）、保存后（列表换成新原文）渲染的都是原来那一行
    rowIds.set(renamed, rowKey(original))
    const saved = await apply(result)
    rowIds.delete(saved ? original : renamed)
    return saved
  }

  function remove(source: string): Promise<boolean> {
    toast.clear()
    return save(removeEntry(entries.value, source))
  }

  /** 解析导入文件：全部与现有相同时直接提示，否则进入待确认预览，不写存储 */
  async function importText(text: string): Promise<boolean> {
    // 开始处理新文件即作废上一轮预览
    pending.value = undefined
    const imported = parseCustomEntriesJson(text)
    if (!imported) {
      toast.show('danger', 'invalidFormat')
      return false
    }
    const preview = previewImport(entries.value, imported)
    if (preview.added.length === 0 && preview.changed.length === 0) {
      toast.show('success', 'importNothing', { count: preview.unchanged })
      return true
    }
    pending.value = imported
    toast.clear()
    return true
  }

  async function confirmImport(overwrite: boolean): Promise<boolean> {
    const current = pending.value
    if (current === undefined) return false
    // 按确认这一刻的词条算条数：保存后 entries 已是合并结果，再算会全部相同
    const preview = previewImport(entries.value, current)
    if (!(await save(mergeEntries(entries.value, current, overwrite)))) return false
    pending.value = undefined
    toast.show('success', 'imported', {
      count: overwrite ? preview.added.length + preview.changed.length : preview.added.length,
    })
    return true
  }

  function cancelImport(): void {
    pending.value = undefined
    toast.clear()
  }

  async function importFile(file: Blob): Promise<boolean> {
    pending.value = undefined
    let text: string
    try {
      text = await file.text()
    } catch {
      toast.show('danger', 'readFailed')
      return false
    }
    return importText(text)
  }

  function exportFile(): void {
    downloadText(EXPORT_FILE_NAME, serializeEntries(entries.value))
  }

  return {
    entries,
    query,
    rows,
    total,
    loadFailed,
    rowKey,
    add,
    edit,
    remove,
    importText,
    importFile,
    importPreview,
    confirmImport,
    cancelImport,
    exportFile,
  }
}
