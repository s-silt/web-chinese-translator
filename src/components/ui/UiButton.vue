<template>
  <component
    :is="href === undefined ? 'button' : 'a'"
    :type="href === undefined ? type : undefined"
    :href="href"
    class="ui-button"
    :class="[`ui-button-${variant}`, `ui-button-${size}`, { 'ui-button-icon': icon }]"
    :disabled="href === undefined ? disabled : undefined"
  >
    <slot />
    <UiRipple />
  </component>
</template>

<script setup lang="ts">
import type { UiButtonSize, UiButtonVariant } from './types'
import UiRipple from './UiRipple.vue'

/**
 * 按钮。点击等事件与 aria-*、title、data-test 等属性直接落在原生 button 上。
 * 给出 href 时是外观相同的链接（a），target、rel 等属性同样直接落在上面；链接没有禁用状态
 */
const {
  variant = 'default',
  size = 'md',
  type = 'button',
  href = undefined,
} = defineProps<{
  variant?: UiButtonVariant
  size?: UiButtonSize
  /** 原生 type；默认 button，放在表单里也不会提交 */
  type?: 'button' | 'submit'
  /** 只有图标：宽高相等 */
  icon?: boolean
  disabled?: boolean
  /** 链接地址：渲染为 a */
  href?: string
}>()
</script>

<style scoped>
.ui-button {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: var(--gcn-control-md);
  padding: 0 12px;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  color: var(--gcn-btn-fg);
  text-decoration: none;
  background: var(--gcn-btn-bg);
  border: 1px solid var(--gcn-btn-border);
  border-radius: var(--gcn-radius);
  box-shadow: var(--gcn-shadow-sm), var(--gcn-highlight);
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    color var(--gcn-duration-fast) var(--gcn-ease),
    background-color var(--gcn-duration-fast) var(--gcn-ease),
    border-color var(--gcn-duration-fast) var(--gcn-ease);
}

.ui-button:hover:not(:disabled) {
  background: var(--gcn-btn-hover-bg);
}

/* 按下立即变色，松开时再过渡回去 */
.ui-button:active:not(:disabled) {
  background: var(--gcn-btn-active-bg);
  transition-duration: 0s;
}

.ui-button:disabled {
  color: var(--gcn-fg-disabled);
  background: var(--gcn-bg-disabled);
  box-shadow: none;
  cursor: not-allowed;
}

.ui-button-sm {
  height: var(--gcn-control-sm);
  padding: 0 8px;
  font-size: 12px;
}

.ui-button-icon {
  width: var(--gcn-control-md);
  padding: 0;
}

.ui-button-icon.ui-button-sm {
  width: var(--gcn-control-sm);
}

.ui-button-primary {
  color: var(--gcn-primary-fg);
  background: var(--gcn-primary-bg);
  border-color: var(--gcn-primary-border);
  box-shadow: var(--gcn-primary-shadow), var(--gcn-highlight);
}

.ui-button-primary:hover:not(:disabled) {
  background: var(--gcn-primary-hover-bg);
}

.ui-button-primary:active:not(:disabled) {
  background: var(--gcn-primary-active-bg);
}

.ui-button-primary:disabled {
  color: var(--gcn-primary-disabled-fg);
  background: var(--gcn-primary-disabled-bg);
  border-color: var(--gcn-border);
}

.ui-button-danger {
  color: var(--gcn-danger-fg);
}

.ui-button-danger:hover:not(:disabled) {
  color: var(--gcn-primary-fg);
  background: var(--gcn-danger-hover-bg);
  border-color: var(--gcn-primary-border);
}

.ui-button-danger:active:not(:disabled) {
  color: var(--gcn-primary-fg);
  background: var(--gcn-danger-active-bg);
}

.ui-button-invisible {
  color: var(--gcn-fg-muted);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.ui-button-invisible:hover:not(:disabled) {
  color: var(--gcn-fg);
  background: var(--gcn-invisible-hover-bg);
}

.ui-button-invisible:active:not(:disabled) {
  background: var(--gcn-invisible-active-bg);
}

.ui-button-invisible:disabled {
  background: transparent;
}

@media (prefers-reduced-motion: reduce) {
  .ui-button {
    transition: none;
  }
}
</style>
