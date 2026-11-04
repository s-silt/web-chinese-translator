<template>
  <span ref="root" class="model-input" :class="{ 'has-options': options.length > 0 }" v-bind="attrs().root">
    <UiInput
      ref="field"
      v-bind="attrs().field"
      :model-value="modelValue"
      :disabled="disabled"
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="visible"
      :aria-controls="visible ? listId : undefined"
      :aria-activedescendant="visible && active >= 0 ? optionId(active) : undefined"
      autocomplete="off"
      @update:model-value="update"
      @focus="showFiltered"
      @click="showFiltered"
      @blur="hide"
      @keydown="onKeydown"
    />
    <button
      v-if="options.length > 0"
      type="button"
      class="model-toggle"
      tabindex="-1"
      :aria-label="chooseLabel"
      :disabled="disabled"
      data-test="wt-model-menu"
      @mousedown.prevent
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
    <div
      v-if="visible"
      class="ui-select-list model-popover"
      :class="{ 'is-above': above }"
      :style="{ maxHeight }"
      @mousedown.prevent
    >
      <ul
        :id="listId"
        ref="listbox"
        class="model-list"
        role="listbox"
        :aria-label="chooseLabel"
        data-test="wt-model-options"
      >
        <li
          v-for="(value, index) in shown"
          :id="optionId(index)"
          :key="value"
          class="ui-select-option model-option"
          :class="{ 'is-active': active === index }"
          role="option"
          :aria-selected="value === modelValue"
          @pointermove="active = index"
          @click.prevent="choose(index)"
        >{{ value }}</li>
      </ul>
      <p v-if="matches.length > shown.length" class="model-more" role="status">{{ moreLabel }}</p>
    </div>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, useId, useTemplateRef, watch } from 'vue'
import UiInput from '../../components/ui/UiInput.vue'
import { splitAttrs, type SplitAttrs } from '../../components/ui/attrs'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  modelValue: string
  options: readonly string[]
  disabled?: boolean
  chooseLabel: string
  moreLabel: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const rawAttrs = useAttrs()
const attrs = (): SplitAttrs => splitAttrs(rawAttrs)
const root = useTemplateRef<HTMLElement>('root')
const field = useTemplateRef<InstanceType<typeof UiInput>>('field')
const listbox = useTemplateRef<HTMLElement>('listbox')
const listId = useId()
const optionId = (index: number): string => `${listId}-${index}`
const open = ref(false)
const query = ref(props.modelValue)
const active = ref(-1)
const above = ref(false)
const maxHeight = ref('280px')
// 接口列表有数量上限；DOM再限制一次，输入可查找未展示的候选。
const MAX_SHOWN = 100
const matches = computed(() => {
  const term = query.value.trim().toLowerCase()
  return props.options.filter((value) => value.toLowerCase().includes(term))
})
const shown = computed(() => matches.value.slice(0, MAX_SHOWN))
const visible = computed(() => open.value && shown.value.length > 0 && !props.disabled)

function place(): void {
  const rect = root.value?.getBoundingClientRect()
  if (rect === undefined) return
  const below = innerHeight - rect.bottom - 8
  const upper = rect.top - 8
  above.value = below < 160 && upper > below
  maxHeight.value = `${Math.max(80, Math.min(280, above.value ? upper : below))}px`
}
function hide(): void {
  open.value = false
  active.value = -1
}
function showFiltered(): void {
  if (props.disabled) return
  query.value = props.options.includes(props.modelValue) ? '' : props.modelValue
  active.value = -1
  open.value = true
  void nextTick(place)
}
function update(value: string): void {
  if (props.disabled) return
  query.value = value
  active.value = -1
  open.value = true
  emit('update:modelValue', value)
}
function toggle(): void {
  if (props.disabled) return
  if (visible.value) {
    hide()
    return
  }
  field.value?.focus()
  query.value = ''
  active.value = -1
  open.value = true
  void nextTick(place)
}
function choose(index: number): void {
  const value = shown.value[index]
  if (props.disabled || value === undefined) return
  emit('update:modelValue', value)
  field.value?.focus()
  hide()
}
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled || event.isComposing || event.ctrlKey || event.metaKey) return
  if (event.altKey) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      showFiltered()
    } else if (event.key === 'ArrowUp' && visible.value) {
      event.preventDefault()
      hide()
    }
    return
  }
  if (event.key === 'Tab') {
    hide()
    return
  }
  if (event.key === 'Escape' && visible.value) {
    event.preventDefault()
    event.stopPropagation()
    hide()
    return
  }
  if (event.key === 'Enter' && visible.value && active.value >= 0) {
    event.preventDefault()
    choose(active.value)
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (!visible.value) query.value = props.options.includes(props.modelValue) ? '' : props.modelValue
  if (shown.value.length === 0) return
  event.preventDefault()
  open.value = true
  active.value = Math.max(0, Math.min(shown.value.length - 1,
    active.value < 0 ? (event.key === 'ArrowDown' ? 0 : shown.value.length - 1) :
      active.value + (event.key === 'ArrowDown' ? 1 : -1)))
  void nextTick(() => {
    place()
    listbox.value?.querySelector<HTMLElement>(`[id="${optionId(active.value)}"]`)?.scrollIntoView?.({ block: 'nearest' })
  })
}
function outside(event: PointerEvent): void {
  if (event.target instanceof Node && !root.value?.contains(event.target)) hide()
}
watch(() => props.modelValue, (value) => { query.value = value })
watch(shown, () => {
  active.value = -1
  if (open.value) void nextTick(place)
}, { flush: 'sync' })
watch(() => props.options, (values) => { if (values.length === 0) hide() })
watch(() => props.disabled, (value) => { if (value) hide() })
watch(visible, (value) => {
  if (value) {
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', hide)
  } else {
    document.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('resize', hide)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('resize', hide)
})
</script>

<style scoped>
.model-input { position: relative; display: block; width: 100%; min-width: 0; }
.has-options :deep(input) { padding-right: 36px; }
.model-toggle { position: absolute; top: 2px; right: 2px; bottom: 2px; display: grid; place-items: center; width: 30px; padding: 0; color: var(--gcn-fg-muted); background: transparent; border: 0; border-radius: var(--gcn-radius); cursor: pointer; }
.model-toggle:enabled:hover { background: var(--gcn-invisible-hover-bg); }
.model-toggle:disabled { cursor: default; }
.model-popover { position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; display: flex; flex-direction: column; width: 100%; min-width: 0; margin: 0; padding: 6px; overflow: hidden; background: var(--gcn-overlay-bg); border: 1px solid var(--gcn-overlay-border); border-radius: var(--gcn-radius-overlay); box-shadow: var(--gcn-shadow-overlay); }
.model-popover.is-above { top: auto; bottom: calc(100% + 4px); }
.model-list { min-height: 0; margin: 0; padding: 0; overflow-y: auto; overscroll-behavior: contain; list-style: none; }
.model-option { min-height: var(--gcn-control-md); padding: 6px 8px; overflow-wrap: anywhere; line-height: 20px; border-radius: var(--gcn-radius); cursor: pointer; }
.model-option.is-active { background: var(--gcn-invisible-hover-bg); outline: 2px solid var(--gcn-focus); outline-offset: -2px; }
.model-option[aria-selected='true'] { font-weight: 600; }
.model-more { flex: none; margin: 4px 0 0; padding: 6px 8px 0; color: var(--gcn-fg-muted); font-size: 12px; border-top: 1px solid var(--gcn-border); }
</style>
