<template>
  <div class="connection-status">
    <UiBadge :tone="tone" dot live data-test="wt-connection">{{ label }}</UiBadge>
    <UiButton
      size="sm"
      :disabled="disabled"
      :title="disabledReason"
      data-test="wt-test-connection"
      @click="emit('test')"
    >
      {{ testing ? t('wtTesting') : t('wtTest') }}
    </UiButton>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiBadge from '../../components/ui/UiBadge.vue'
import UiButton from '../../components/ui/UiButton.vue'
import type { UiBadgeTone } from '../../components/ui/types'
import { useI18n } from '../../components/ui-preferences'
import type { ConnectionKind } from './connection-status'

const props = defineProps<{
  kind: ConnectionKind
  latencyMs?: number
  error?: string
  testing?: boolean
  disabled?: boolean
  disabledReason?: string
}>()

const emit = defineEmits<{
  test: []
}>()

const { t } = useI18n()

const tone = computed<UiBadgeTone>(() => {
  switch (props.kind) {
    case 'ok':
      return 'success'
    case 'untested':
      return 'neutral'
    case 'unconfigured':
    case 'testing':
    case 'timeout':
    case 'network':
      return 'attention'
    default:
      return 'danger'
  }
})

const label = computed(() => {
  switch (props.kind) {
    case 'unconfigured':
      return t('wtConnUnconfigured')
    case 'untested':
      return t('wtConnUntested')
    case 'testing':
      return t('wtTesting')
    case 'ok':
      return props.latencyMs !== undefined ? t('wtConnOkMs', { ms: props.latencyMs }) : t('wtConnOk')
    case 'auth':
      return t('wtConnAuth')
    case 'timeout':
      return t('wtConnTimeout')
    case 'network':
      return t('wtConnNetwork')
    case 'not-found':
      return t('wtConnNotFound')
    case 'rate-limited':
      return t('wtConnRateLimited')
    default:
      return props.error || t('wtAutoError')
  }
})
</script>

<style scoped>
.connection-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
