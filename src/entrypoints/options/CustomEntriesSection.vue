<template>
  <section class="section" aria-labelledby="entries-title">
    <div class="section-head">
      <h2 id="entries-title" class="section-title">{{ t('customEntries') }}</h2>
      <div class="section-tools">
        <UiButton size="sm" @click="fileInput?.click()">{{ t('import') }}</UiButton>
        <UiButton size="sm" :disabled="total === 0" @click="exportFile">{{ t('export') }}</UiButton>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          data-test="import-file"
          @change="onFileChange"
        />
      </div>
    </div>

    <div
      v-if="importPreview"
      ref="previewBox"
      class="import-preview"
      role="region"
      aria-labelledby="import-preview-title"
      data-test="import-preview"
    >
      <h3 id="import-preview-title" class="import-preview-title">{{ t('importPreview') }}</h3>
      <p class="import-summary" data-test="import-summary">
        {{
          t('importSummary', {
            added: importPreview.added.length,
            changed: importPreview.changed.length,
            unchanged: importPreview.unchanged,
          })
        }}
      </p>
      <ul class="import-list">
        <li
          v-for="row in shownPreviewRows"
          :key="`${row.kind}:${row.source}`"
          class="import-row"
          data-test="import-preview-row"
        >
          <span class="import-source">{{ row.source }}</span>
          <del v-if="row.kind === 'changed'" class="import-old">{{ row.from }}</del>
          <span class="import-arrow" aria-hidden="true">→</span>
          <span class="import-target">{{ row.to }}</span>
        </li>
        <li v-if="previewMore > 0" class="import-more">{{ t('importMore', { count: previewMore }) }}</li>
      </ul>
      <div class="import-actions">
        <UiButton variant="primary" data-test="import-confirm" @click="onConfirmImport(true)">
          {{ t('importConfirm') }}
        </UiButton>
        <UiButton
          v-if="importPreview.changed.length > 0"
          :disabled="importPreview.added.length === 0"
          data-test="import-added-only"
          @click="onConfirmImport(false)"
        >
          {{ t('importAddedOnly') }}
        </UiButton>
        <UiButton data-test="import-cancel" @click="cancelImport">{{ t('cancel') }}</UiButton>
      </div>
    </div>

    <form class="entry-form" @submit.prevent="onAdd">
      <UiInput ref="sourceInput" v-model="source" :aria-label="t('source')" :placeholder="t('source')" />
      <UiInput v-model="target" :aria-label="t('target')" :placeholder="t('target')" />
      <UiButton type="submit" variant="primary" :disabled="!canAdd">{{ t('add') }}</UiButton>
    </form>

    <UiInput ref="searchInput" v-model="query" type="search" :aria-label="t('search')" :placeholder="t('search')" />

    <div v-if="rows.length > 0" ref="viewport" class="entries-viewport">
      <table class="entries" :aria-rowcount="rows.length + 1">
        <thead>
          <tr aria-rowindex="1">
            <th scope="col">{{ t('source') }}</th>
            <th scope="col">{{ t('target') }}</th>
            <th scope="col">
              <span class="sr-only">{{ t('actions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in items" :key="item.kind === 'row' ? rowKey(item.data[0]) : item.key">
            <tr v-if="item.kind === 'gap'" class="entries-gap" aria-hidden="true">
              <td colspan="3" :style="{ height: `${item.height}px` }"></td>
            </tr>
            <CustomEntryRow v-else :entry="item.data" :index="item.index" @edit="onEdit" @remove="onRemove" />
          </template>
        </tbody>
      </table>
    </div>
    <p v-else class="blankslate" data-test="entries-empty">{{ t(emptyMessage) }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import UiButton from '../../components/ui/UiButton.vue'
import UiInput from '../../components/ui/UiInput.vue'
import { useI18n } from '../../components/ui-preferences'
import { useVirtualList } from '../../components/useVirtualList'
import type { MessageKey } from '../../i18n'
import { normalizeEntry, type EntryField, type EntryPair } from '../../shared/custom-entries'
import CustomEntryRow from './CustomEntryRow.vue'
import { useCustomEntries } from './useCustomEntries'

/** 行高估计：单元格上下内边距 12 + 输入框 32；实际行高（如触屏加高的控件）渲染后测量 */
const ROW_HEIGHT = 44

const { t } = useI18n()
const {
  query,
  rows,
  total,
  loadFailed,
  rowKey,
  add,
  edit,
  remove,
  importFile,
  importPreview,
  confirmImport,
  cancelImport,
  exportFile,
} = useCustomEntries()

const source = ref('')
const target = ref('')
const sourceInput = useTemplateRef<InstanceType<typeof UiInput>>('sourceInput')
const searchInput = useTemplateRef<InstanceType<typeof UiInput>>('searchInput')
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const viewport = useTemplateRef<HTMLElement>('viewport')
const { items, scrollToTop, pin } = useVirtualList({
  source: rows,
  viewport,
  estimatedHeight: ROW_HEIGHT,
  keyOf: (row) => rowKey(row[0]),
})

// 搜索结果从头显示
watch(query, () => scrollToTop())

const canAdd = computed(() => source.value.trim() !== '' && target.value.trim() !== '')

/** 预览明细最多列出的行数，超出折叠为「另有 N 条」 */
const PREVIEW_ROW_LIMIT = 100

interface PreviewRow {
  readonly kind: 'added' | 'changed'
  readonly source: string
  readonly from?: string
  readonly to: string
}

/** 先覆盖项后新增项，与导入文件的键顺序一致 */
const previewRows = computed<PreviewRow[]>(() => {
  const preview = importPreview.value
  if (preview === undefined) return []
  return [
    ...preview.changed.map((item) => ({ kind: 'changed' as const, source: item.source, from: item.from, to: item.to })),
    ...preview.added.map(([source, to]) => ({ kind: 'added' as const, source, to })),
  ]
})
const shownPreviewRows = computed(() => previewRows.value.slice(0, PREVIEW_ROW_LIMIT))
const previewMore = computed(() => previewRows.value.length - shownPreviewRows.value.length)

const previewBox = useTemplateRef<HTMLElement>('previewBox')

// 预览打开时把焦点移到「确认导入」；词条变化引起的重算不抢焦点
watch(
  importPreview,
  async (preview, before) => {
    if (preview === undefined || before !== undefined) return
    await nextTick()
    previewBox.value?.querySelector<HTMLElement>('[data-test="import-confirm"]')?.focus()
  },
)

/** 确认导入成功后新词条排在最前 */
async function onConfirmImport(overwrite: boolean): Promise<void> {
  if (await confirmImport(overwrite)) scrollToTop()
}

/** 列表为空时：没有词条（或读取失败），或搜索无结果 */
const emptyMessage = computed<MessageKey>(() => {
  if (total.value > 0) return 'notFound'
  return loadFailed.value ? 'loadFailed' : 'noEntries'
})

async function onAdd(): Promise<void> {
  if (!canAdd.value) return
  if (!(await add(source.value, target.value))) return
  source.value = ''
  target.value = ''
  // 新词条在最前
  scrollToTop()
  sourceInput.value?.focus()
}

/** 行内编辑：成功显示规范化后的值，失败恢复原值 */
async function onEdit(event: Event, row: EntryPair, field: EntryField): Promise<void> {
  const input = event.target as HTMLInputElement
  const [oldSource, oldTarget] = row
  const source = field === 'source' ? input.value : oldSource
  const target = field === 'target' ? input.value : oldTarget
  const pair = (await edit(oldSource, source, target)) ? normalizeEntry(source, target) : undefined
  input.value = field === 'source' ? (pair?.[0] ?? oldSource) : (pair?.[1] ?? oldTarget)
}

/**
 * 删除。焦点原在列表里（键盘操作；Chromium 点击按钮也会聚焦）时，移到原位置这一条（原来的下一条，没有时上一条）的删除按钮；
 * 删空时移到搜索框（有搜索词时）或添加表单。不移的话焦点随被删的行落到页面开头
 */
async function onRemove(removed: string): Promise<void> {
  const index = rows.value.findIndex(([key]) => key === removed)
  const hadFocus = viewport.value?.contains(document.activeElement) ?? false
  if (!(await remove(removed)) || !hadFocus) return
  await nextTick()
  if (rows.value.length === 0) {
    const input = query.value.trim() === '' ? sourceInput.value : searchInput.value
    input?.focus()
    return
  }
  const next = Math.min(index, rows.value.length - 1)
  // 这一条可能不在渲染范围内（键盘滚开后删除）：先保留渲染，聚焦时浏览器把它滚入视野
  pin(next)
  await nextTick()
  viewport.value?.querySelector<HTMLElement>(`[data-index="${next}"] .entry-action button`)?.focus()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空以便重复选择同一文件
  input.value = ''
  // 解析后先显示预览，确认时才写入（见 onConfirmImport）
  if (file) await importFile(file)
}
</script>

<style scoped>
.section-tools {
  display: flex;
  gap: 8px;
}

/* 两列可收窄到 0：输入框的固有宽度不撑开表单，窄屏（如 Firefox Android）不横向溢出 */
.entry-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
}

/* 列表限高（约 10 行），超出时在框内滚动；圆角裁切表头与悬停底色 */
.entries-viewport {
  /* 表头高度：键盘切换焦点时滚动留出这段，行不被固定的表头遮住 */
  --entries-head: 36px;
  max-height: min(480px, 60vh);
  overflow-y: auto;
  /* 虚拟列表替换行与占位时不做滚动锚定，滚动位置不跳 */
  overflow-anchor: none;
  scroll-padding-top: var(--entries-head);
  border: 1px solid var(--gcn-border);
  border-radius: var(--gcn-radius-lg);
}

.entries {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

.entries th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: var(--entries-head);
  /* 与单元格内输入框的文字对齐：td 内边距 8 + 边框 1 + 输入框内边距 12 */
  padding: 0 8px 0 21px;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  color: var(--gcn-fg-muted);
  background: var(--gcn-bg-muted);
  border-bottom: 1px solid var(--gcn-border);
}

/* 未渲染行的占位（数据行的样式见 CustomEntryRow.vue） */
.entries-gap td {
  padding: 0;
}

.blankslate {
  padding: 32px 16px;
  text-align: center;
  color: var(--gcn-fg-muted);
  background: var(--gcn-bg-muted);
  border: 1px dashed var(--gcn-border);
  border-radius: var(--gcn-radius-lg);
}

/* 导入预览：确认前不写入存储 */
.import-preview {
  display: grid;
  gap: 8px;
  padding: 12px;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border);
  border-radius: var(--gcn-radius-lg);
}

.import-preview-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.import-summary {
  margin: 0;
  font-size: 13px;
  color: var(--gcn-fg-muted);
}

/* 明细限高，超出框内滚动 */
.import-list {
  max-height: 160px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.import-list > li + li {
  border-top: 1px solid var(--gcn-border-muted);
}

.import-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  padding: 4px 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.import-row > * {
  min-width: 0;
}

.import-old,
.import-arrow,
.import-more {
  color: var(--gcn-fg-muted);
}

.import-more {
  padding: 4px 0;
  font-size: 12px;
}

.import-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
