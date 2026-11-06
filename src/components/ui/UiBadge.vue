<template>
  <span class="ui-badge" :class="`ui-badge-${tone}`" :role="live ? 'status' : undefined">
    <span v-if="dot" class="ui-badge-dot" aria-hidden="true"></span>
    <slot />
  </span>
</template>

<script setup lang="ts">
import type { UiBadgeTone } from './types'

/** 状态徽章。色调由 tone 决定；dot 显示左侧圆点；live 时作为读屏状态区，一页只给主状态用，避免轮询时反复朗读 */
const { tone = 'neutral', dot = false, live = false } = defineProps<{
  tone?: UiBadgeTone
  dot?: boolean
  live?: boolean
}>()
</script>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  color: var(--gcn-fg-muted);
  background: var(--gcn-neutral-bg);
  border-radius: 999px;
}

.ui-badge-dot {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}

.ui-badge-success {
  color: var(--gcn-success-fg);
  background: var(--gcn-success-bg);
}

.ui-badge-attention {
  color: var(--gcn-attention-fg);
  background: var(--gcn-attention-bg);
}

.ui-badge-danger {
  color: var(--gcn-danger-fg);
  background: var(--gcn-danger-bg);
}

.ui-badge-accent {
  color: var(--gcn-accent);
  background: var(--gcn-selection);
}

@media (forced-colors: active) {
  .ui-badge {
    border: 1px solid ButtonText;
    forced-color-adjust: none;
  }

  .ui-badge-dot {
    background: ButtonText;
  }
}
</style>
