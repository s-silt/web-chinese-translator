import { computed, onScopeDispose, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import { browser } from 'wxt/browser'
import { downloadText } from '../../components/download'
import { createToastSource } from '../../components/toast'
import { BUILTIN_DICTIONARY_META, hostMatchPattern, type DictionaryCategory } from '../../translation/dictionaries/index'
import {
  LIMITS,
  getCustomDictionaries,
  newCustomDictionaryId,
  parseDictionaryJson,
  parseEntryLines,
  serializeDictionary,
  serializeEntryLines,
  setCustomDictionaries,
  watchCustomDictionaries,
  type CustomDictionary,
} from '../../translation/custom-dictionaries'
import type { TranslationConfig } from '../../translation/config'
import type { TranslationConfigPatch } from '../../translation/messages'
import { sendTranslationMessage } from '../../translation/client'
import { normalizeExcludedHost } from '../../translation/page-policy'

export interface BuiltinRow {
  readonly id: string
  readonly label: string
  readonly hosts: string
  readonly category: DictionaryCategory
  readonly enabled: boolean
}

export interface CustomRow {
  readonly id: string
  readonly label: string
  readonly hosts: string
  readonly entryCount: number
  readonly enabled: boolean
}

export interface UseCustomDictionaries {
  readonly ready: Readonly<Ref<boolean>>
  readonly busy: Readonly<Ref<boolean>>
  readonly builtins: ComputedRef<BuiltinRow[]>
  readonly custom: Readonly<Ref<CustomDictionary[]>>
  readonly editing: Ref<string | 'new' | undefined>
  readonly draftLabel: Ref<string>
  readonly draftHosts: Ref<string>
  readonly draftEntries: Ref<string>
  setBuiltin(id: string, enabled: boolean): Promise<void>
  setCustomEnabled(id: string, enabled: boolean): Promise<void>
  startNew(): void
  startEdit(dictionary: CustomDictionary): void
  cancelEdit(): void
  saveDraft(): Promise<void>
  removeDictionary(id: string): Promise<void>
  exportDictionary(dictionary: CustomDictionary): void
  importFile(file: Blob): Promise<boolean>
}

const EXPORT_NAME = 'custom-dictionary.json'

async function requestOrigins(hosts: readonly string[]): Promise<boolean> {
  if (hosts.length === 0) return true
  try {
    return await browser.permissions.request({ origins: hosts.map(hostMatchPattern) })
  } catch {
    return false
  }
}

export function useCustomDictionaries(): UseCustomDictionaries {
  const ready = ref(false)
  const busy = ref(false)
  const disabledBuiltins = ref<readonly string[]>([])
  const custom = shallowRef<CustomDictionary[]>([])
  const editing = ref<string | 'new' | undefined>()
  const draftLabel = ref('')
  const draftHosts = ref('')
  const draftEntries = ref('')
  const toast = createToastSource()
  let changed = false

  const builtins = computed<BuiltinRow[]>(() =>
    BUILTIN_DICTIONARY_META.map((d) => ({
      id: d.id,
      label: d.label,
      hosts: d.hosts.join(', '),
      category: d.category,
      enabled: !disabledBuiltins.value.includes(d.id),
    })),
  )

  const stopWatch = watchCustomDictionaries((next) => {
    changed = true
    custom.value = next
  })
  onScopeDispose(stopWatch)

  Promise.all([
    sendTranslationMessage({ type: 'wt:get-config' }).catch(() => undefined),
    getCustomDictionaries().catch(() => undefined),
  ]).then(([reply, stored]) => {
    if (reply?.ok && reply.config !== undefined) disabledBuiltins.value = reply.config.disabledDictionaries
    if (stored !== undefined && !changed) custom.value = stored
    ready.value = true
  })

  async function saveConfigPatch(patch: TranslationConfigPatch): Promise<TranslationConfig | undefined> {
    const reply = await sendTranslationMessage({ type: 'wt:save-config', patch }).catch(() => undefined)
    return reply?.ok === true ? reply.config : undefined
  }

  async function setBuiltin(id: string, enabled: boolean): Promise<void> {
    if (busy.value) return
    const dictionary = BUILTIN_DICTIONARY_META.find((d) => d.id === id)
    if (dictionary === undefined) return
    busy.value = true
    try {
      if (enabled && !(await requestOrigins(dictionary.hosts))) {
        toast.show('danger', 'wtPermissionDenied')
        return
      }
      const disabled = disabledBuiltins.value.filter((x) => x !== id)
      const next = enabled ? disabled : [...disabled, id]
      const saved = await saveConfigPatch({ disabledDictionaries: next })
      if (saved === undefined) {
        toast.show('danger', 'saveFailed')
        return
      }
      disabledBuiltins.value = saved.disabledDictionaries
    } finally {
      busy.value = false
    }
  }

  async function persist(next: readonly CustomDictionary[]): Promise<boolean> {
    try {
      changed = true
      custom.value = await setCustomDictionaries(next)
      return true
    } catch {
      toast.show('danger', 'saveFailed')
      return false
    }
  }

  async function setCustomEnabled(id: string, enabled: boolean): Promise<void> {
    if (busy.value) return
    const dictionary = custom.value.find((d) => d.id === id)
    if (dictionary === undefined) return
    busy.value = true
    try {
      if (enabled && !(await requestOrigins(dictionary.hosts))) {
        toast.show('danger', 'wtPermissionDenied')
        return
      }
      await persist(custom.value.map((d) => (d.id === id ? { ...d, enabled } : d)))
    } finally {
      busy.value = false
    }
  }

  function startNew(): void {
    editing.value = 'new'
    draftLabel.value = ''
    draftHosts.value = ''
    draftEntries.value = ''
  }

  function startEdit(dictionary: CustomDictionary): void {
    editing.value = dictionary.id
    draftLabel.value = dictionary.label
    draftHosts.value = dictionary.hosts.join(', ')
    draftEntries.value = serializeEntryLines(dictionary.entries)
  }

  function cancelEdit(): void {
    editing.value = undefined
  }

  function parseHostInput(): string[] {
    const hosts: string[] = []
    for (const token of draftHosts.value.split(/[\s,]+/)) {
      if (token === '') continue
      const host = normalizeExcludedHost(token)
      if (host !== '' && !hosts.includes(host)) hosts.push(host)
    }
    return hosts
  }

  async function saveDraft(): Promise<void> {
    if (busy.value || editing.value === undefined) return
    const label = draftLabel.value.trim()
    const hosts = parseHostInput()
    const { entries, invalid } = parseEntryLines(draftEntries.value)
    if (label === '' || hosts.length === 0 || hosts.length > LIMITS.hosts ||
      Object.keys(entries).length > LIMITS.entries) {
      toast.show('danger', 'wtDictionaryLimit')
      return
    }
    if (invalid.length > 0) {
      toast.show('danger', 'wtDictionaryInvalidLines', { count: invalid.length })
      return
    }
    busy.value = true
    try {
      if (!(await requestOrigins(hosts))) {
        toast.show('danger', 'wtPermissionDenied')
        return
      }
      const existing = custom.value.find((d) => d.id === editing.value)
      const next: CustomDictionary = {
        id: existing?.id ?? newCustomDictionaryId(),
        label,
        hosts,
        entries,
        enabled: existing?.enabled ?? true,
      }
      const list = existing === undefined
        ? [...custom.value, next]
        : custom.value.map((d) => (d.id === existing.id ? next : d))
      if (list.length > LIMITS.dictionaries) {
        toast.show('danger', 'wtDictionaryLimit')
        return
      }
      if (await persist(list)) {
        editing.value = undefined
        toast.show('success', 'wtDictionarySaved')
      }
    } finally {
      busy.value = false
    }
  }

  async function removeDictionary(id: string): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      if (await persist(custom.value.filter((d) => d.id !== id))) {
        if (editing.value === id) editing.value = undefined
      }
    } finally {
      busy.value = false
    }
  }

  function exportDictionary(dictionary: CustomDictionary): void {
    downloadText(EXPORT_NAME, serializeDictionary(dictionary))
  }

  async function importFile(file: Blob): Promise<boolean> {
    let text: string
    try {
      text = await file.text()
    } catch {
      toast.show('danger', 'invalidFormat')
      return false
    }
    const draft = parseDictionaryJson(text)
    if (draft === undefined) {
      toast.show('danger', 'invalidFormat')
      return false
    }
    editing.value = 'new'
    draftLabel.value = draft.label
    draftHosts.value = draft.hosts.join(', ')
    draftEntries.value = serializeEntryLines(draft.entries)
    return true
  }

  return {
    ready, busy, builtins, custom, editing,
    draftLabel, draftHosts, draftEntries,
    setBuiltin, setCustomEnabled, startNew, startEdit, cancelEdit,
    saveDraft, removeDictionary, exportDictionary, importFile,
  }
}
