<template>
  <section class="section" aria-labelledby="wt-dictionary-title">
    <h2 id="wt-dictionary-title" class="section-title">{{ t('wtDictionary') }}</h2>

    <h3 class="wt-subtitle">{{ t('wtDictionaryBuiltin') }}</h3>
    <div class="wt-builtin-groups">
      <div
        v-for="group in builtinGroups"
        :key="group.category"
        class="wt-builtin-group"
        role="group"
        :aria-labelledby="`wt-dict-heading-${group.category}`"
        :data-test="`wt-dict-group-${group.category}`"
      >
        <h4 :id="`wt-dict-heading-${group.category}`" class="wt-builtin-heading">
          {{ t(group.label) }}<span class="wt-builtin-count">{{ t('wtDictionaryGroupItems', { count: group.rows.length }) }}</span>
        </h4>
        <ul class="wt-builtins">
          <li v-for="row in group.rows" :key="row.id" class="wt-builtin-card">
            <UiSwitch
              class="wt-builtin-switch"
              :label="row.label"
              :checked="row.enabled"
              :disabled="!ready || busy"
              :data-test="`wt-dict-${row.id}`"
              @change="setBuiltin(row.id, $event)"
            />
            <span class="wt-builtin-hosts">{{ row.hosts }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div class="wt-custom-group">
      <h3 class="wt-subtitle">{{ t('wtDictionaryCustom') }}</h3>
      <ul v-if="custom.length > 0" class="wt-sites">
        <li v-for="row in custom" :key="row.id" class="wt-dict-row" :data-test="`wt-custom-dict-${row.id}`">
          <div class="wt-dict-info">
            <span class="wt-origin">{{ row.label }}</span>
            <span class="wt-hint">{{ row.hosts.join(', ') }}</span>
            <span class="wt-hint">{{ t('wtDictionaryEntryCount', { count: entryCount(row) }) }}</span>
          </div>
          <div class="wt-dict-actions">
            <UiSwitch
              :label="t('wtDictionaryEnabled')"
              :checked="row.enabled"
              :disabled="busy"
              :data-test="`wt-dict-enabled-${row.id}`"
              @change="setCustomEnabled(row.id, $event)"
            />
            <UiButton size="sm" :disabled="busy" :data-test="`wt-dict-edit-${row.id}`" @click="startEdit(row)">
              {{ t('wtDictionaryEdit') }}
            </UiButton>
            <UiButton size="sm" :disabled="busy" :data-test="`wt-dict-export-${row.id}`" @click="exportDictionary(row)">
              {{ t('wtDictionaryExport') }}
            </UiButton>
            <UiButton size="sm" :disabled="busy" :data-test="`wt-dict-remove-${row.id}`" @click="removeDictionary(row.id)">
              {{ t('delete') }}
            </UiButton>
          </div>
        </li>
      </ul>
      <p v-else class="wt-hint">{{ t('wtDictionaryEmpty') }}</p>

      <div class="section-actions">
        <UiButton :disabled="!ready || busy || editing !== undefined" data-test="wt-dict-new" @click="startNew">
          {{ t('wtDictionaryNew') }}
        </UiButton>
        <UiButton :disabled="!ready || busy || editing !== undefined" data-test="wt-dict-import" @click="chooseImport">
          {{ t('wtDictionaryImport') }}
        </UiButton>
        <input ref="fileInput" type="file" accept="application/json" hidden @change="onImportPicked" />
      </div>
    </div>

    <form v-if="editing !== undefined" class="wt-dict-form" data-test="wt-dict-form" @submit.prevent="saveDraft">
      <UiInput v-model="draftLabel" :disabled="busy" :placeholder="t('wtDictionaryName')" data-test="wt-dict-name" />
      <UiInput v-model="draftHosts" :disabled="busy" :placeholder="t('wtDictionaryHostsPlaceholder')" data-test="wt-dict-hosts" />
      <UiTextarea
        v-model="draftEntries"
        mono
        rows="8"
        spellcheck="false"
        autocomplete="off"
        :disabled="busy"
        :placeholder="t('wtDictionaryEntriesPlaceholder')"
        data-test="wt-dict-entries"
      />
      <div class="section-actions">
        <UiButton variant="primary" :disabled="busy" data-test="wt-dict-save" type="submit">{{ t('save') }}</UiButton>
        <UiButton :disabled="busy" data-test="wt-dict-cancel" @click="cancelEdit">{{ t('cancel') }}</UiButton>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import UiButton from '../../components/ui/UiButton.vue'
import UiInput from '../../components/ui/UiInput.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import UiTextarea from '../../components/ui/UiTextarea.vue'
import { useI18n } from '../../components/ui-preferences'
import type { MessageKey } from '../../i18n'
import { DICTIONARY_CATEGORIES, type DictionaryCategory } from '../../translation/dictionaries/index'
import { useCustomDictionaries } from './useCustomDictionaries'
import type { CustomDictionary } from '../../translation/custom-dictionaries'

const { t } = useI18n()
const {
  ready, busy, builtins, custom, editing,
  draftLabel, draftHosts, draftEntries,
  setBuiltin, setCustomEnabled, startNew, startEdit, cancelEdit,
  saveDraft, removeDictionary, exportDictionary, importFile,
} = useCustomDictionaries()

const CATEGORY_LABELS: Record<DictionaryCategory, MessageKey> = {
  'ai-code': 'wtDictionaryCategoryAiCode',
  'ai-model': 'wtDictionaryCategoryAiModel',
  cloud: 'wtDictionaryCategoryCloud',
  code: 'wtDictionaryCategoryCode',
  design: 'wtDictionaryCategoryDesign',
  community: 'wtDictionaryCategoryCommunity',
}

const builtinGroups = computed(() =>
  DICTIONARY_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    rows: builtins.value.filter((row) => row.category === category),
  })).filter((group) => group.rows.length > 0),
)

const fileInput = ref<HTMLInputElement | undefined>()

function entryCount(row: CustomDictionary): number {
  return Object.keys(row.entries).length
}

function chooseImport(): void {
  fileInput.value?.click()
}

async function onImportPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file !== undefined) await importFile(file)
}
</script>

<style scoped>
.wt-subtitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--gcn-fg);
}

.wt-builtin-groups {
  display: grid;
  gap: 24px;
}

.wt-builtin-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.wt-builtin-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--gcn-fg);
}

.wt-builtin-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--gcn-fg-muted);
}

.wt-builtins {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (max-width: 680px) {
  .wt-builtins {
    grid-template-columns: minmax(0, 1fr);
  }
}

.wt-builtin-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'name switch'
    'hosts switch';
  align-items: center;
  column-gap: 12px;
  row-gap: 2px;
  padding: 10px 14px;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius-lg);
}

.wt-builtin-switch {
  display: contents;
}

.wt-builtin-switch :deep(.ui-switch-label) {
  grid-area: name;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--gcn-fg);
}

.wt-builtin-switch :deep(.ui-switch-track) {
  grid-area: switch;
}

.wt-builtin-hosts {
  grid-area: hosts;
  font-size: 12px;
  line-height: 1.4;
  color: var(--gcn-fg-muted);
  overflow-wrap: anywhere;
}

.wt-custom-group {
  display: grid;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--gcn-border-muted);
}

.wt-sites {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wt-dict-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 14px;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius-lg);
}

.wt-dict-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wt-origin {
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.wt-hint {
  font-size: 12px;
  color: var(--gcn-fg-muted);
  overflow-wrap: anywhere;
}

.wt-dict-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.wt-dict-form {
  display: grid;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--gcn-border-muted);
}
</style>
