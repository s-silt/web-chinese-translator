import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { createToastSource } from '../../components/toast'
import { useSettings } from '../../components/useSettings'
import { excludedPathProbe, matchExcludedPath, parseExcludedPaths } from '../../shared/settings'

/** 排除规则测试的网址判定结果 */
export type ExcludedPathProbeResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'excluded'; readonly path: string; readonly pattern: string }
  | { readonly kind: 'included'; readonly path: string }

export interface UseExcludedPaths {
  /** 文本框内容，每行一条 */
  readonly text: Ref<string>
  /** 上次保存时格式错误：文本框标红，输入后清除 */
  readonly invalid: Readonly<Ref<boolean>>
  /** 测试框内容，不持久化 */
  readonly probe: Ref<string>
  /** 测试网址按文本框当前内容（含未保存修改）实时判定 */
  readonly probeResult: ComputedRef<ExcludedPathProbeResult>
  /** 用户输入后调用：停止跟随存储变化，清除错误标记与提示 */
  markDirty(): void
  /** 保存；结果（已保存、格式错误、保存失败）在页面顶部提示 */
  save(): Promise<void>
}

/** 排除路径编辑。须在组件 setup 或 effectScope 内调用 */
export function useExcludedPaths(): UseExcludedPaths {
  const { settings, update } = useSettings()
  const toast = createToastSource()
  const text = ref('')
  const invalid = ref(false)
  const probe = ref('')
  let dirty = false

  // 未编辑时跟随存储（如在弹出页排除了某页）
  watch(
    () => settings.value.excludedPaths,
    (paths) => {
      if (!dirty) text.value = paths.join('\n')
    },
    { immediate: true },
  )

  const probeResult = computed<ExcludedPathProbeResult>(() => {
    if (probe.value.trim() === '') return { kind: 'empty' }
    const path = excludedPathProbe(probe.value)
    if (path === undefined) return { kind: 'invalid' }
    const pattern = matchExcludedPath(path, parseExcludedPaths(text.value).paths)
    return pattern === undefined ? { kind: 'included', path } : { kind: 'excluded', path, pattern }
  })

  function markDirty(): void {
    dirty = true
    invalid.value = false
    toast.clear()
  }

  async function save(): Promise<void> {
    const parsed = parseExcludedPaths(text.value)
    if (parsed.invalid.length > 0) {
      invalid.value = true
      toast.show('danger', 'invalidFormat')
      return
    }
    if (!(await update({ excludedPaths: parsed.paths }))) {
      toast.show('danger', 'saveFailed')
      return
    }
    dirty = false
    invalid.value = false
    text.value = parsed.paths.join('\n')
    toast.show('success', 'saved')
  }

  return { text, invalid, probe, probeResult, markDirty, save }
}
