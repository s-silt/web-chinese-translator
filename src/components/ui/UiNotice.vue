<template>
  <div
    class="ui-notice"
    :class="`ui-notice-${tone}`"
    :role="live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined"
    :aria-live="live"
    :aria-atomic="live === undefined ? undefined : 'true'"
  >
    <p v-if="title" class="ui-notice-title">{{ title }}</p>
    <div class="ui-notice-body"><slot /></div>
  </div>
</template>

<script setup lang="ts">
const { tone = 'info', live = undefined, title = undefined } = defineProps<{
  tone?: 'info' | 'success' | 'warning' | 'error' | 'empty'
  title?: string
  live?: 'polite' | 'assertive'
}>()
</script>

<style scoped>
.ui-notice {
  display: grid;
  gap: var(--gcn-gap-8);
  min-width: 0;
  padding: 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--gcn-fg);
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius-lg);
  overflow-wrap: anywhere;
}

.ui-notice-title {
  margin: 0;
  font-weight: 600;
  color: var(--gcn-accent);
}

.ui-notice-body {
  color: var(--gcn-fg);
}

.ui-notice-success {
  background: var(--gcn-success-bg);
}

.ui-notice-success .ui-notice-title {
  color: var(--gcn-success-fg);
}

.ui-notice-warning {
  background: var(--gcn-attention-bg);
}

.ui-notice-warning .ui-notice-title {
  color: var(--gcn-attention-fg);
}

.ui-notice-error {
  background: var(--gcn-danger-bg);
}

.ui-notice-error .ui-notice-title {
  color: var(--gcn-danger-fg);
}

.ui-notice-empty .ui-notice-title {
  color: var(--gcn-fg-muted);
}
</style>
