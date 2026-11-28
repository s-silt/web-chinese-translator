<template>
  <div class="connection-status">
    <div class="connection-status-row">
      <div class="connection-status-badges">
        <UiBadge :tone="tone" dot live data-test="wt-connection">{{ label }}</UiBadge>
        <UiBadge v-if="dirty" tone="attention" dot data-test="wt-draft-badge">{{ t('wtConnDraft') }}</UiBadge>
      </div>
      <div class="connection-status-actions">
        <UiButton
          v-if="dirty && canDiscard"
          size="sm"
          variant="invisible"
          :disabled="testing || saving || grantingEndpoint"
          data-test="wt-discard-draft"
          @click="emit('discardDraft')"
        >
          {{ t('wtDiscardDraft') }}
        </UiButton>
        <UiButton
          v-if="kind === 'unauthorized' && canGrantEndpoint"
          variant="primary"
          size="sm"
          :disabled="grantingEndpoint"
          :aria-busy="grantingEndpoint"
          data-test="wt-grant-endpoint"
          @click="emit('grantEndpoint')"
        >
          {{ t('wtConnGrantEndpoint') }}
        </UiButton>
        <UiButton
          size="sm"
          :disabled="disabled"
          :aria-describedby="showReason ? reasonId : undefined"
          :aria-busy="testing"
          data-test="wt-test-connection"
          @click="emit('test')"
        >
          {{ testing ? t('wtTesting') : t('wtTest') }}
        </UiButton>
      </div>
    </div>
    <p v-if="showSeparateReason" :id="reasonId" class="ui-hint">{{ disabledReason }}</p>
    <p
      v-if="recoveryKey !== ''"
      :id="reasonDuplicatesBadge ? reasonId : undefined"
      class="ui-hint"
    >
      {{ t(recoveryKey) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import UiBadge from '../../components/ui/UiBadge.vue'
import UiButton from '../../components/ui/UiButton.vue'
import type { UiBadgeTone } from '../../components/ui/types'
import { useI18n } from '../../components/ui-preferences'
import type { MessageKey } from '../../i18n'
import type { ConnectionKind } from './connection-status'

const props = defineProps<{
  kind: ConnectionKind
  latencyMs?: number
  error?: string
  testing?: boolean
  saving?: boolean
  disabled?: boolean
  disabledReason?: string
  canGrantEndpoint?: boolean
  grantingEndpoint?: boolean
  dirty?: boolean
  canDiscard?: boolean
}>()

const emit = defineEmits<{
  test: []
  grantEndpoint: []
  discardDraft: []
}>()

const { t } = useI18n()
const reasonId = useId()

const showReason = computed(() => props.disabled === true && props.disabledReason !== undefined && props.disabledReason !== '')
const reasonDuplicatesBadge = computed(
  () => showReason.value && recoveryKey.value !== '' && props.disabledReason === label.value,
)
const showSeparateReason = computed(() => showReason.value && !reasonDuplicatesBadge.value)

const recoveryKey = computed<MessageKey | ''>(() => {
  switch (props.kind) {
    case 'missing-model':
      return 'wtConnRecoveryMissingModel'
    case 'unauthorized':
      return 'wtConnRecoveryUnauthorized'
    case 'auth':
      return 'wtConnRecoveryAuth'
    case 'timeout':
    case 'network':
      return 'wtConnRecoveryNetwork'
    case 'not-found':
      return 'wtConnRecoveryNotFound'
    case 'rate-limited':
      return 'wtConnRecoveryRateLimited'
    case 'error':
      return 'wtConnRecoveryError'
    default:
      return ''
  }
})

const tone = computed<UiBadgeTone>(() => {
  switch (props.kind) {
    case 'ok':
      return 'success'
    case 'untested':
      return 'neutral'
    case 'unconfigured':
    case 'missing-model':
    case 'unauthorized':
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
    case 'missing-model':
      return t('wtConnMissingModel')
    case 'unauthorized':
      return t('wtConnUnauthorized')
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
  display: grid;
  gap: var(--gcn-gap-8);
  padding: 10px 12px;
  background: var(--gcn-card-bg);
  border: 1px solid var(--gcn-card-border);
  border-radius: var(--gcn-card-radius);
}

.connection-status .ui-hint {
  margin: 0;
}

.connection-status-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.connection-status-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.connection-status-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
</style>
