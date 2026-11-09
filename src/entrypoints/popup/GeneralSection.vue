<template>
  <section class="ui-group" aria-labelledby="general-title">
    <h3 id="general-title" class="ui-subtitle">{{ t('general') }}</h3>
    <ul class="toggle-list">
      <li v-for="option in OPTIONS" :key="option.key">
        <UiSwitch
          :label="t(option.label)"
          :checked="settings[option.key]"
          :disabled="!ready"
          @change="setOption(option.key, $event)"
        />
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { createToastSource } from '../../components/toast'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { useI18n } from '../../components/ui-preferences'
import { useSettings } from '../../components/useSettings'
import type { MessageKey } from '../../i18n'
import type { BooleanSettingKey, Settings } from '../../shared/settings'

interface ToggleOption {
  readonly key: BooleanSettingKey
  readonly label: MessageKey
}

/** 总开关在弹出页顶部，这里不重复 */
const OPTIONS: readonly ToggleOption[] = [
  { key: 'translateTime', label: 'translateTime' },
  { key: 'translateTitle', label: 'translateTitle' },
]

const { t } = useI18n()
// 读取前显示的是默认值：与顶部总开关一样先不可用
const { settings, ready, update } = useSettings()
// 保存失败时在页面顶部提示；再次保存成功时收起
const toast = createToastSource()

async function setOption(key: BooleanSettingKey, value: boolean): Promise<void> {
  const patch: Partial<Settings> = { [key]: value }
  if (await update(patch)) toast.clear()
  else toast.show('danger', 'saveFailed')
}
</script>

<style scoped>
.toggle-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
