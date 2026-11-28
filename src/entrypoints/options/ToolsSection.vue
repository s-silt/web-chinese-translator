<template>
  <section id="wt-tools-title" class="wt-tools-group" aria-labelledby="wt-tools-heading">
    <div class="section">
      <h2 id="wt-tools-heading" class="section-title">{{ t('wtProfilesTitle') }}</h2>
      <p class="section-desc">{{ t('wtProfilesDesc') }}</p>

      <div class="wt-inline-row">
        <UiInput
          v-model="newProfileName"
          :placeholder="t('wtProfileNamePlaceholder')"
          data-test="wt-profile-name-input"
        />
        <UiButton
          variant="primary"
          size="sm"
          :disabled="!canSaveProfile"
          data-test="wt-profile-save"
          @click="saveCurrentAsProfile"
        >
          {{ t('wtProfileSaveCurrent') }}
        </UiButton>
      </div>

      <ul v-if="config.modelProfiles.length > 0" class="wt-compact-list" data-test="wt-profile-list">
        <li v-for="profile in config.modelProfiles" :key="profile.id" class="wt-compact-item">
          <div class="wt-compact-main">
            <strong>{{ profile.name }}</strong>
            <span class="wt-compact-meta">{{ profile.model }} · {{ profile.baseUrl }}</span>
          </div>
          <div class="wt-compact-actions">
            <UiButton size="sm" :data-test="`wt-profile-apply-${profile.id}`" @click="applyProfile(profile)">
              {{ t('wtProfileApply') }}
            </UiButton>
            <UiButton size="sm" variant="danger" :data-test="`wt-profile-del-${profile.id}`" @click="deleteProfile(profile.id)">
              {{ t('wtProfileDelete') }}
            </UiButton>
          </div>
        </li>
      </ul>

      <div v-if="config.modelProfiles.length > 0" class="wt-field-row">
        <label class="wt-field-label" for="wt-selection-profile">{{ t('wtProfileSelectionLabel') }}</label>
        <UiSelect
          id="wt-selection-profile"
          :model-value="config.selectionProfileId"
          :options="selectionProfileOptions"
          data-test="wt-selection-profile"
          @update:model-value="updateSelectionProfile"
        />
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">{{ t('wtStyleTitle') }}</h2>

      <div class="wt-field-row">
        <label class="wt-field-label" for="wt-display-mode">{{ t('wtDisplayModeLabel') }}</label>
        <UiSelect
          id="wt-display-mode"
          :model-value="config.displayMode"
          :options="displayModeOptions"
          data-test="wt-display-mode"
          @update:model-value="updateDisplayMode"
        />
      </div>

      <div class="wt-field-row">
        <div class="wt-field-main">
          <label class="wt-field-label" for="wt-hover-translate">{{ t('wtHoverTranslateLabel') }}</label>
          <p class="section-desc">{{ t('wtHoverTranslateDesc') }}</p>
        </div>
        <UiSwitch
          id="wt-hover-translate"
          :checked="config.hoverTranslateEnabled"
          :label="t('wtHoverTranslateLabel')"
          data-test="wt-hover-translate"
          @change="updateHoverTranslate"
        />
      </div>

      <div class="wt-field-row">
        <label class="wt-field-label" for="wt-style-select">{{ t('wtStyleLabel') }}</label>
        <UiSelect
          id="wt-style-select"
          :model-value="config.translationStyle"
          :options="styleOptions"
          data-test="wt-style-select"
          @update:model-value="updateStyle"
        />
      </div>

      <h3 class="wt-subsection-title">{{ t('wtGlossaryLabel') }}</h3>
      <div class="wt-inline-row">
        <UiInput
          v-model="glossarySource"
          :placeholder="t('wtGlossarySourcePlaceholder')"
          data-test="wt-glossary-source"
        />
        <UiInput
          v-model="glossaryTarget"
          :placeholder="t('wtGlossaryTargetPlaceholder')"
          data-test="wt-glossary-target"
        />
        <UiButton
          size="sm"
          :disabled="glossarySource.trim() === '' || glossaryTarget.trim() === ''"
          data-test="wt-glossary-add"
          @click="addGlossaryTerm"
        >
          {{ t('wtGlossaryAdd') }}
        </UiButton>
      </div>

      <ul v-if="config.promptGlossary.length > 0" class="wt-compact-list" data-test="wt-glossary-list">
        <li v-for="entry in config.promptGlossary" :key="entry.source" class="wt-compact-item">
          <span class="wt-compact-main">
            <code>{{ entry.source }}</code> → <strong>{{ entry.target }}</strong>
          </span>
          <UiButton size="sm" variant="danger" @click="removeGlossaryTerm(entry.source)">
            {{ t('wtProfileDelete') }}
          </UiButton>
        </li>
      </ul>
    </div>

    <div class="section">
      <h2 class="section-title">{{ t('wtUsageTitle') }}</h2>
      <dl class="pairs" data-test="wt-usage-stats">
        <dt>{{ t('wtUsageToday') }}</dt>
        <dd>{{ usageStats.today.requests }} / {{ (usageStats.today.inputTokens + usageStats.today.outputTokens).toLocaleString() }}</dd>
        <dt>{{ t('wtUsageMonth') }}</dt>
        <dd>{{ usageStats.month.requests }} / {{ (usageStats.month.inputTokens + usageStats.month.outputTokens).toLocaleString() }}</dd>
        <dt>{{ t('wtUsageCacheHits') }}</dt>
        <dd>{{ usageStats.total.cacheHits.toLocaleString() }}</dd>
        <dt>{{ t('wtCacheStatsLabel') }}</dt>
        <dd>{{ cacheStats.entries.toLocaleString() }} ({{ formatBytes(cacheStats.approxBytes) }})</dd>
      </dl>
      <ul v-if="cacheStats.hosts.length > 0" class="wt-compact-list" data-test="wt-cache-host-list">
        <li v-for="item in cacheStats.hosts" :key="item.host" class="wt-compact-item">
          <span class="wt-compact-main">
            <strong>{{ item.host }}</strong>
            <span class="wt-compact-meta">{{ item.entries }}</span>
          </span>
          <UiButton size="sm" @click="clearSiteCache(item.host)">{{ t('wtClearCache') }}</UiButton>
        </li>
      </ul>
      <div class="wt-inline-row">
        <UiButton size="sm" data-test="wt-stats-refresh" @click="refreshStats">{{ t('wtCacheRefresh') }}</UiButton>
        <UiButton size="sm" data-test="wt-cache-clear" @click="clearCache">{{ t('wtClearCache') }}</UiButton>
        <UiButton size="sm" variant="danger" data-test="wt-usage-reset" @click="resetUsage">{{ t('wtUsageReset') }}</UiButton>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">{{ t('wtBackupTitle') }}</h2>
      <p class="section-desc">{{ t('wtBackupDesc') }}</p>
      <div class="wt-inline-row">
        <UiButton size="sm" data-test="wt-backup-export" @click="handleExport">{{ t('wtBackupExport') }}</UiButton>
        <UiButton size="sm" data-test="wt-backup-import" @click="triggerImport">{{ t('wtBackupImport') }}</UiButton>
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          class="sr-only"
          data-test="wt-backup-file"
          @change="handleImportFile"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { downloadText } from '../../components/download'
import { showToast } from '../../components/toast'
import { useI18n } from '../../components/ui-preferences'
import UiButton from '../../components/ui/UiButton.vue'
import UiInput from '../../components/ui/UiInput.vue'
import UiSelect from '../../components/ui/UiSelect.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { sendTranslationMessage } from '../../translation/client'
import type { TranslationConfigPatch } from '../../translation/messages'
import {
  DEFAULT_TRANSLATION_CONFIG,
  isDisplayMode,
  isTranslationStyle,
  type ModelProfile,
  type TranslationConfig,
} from '../../translation/config'
import { exportConfigBackup, parseConfigBackup } from '../../translation/config-backup'
import { createId } from '../../translation/id'
import type { PersistentCacheStats } from '../../translation/persistent-cache'
import { emptyUsageStats, type UsageStatsSnapshot } from '../../translation/usage-stats'

const { t } = useI18n()

const config = ref<TranslationConfig>(DEFAULT_TRANSLATION_CONFIG)
const usageStats = ref<UsageStatsSnapshot>(emptyUsageStats())
const cacheStats = ref<PersistentCacheStats>({ entries: 0, approxBytes: 0, expired: 0, hosts: [] })
const newProfileName = ref('')
const glossarySource = ref('')
const glossaryTarget = ref('')
const importInput = ref<HTMLInputElement | null>(null)

const canSaveProfile = computed(
  () => newProfileName.value.trim() !== '' && config.value.baseUrl !== '' && config.value.model !== '',
)

const displayModeOptions = computed(() => [
  { value: 'replace', label: t('wtDisplayModeReplace') },
  { value: 'bilingual', label: t('wtDisplayModeBilingual') },
])

const styleOptions = computed(() => [
  { value: 'natural', label: t('wtStyleNatural') },
  { value: 'technical', label: t('wtStyleTechnical') },
  { value: 'academic', label: t('wtStyleAcademic') },
  { value: 'concise', label: t('wtStyleConcise') },
])

const selectionProfileOptions = computed(() => [
  { value: '', label: t('wtProfileSelectionDefault') },
  ...config.value.modelProfiles.map((p) => ({ value: p.id, label: `${p.name} (${p.model})` })),
])

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

async function loadAll(): Promise<void> {
  const reply = await sendTranslationMessage({ type: 'wt:get-config' })
  if (reply.ok) config.value = reply.config
  await refreshStats()
}

async function refreshStats(): Promise<void> {
  const [usageReply, cacheReply] = await Promise.all([
    sendTranslationMessage({ type: 'wt:get-usage-stats' }),
    sendTranslationMessage({ type: 'wt:get-cache-stats' }),
  ])
  if (usageReply.ok) usageStats.value = usageReply.usageStats
  if (cacheReply.ok) cacheStats.value = cacheReply.cacheStats
}

async function patchConfig(patch: TranslationConfigPatch): Promise<boolean> {
  const reply = await sendTranslationMessage({ type: 'wt:save-config', patch })
  if (!reply.ok) {
    showToast('danger', 'wtSavedFail', { error: reply.error })
    return false
  }
  config.value = reply.config
  return true
}

async function saveCurrentAsProfile(): Promise<void> {
  if (!canSaveProfile.value) return
  const profile: ModelProfile = {
    id: createId().slice(0, 12),
    name: newProfileName.value.trim(),
    baseUrl: config.value.baseUrl,
    model: config.value.model,
    apiType: config.value.apiType,
    temperature: config.value.temperature,
  }
  const nextProfiles = [...config.value.modelProfiles, profile]
  if (await patchConfig({ modelProfiles: nextProfiles, activeProfileId: profile.id })) {
    newProfileName.value = ''
    showToast('success', 'wtSavedOk')
  }
}

async function applyProfile(profile: ModelProfile): Promise<void> {
  const prevOrigin = config.value.baseUrl
  if (
    await patchConfig({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiType: profile.apiType,
      temperature: profile.temperature,
      activeProfileId: profile.id,
    })
  ) {
    if (prevOrigin !== profile.baseUrl) {
      showToast('success', 'wtNeedPermission')
    } else {
      showToast('success', 'wtSavedOk')
    }
  }
}

async function deleteProfile(id: string): Promise<void> {
  const nextProfiles = config.value.modelProfiles.filter((item) => item.id !== id)
  const patch: Record<string, unknown> = { modelProfiles: nextProfiles }
  if (config.value.activeProfileId === id) patch.activeProfileId = ''
  if (config.value.selectionProfileId === id) patch.selectionProfileId = ''
  await patchConfig(patch)
}

async function updateSelectionProfile(value: string): Promise<void> {
  await patchConfig({ selectionProfileId: value })
}

async function updateDisplayMode(value: string): Promise<void> {
  if (!isDisplayMode(value)) return
  await patchConfig({ displayMode: value })
}

async function updateHoverTranslate(value: boolean): Promise<void> {
  await patchConfig({ hoverTranslateEnabled: value })
}

async function updateStyle(value: string): Promise<void> {
  if (!isTranslationStyle(value)) return
  await patchConfig({ translationStyle: value })
}

async function addGlossaryTerm(): Promise<void> {
  const source = glossarySource.value.trim()
  const target = glossaryTarget.value.trim()
  if (source === '' || target === '') return
  const filtered = config.value.promptGlossary.filter((item) => item.source.toLowerCase() !== source.toLowerCase())
  if (await patchConfig({ promptGlossary: [...filtered, { source, target }] })) {
    glossarySource.value = ''
    glossaryTarget.value = ''
  }
}

async function removeGlossaryTerm(source: string): Promise<void> {
  const next = config.value.promptGlossary.filter((item) => item.source !== source)
  await patchConfig({ promptGlossary: next })
}

async function clearSiteCache(host: string): Promise<void> {
  const reply = await sendTranslationMessage({ type: 'wt:clear-site-cache', host })
  if (reply.ok) {
    showToast('success', 'wtClearCacheDone')
    await refreshStats()
  } else {
    showToast('danger', 'wtSavedFail', { error: reply.error })
  }
}

async function clearCache(): Promise<void> {
  const reply = await sendTranslationMessage({ type: 'wt:clear-cache' })
  if (reply.ok) {
    showToast('success', 'wtClearCacheDone')
    await refreshStats()
  } else {
    showToast('danger', 'wtSavedFail', { error: reply.error })
  }
}

async function resetUsage(): Promise<void> {
  const reply = await sendTranslationMessage({ type: 'wt:reset-usage-stats' })
  if (reply.ok) usageStats.value = reply.usageStats
}

function handleExport(): void {
  const json = exportConfigBackup(config.value)
  downloadText('web-chinese-translator-config.json', json, 'application/json')
  showToast('success', 'wtBackupExported')
}

function triggerImport(): void {
  importInput.value?.click()
}

async function handleImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const text = await file.text()
  const parsed = parseConfigBackup(text)
  if (!parsed.ok) {
    showToast('danger', 'wtSavedFail', { error: parsed.error })
    return
  }
  const {
    autoOrigins: _auto,
    siteScopeHosts: _scope,
    customHeadersRevision: _rev,
    ...patch
  } = parsed.config
  if (await patchConfig(patch)) {
    showToast('success', 'wtBackupImported')
  }
}

onMounted(() => {
  void loadAll()
})
</script>

<style scoped>
.wt-tools-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.wt-inline-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.wt-field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}
.wt-field-label {
  font-weight: 500;
}
.wt-subsection-title {
  margin: 16px 0 6px;
  font-size: 0.95rem;
}
.wt-compact-list {
  list-style: none;
  padding: 0;
  margin: 10px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wt-compact-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
}
.wt-compact-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wt-compact-meta {
  font-size: 0.8rem;
  color: var(--text-muted);
  word-break: break-all;
}
.wt-compact-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
