<template>
  <span ref="root" class="ui-select" v-bind="attrs().root">
    <button
      :id="triggerId()"
      ref="trigger"
      v-bind="attrs().field"
      type="button"
      role="combobox"
      class="ui-field ui-select-trigger"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listboxId"
      :aria-activedescendant="activeId()"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
      @keyup.space.prevent
      @blur="hide"
    >
      <!-- 各选项叠在同一格里撑开宽度：与原生下拉一样取最长的选项，切换选项时宽度不变 -->
      <span class="ui-select-value">
        <span
          v-for="option in options"
          :key="option.value"
          class="ui-select-label ui-select-sizer"
          :lang="option.lang"
          aria-hidden="true"
        >
          {{ option.label }}
        </span>
        <span class="ui-select-label" :lang="selected?.lang">{{ selected?.label }}</span>
      </span>
      <svg class="ui-select-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <Transition name="ui-select-list">
      <ul
        v-show="open"
        :id="listboxId"
        ref="listbox"
        role="listbox"
        class="ui-select-list"
        :class="{ 'is-above': above, 'is-end': alignEnd, 'is-keyboard': keyboard }"
        :style="{ maxHeight }"
        v-bind="listName()"
        @mousedown.prevent
      >
        <!-- 控件常放在 <label> 里：选项点击阻止默认行为，否则标签会把点击转发给按钮，刚关上的列表又被打开 -->
        <li
          v-for="(option, index) in options"
          :id="optionId(index)"
          :key="option.value"
          role="option"
          class="ui-select-option"
          :class="{ 'is-active': index === active }"
          :lang="option.lang"
          :aria-selected="option.value === modelValue"
          @pointermove="activate(index, false)"
          @click.prevent="choose(index)"
        >
          <svg class="ui-select-check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M3.5 8.5l3 3 6-7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="ui-select-label">{{ option.label }}</span>
        </li>
      </ul>
    </Transition>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, useId, useTemplateRef, watch } from 'vue'
import { splitAttrs, type SplitAttrs } from './attrs'
import type { UiSelectOption } from './types'

/**
 * 下拉框：按钮 + 自绘的选项列表（WAI-ARIA 只选不输入的 combobox）。
 * 焦点始终留在按钮上，高亮项用 aria-activedescendant 指示。键盘：↑ ↓ Home End PageUp PageDown 移动高亮，
 * Enter、空格、Alt+↑ 选中，Tab 选中并移走焦点，Esc 关闭不选，输入字母跳到以其开头的选项。
 * class、style 落在外层（决定布局与宽度）；id、data-test、aria-* 等其余属性落在按钮上，<label for> 照常关联。
 * 值只来自 modelValue：选中只发出 update:modelValue，父组件不采纳（如保存失败）时仍显示原值
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  modelValue?: string
  options: readonly UiSelectOption[]
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/** 列表与按钮的间距、与窗口边缘至少留出的距离（px） */
const GAP = 4
const EDGE = 8
/** 上下都放不下时列表的最小高度（px），超出部分在列表内滚动 */
const MIN_HEIGHT = 80
/** PageUp、PageDown 一次移动的项数 */
const PAGE_SIZE = 10
/** 连续输入字母的间隔超过此值（ms）就从头匹配 */
const TYPEAHEAD_TIMEOUT = 500

// attrs 不是响应式的：渲染时读取
const rawAttrs = useAttrs()
const attrs = (): SplitAttrs => splitAttrs(rawAttrs)
const ownId = useId()
const listboxId = useId()
/** 按钮的 id：调用方给了就用（供 <label for> 关联），否则自动生成 */
const triggerId = (): string => (typeof rawAttrs.id === 'string' ? rawAttrs.id : ownId)
const optionId = (index: number): string => `${listboxId}-${index}`

const root = useTemplateRef<HTMLElement>('root')
const trigger = useTemplateRef<HTMLButtonElement>('trigger')
const listbox = useTemplateRef<HTMLElement>('listbox')

const open = ref(false)
/** 高亮项：键盘移动或指针经过，选中前不改变值 */
const active = ref(0)
/** 高亮最近一次由键盘移动：高亮项加焦点框 */
const keyboard = ref(false)
/** 向上展开、与按钮右缘对齐、最大高度：每次打开时按窗口内的空间决定 */
const above = ref(false)
const alignEnd = ref(false)
const maxHeight = ref<string>()

const selectedIndex = computed(() => props.options.findIndex((option) => option.value === props.modelValue))
const selected = computed(() => props.options[selectedIndex.value])

let typed = ''
let typedTimer: ReturnType<typeof setTimeout> | undefined

function clamp(index: number): number {
  return Math.min(Math.max(index, 0), props.options.length - 1)
}

function activeId(): string | undefined {
  return open.value && props.options[active.value] ? optionId(active.value) : undefined
}

/**
 * 列表与按钮同名：取按钮的 aria-labelledby、aria-label 或关联的 <label>（打开时会重新渲染，取的是当时的文字）。
 * 都没有时才以按钮为名（读屏会读成当前值）
 */
function listName(): Record<string, string> {
  const { 'aria-labelledby': labelledby, 'aria-label': label } = rawAttrs
  if (typeof labelledby === 'string') return { 'aria-labelledby': labelledby }
  if (typeof label === 'string') return { 'aria-label': label }
  const text = trigger.value?.labels[0]?.textContent?.trim()
  return text ? { 'aria-label': text } : { 'aria-labelledby': triggerId() }
}

function show(index: number, byKeyboard: boolean): void {
  if (open.value || props.disabled || props.options.length === 0) return
  open.value = true
  active.value = clamp(index)
  keyboard.value = byKeyboard
  // 有的平台点击按钮不聚焦（如 macOS）：键盘操作需要焦点在按钮上
  trigger.value?.focus({ preventScroll: true })
  document.addEventListener('pointerdown', onOutside, true)
  void nextTick(place)
}

function hide(): void {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
}

function toggle(): void {
  if (open.value) hide()
  else show(selectedIndex.value, false)
}

/** 选中并关闭；与当前值相同时不发出 */
function choose(index: number): void {
  const option = props.options[index]
  hide()
  if (option && option.value !== props.modelValue) emit('update:modelValue', option.value)
}

function activate(index: number, byKeyboard: boolean): void {
  active.value = clamp(index)
  keyboard.value = byKeyboard
  if (byKeyboard) void nextTick(reveal)
}

/** 点在控件外：关闭，不改变值 */
function onOutside(event: Event): void {
  const target = event.target
  if (!(target instanceof Node) || root.value?.contains(target)) return
  // 点本控件的 <label>：随后转发到按钮的点击会关闭列表，这里先关会被它重新打开
  if (target instanceof Element && target.closest('label')?.control === trigger.value) return
  hide()
}

/** 下方放不下而上方更宽裕时向上展开；右侧超出窗口时与按钮右缘对齐 */
function place(): void {
  const button = trigger.value
  const list = listbox.value
  if (!open.value || !button || !list) return
  const rect = button.getBoundingClientRect()
  const height = list.scrollHeight + list.offsetHeight - list.clientHeight
  const below = window.innerHeight - rect.bottom - GAP - EDGE
  const upper = rect.top - GAP - EDGE
  above.value = height > below && upper > below
  maxHeight.value = `${Math.max(above.value ? upper : below, MIN_HEIGHT)}px`
  alignEnd.value = rect.left + list.offsetWidth > window.innerWidth - EDGE
  reveal()
}

/** 列表内可滚动时让高亮项露出来 */
function reveal(): void {
  listbox.value?.children[active.value]?.scrollIntoView({ block: 'nearest' })
}

/** 从高亮项的下一项起（循环）找第一个以 prefix 开头的选项 */
function findByPrefix(prefix: string): number | undefined {
  const { options } = props
  for (let step = 1; step <= options.length; step += 1) {
    const index = (active.value + step) % options.length
    if (options[index]?.label.toLocaleLowerCase().startsWith(prefix)) return index
  }
  return undefined
}

/** 输入字母：跳到以已输入内容开头的选项；连按同一字母时在以它开头的选项间轮换 */
function typeahead(char: string): void {
  clearTimeout(typedTimer)
  typedTimer = setTimeout(() => {
    typed = ''
  }, TYPEAHEAD_TIMEOUT)
  typed += char.toLocaleLowerCase()
  const first = typed.charAt(0)
  const index = findByPrefix(typed) ?? ([...typed].every((c) => c === first) ? findByPrefix(first) : undefined)
  if (index === undefined) typed = ''
  else activate(index, true)
}

/** 列表关闭时：打开列表的按键与打开后高亮的选项 */
function openingIndex(key: string): number | undefined {
  if (key === 'Home') return 0
  if (key === 'End') return props.options.length - 1
  return ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key) ? selectedIndex.value : undefined
}

/** 列表打开时：移动高亮的按键与目标选项 */
function movedIndex(key: string): number | undefined {
  switch (key) {
    case 'ArrowDown':
      return active.value + 1
    case 'ArrowUp':
      return active.value - 1
    case 'PageDown':
      return active.value + PAGE_SIZE
    case 'PageUp':
      return active.value - PAGE_SIZE
    case 'Home':
      return 0
    case 'End':
      return props.options.length - 1
    default:
      return undefined
  }
}

function onKeydown(event: KeyboardEvent): void {
  const { key, altKey, ctrlKey, metaKey } = event
  if (key.length === 1 && key !== ' ' && !altKey && !ctrlKey && !metaKey) {
    event.preventDefault()
    show(selectedIndex.value, true)
    typeahead(key)
  } else if (!open.value) {
    const index = openingIndex(key)
    if (index === undefined) return
    event.preventDefault()
    show(index, true)
  } else if (key === 'Tab') {
    // 不阻止默认行为：选中后焦点照常移到下一个控件
    choose(active.value)
  } else {
    onListKeydown(event)
  }
}

/** 列表打开时的按键 */
function onListKeydown(event: KeyboardEvent): void {
  const { key, altKey } = event
  if (key === 'Escape') {
    // 只关列表：不让外层（如对话框）也响应 Esc
    event.stopPropagation()
    hide()
  } else if (key === 'Enter' || key === ' ' || (key === 'ArrowUp' && altKey)) {
    choose(active.value)
  } else {
    const index = movedIndex(key)
    if (index === undefined) return
    activate(index, true)
  }
  event.preventDefault()
}

// 打开时被禁用：收起
watch(
  () => props.disabled,
  (value) => {
    if (value) hide()
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true)
  clearTimeout(typedTimer)
})
</script>

<style scoped>
.ui-select {
  position: relative;
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
}

.ui-select-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 8px;
  text-align: start;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.ui-select-trigger:enabled {
  cursor: pointer;
}

/* 展开时边框加深；键盘打开时另有焦点框 */
.ui-select-trigger[aria-expanded='true']:not(:focus-visible) {
  border-color: var(--gcn-border-emphasis);
}

/* 当前值与撑宽用的各选项叠在同一格：格宽取最长的选项，放不下时省略 */
.ui-select-value {
  display: grid;
  flex: 1;
  min-width: 0;
}

.ui-select-value > .ui-select-label {
  grid-area: 1 / 1;
}

.ui-select-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-select-sizer {
  /* 列表每行比按钮多 8px 横向占位（勾选标记）：撑宽时一并预留，列表与按钮同宽 */
  padding-right: 8px;
  visibility: hidden;
}

/* 用各自语言书写的语言名：按其语言取字形（简繁字体分开） */
.ui-select-label:lang(zh-CN) {
  font-family: var(--gcn-font-latin), var(--gcn-font-sc), sans-serif;
}

.ui-select-label:lang(zh-TW) {
  font-family: var(--gcn-font-latin), var(--gcn-font-tc), sans-serif;
}

.ui-select-icon {
  flex: none;
  color: var(--gcn-fg-muted);
  transition:
    color var(--gcn-duration-fast) var(--gcn-ease),
    transform var(--gcn-duration-base) var(--gcn-ease-out);
}

.ui-select-trigger:hover:enabled .ui-select-icon,
.ui-select-trigger[aria-expanded='true'] .ui-select-icon {
  color: var(--gcn-fg);
}

.ui-select-trigger[aria-expanded='true'] .ui-select-icon {
  transform: rotate(180deg);
}

.ui-select-trigger:disabled .ui-select-icon {
  color: var(--gcn-fg-disabled);
}

/* 浮层：至少与按钮同宽；z-index 盖住后面带定位的控件（按钮、开关） */
.ui-select-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 10;
  width: max-content;
  min-width: 100%;
  max-width: calc(100vw - 16px);
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-padding-block: 6px;
  list-style: none;
  background: var(--gcn-overlay-bg);
  border: 1px solid var(--gcn-overlay-border);
  border-radius: var(--gcn-radius-overlay);
  box-shadow: var(--gcn-shadow-overlay);
}

.ui-select-list.is-above {
  top: auto;
  bottom: calc(100% + 4px);
}

.ui-select-list.is-end {
  right: 0;
  left: auto;
}

.ui-select-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--gcn-control-md);
  padding: 6px 8px;
  line-height: 20px;
  border-radius: var(--gcn-radius);
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.ui-select-option.is-active {
  background: var(--gcn-invisible-hover-bg);
}

.ui-select-option:active {
  background: var(--gcn-invisible-active-bg);
}

.is-keyboard > .ui-select-option.is-active {
  outline: 2px solid var(--gcn-focus);
  outline-offset: -2px;
}

.ui-select-check {
  flex: none;
  visibility: hidden;
}

.ui-select-option[aria-selected='true'] > .ui-select-check {
  visibility: visible;
}

/* 展开：淡入并从按钮一侧滑出 4px；收起只淡出 */
.ui-select-list-enter-active {
  transition:
    opacity var(--gcn-duration-base) var(--gcn-ease-out),
    transform var(--gcn-duration-base) var(--gcn-ease-out);
}

.ui-select-list-leave-active {
  pointer-events: none;
  transition: opacity var(--gcn-duration-fast) var(--gcn-ease);
}

.ui-select-list-enter-from,
.ui-select-list-leave-to {
  opacity: 0;
}

.ui-select-list-enter-from {
  transform: translateY(-4px);
}

.ui-select-list.is-above.ui-select-list-enter-from {
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .ui-select-icon,
  .ui-select-list-enter-active,
  .ui-select-list-leave-active {
    transition: none;
  }
}

/* 高对比度模式：系统会替换背景色，高亮项改用系统的选中色 */
@media (forced-colors: active) {
  .ui-select-option.is-active {
    color: HighlightText;
    background: Highlight;
    forced-color-adjust: none;
  }
}
</style>
