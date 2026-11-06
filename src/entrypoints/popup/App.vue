<template>
  <main class="popup" :class="{ 'is-loading': !settingsReady }">
    <header class="popup-header">
      <img class="popup-logo" :src="LOGO_URL" width="20" height="20" alt="" />
      <div class="popup-brand">
        <h1 class="popup-title">{{ t('appName') }}</h1>
        <span v-if="version" class="popup-version" data-test="version">v{{ version }}</span>
      </div>
      <div class="popup-header-actions">
        <UiButton
          v-if="settings.uiStyle !== 'cyber'"
          variant="invisible"
          size="sm"
          icon
          :aria-label="themeLabel"
          :title="themeLabel"
          :disabled="!settingsReady"
          data-test="theme-toggle"
          @click="cycleTheme"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="popup-icon">
            <template v-if="settings.theme === 'light'">
              <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5" />
              <path
                d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </template>
            <path
              v-else-if="settings.theme === 'dark'"
              d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <template v-else>
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" />
              <path d="M8 2a6 6 0 0 0 0 12Z" fill="currentColor" />
            </template>
          </svg>
        </UiButton>
        <UiSwitch
          class="popup-enable"
          :label="t('enable')"
          :checked="settings.enabled"
          :disabled="!settingsReady"
          @change="setEnabled"
        />
      </div>
    </header>

    <PageStatusCard v-if="translationSupported" class="popup-section" />

    <TranslationControls
      class="popup-section"
      :github-state="state"
      :github-page="tab !== undefined"
      @authorize="authorize"
      @reload="reloadTab"
    />

    <footer class="popup-footer">
      <template v-if="translationSupported">
        <UiButton variant="invisible" size="sm" data-test="wt-open-site-settings" @click="openOptionsAt('#wt-dictionary-title')">
          {{ t('wtOpenSiteSettings') }}
        </UiButton>
        <UiButton variant="invisible" size="sm" data-test="wt-open-model-settings" @click="openOptionsAt('#wt-title')">
          {{ t('wtOpenModelSettings') }}
        </UiButton>
      </template>
      <UiButton
        class="popup-end"
        variant="invisible"
        size="sm"
        icon
        :aria-label="t('wtSettings')"
        :title="t('wtSettings')"
        data-test="settings"
        @click="openOptions"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="popup-icon">
          <path
            fill="currentColor"
            fill-rule="evenodd"
            d="M10.2 2.4h3.6l.45 2.05a7.8 7.8 0 0 1 1.72.99l1.9-.78 1.8 3.12-1.45 1.5c.08.55.08 1.12 0 1.67l1.45 1.5-1.8 3.12-1.9-.78a7.8 7.8 0 0 1-1.72.99l-.45 2.05h-3.6l-.45-2.05a7.8 7.8 0 0 1-1.72-.99l-1.9.78-1.8-3.12 1.45-1.5a7.6 7.6 0 0 1 0-1.67l-1.45-1.5 1.8-3.12 1.9.78a7.8 7.8 0 0 1 1.72-.99L10.2 2.4ZM12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm0 2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Z"
          />
        </svg>
      </UiButton>
    </footer>

    <ToastHost />
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ToastHost from '../../components/ToastHost.vue'
import UiButton from '../../components/ui/UiButton.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { THEME_MESSAGE, useI18n, useUiPreferencesSync } from '../../components/ui-preferences'
import { isFirefoxBuild } from '../../shared/extension'
import PageStatusCard from './PageStatusCard.vue'
import TranslationControls from './TranslationControls.vue'
import { usePopup } from './usePopup'
import { provideTranslationControls } from './useTranslationControls'

const translationSupported = !isFirefoxBuild()

/** 扩展图标（public/ 下的文件）。用绑定而非静态属性：模板里静态的绝对路径会被编译成模块导入 */
const LOGO_URL = '/icon/48.png'

useUiPreferencesSync()
const { t } = useI18n()
const translation = provideTranslationControls()

const {
  version,
  settings,
  settingsReady,
  tab,
  state,
  setEnabled,
  cycleTheme,
  authorize,
  reloadTab,
  openOptions,
} = usePopup()

const themeLabel = computed(() => t('appearanceCurrent', { mode: t(THEME_MESSAGE[settings.value.theme]) }))

function openOptionsAt(hash: string): void {
  void translation.openOptionsAt(hash)
}
</script>

<style scoped>
/*
 * 宽度：中文界面下语言标签（4 字）与下拉（最小 180px）同一行，英文界面下拉换到标签下方。
 * 不设高度上限、不做内层滚动：内容低于弹出页上限 600px；超出时（页面缩放、最小字号）整页滚动。
 * Chromium 不随窗口收窄：自适应尺寸时先在很窄的窗口里排版，收窄后内容变高、超出上限，
 * 量出的宽度带上了滚动条；内容恢复 320px 后滚动条消失，宽度不变，右侧留下一条空白。
 * min-width：弹出页比 320px 宽时铺满，不留空白；计算弹出页宽度时百分比不计，仍为 320px
 */
.popup {
  width: 320px;
  min-width: 100%;
}

/* Firefox 出现占宽的纵向滚动条时不加宽弹出页：随之收窄，不出横向滚动条（判断方式同 theme.css 的滚动条样式） */
@supports not selector(::-webkit-scrollbar) {
  .popup {
    max-width: 100%;
  }
}

/* 设置读取前显示的是默认值，避免开关从默认状态动画切换 */
.popup.is-loading :deep(*) {
  transition: none !important;
}

/* 右侧是图标按钮：内边距小一些，图标与下方开关的右缘对齐 */
.popup-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 10px 12px 10px 16px;
  background: var(--gcn-bg-muted);
  border-bottom: 1px solid var(--gcn-border-muted);
}

.popup-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 图标自带深色底：描一圈细边，深色背景上也能看出轮廓 */
.popup-logo {
  flex: none;
  border-radius: 6px;
  box-shadow: 0 0 0 1px var(--gcn-border-muted);
}

/* 名称与版本号按文字基线对齐 */
.popup-brand {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.popup-title {
  font-size: 14px;
  font-weight: 600;
}

.popup-version {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--gcn-fg-muted);
  white-space: nowrap;
}

/* 排在一行的末尾（底部的设置齿轮） */
.popup-end {
  margin-left: auto;
}

.popup-icon {
  display: block;
}

/* 也用于常规、语言两个分区组件的根元素（模板中以 class 传入） */
.popup-section {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--gcn-border-muted);
}

.popup-section.popup-card {
  margin: 12px 12px 0;
  padding: 12px;
  border-bottom: 0;
}

/* 总开关：标签给读屏，视觉上只留大号开关 */
.popup-enable {
  position: relative;
  flex: none;
  gap: 0;
  min-height: 24px;
  font-weight: 600;
}

.popup-enable :deep(.ui-switch-label) {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.popup-enable :deep(.ui-switch-track) {
  width: 44px;
  height: 24px;
  border-radius: 12px;
}

.popup-enable :deep(.ui-switch-knob) {
  width: 20px;
  height: 20px;
}

.popup-enable :deep(.ui-switch-track[aria-checked='true'] .ui-switch-knob),
.popup-enable :deep(.ui-switch-track[aria-checked='true'] > .ui-switch-ripple) {
  transform: translateX(20px);
}

.popup-enable :deep(.ui-switch-track > .ui-switch-ripple) {
  top: -6px;
  left: -6px;
  width: 36px;
  height: 36px;
}

/* 右侧同顶部：图标与上方开关的右缘对齐 */
.popup-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 12px 16px;
  background: var(--gcn-bg-muted);
}
</style>
