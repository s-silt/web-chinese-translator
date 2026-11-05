<template>
  <main class="popup" :class="{ 'is-loading': !settingsReady }">
    <header class="popup-header">
      <img class="popup-logo" :src="LOGO_URL" width="20" height="20" alt="" />
      <div class="popup-brand">
        <h1 class="popup-title">{{ t('appName') }}</h1>
        <span v-if="version" class="popup-version" data-test="version">v{{ version }}</span>
      </div>
      <UiButton
        v-if="settings.uiStyle !== 'cyber'"
        class="popup-end"
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
    </header>

    <section class="popup-section popup-status">
      <h2 class="section-title">{{ t(translationSupported ? 'wtExtensionSection' : 'wtGithubSection') }}</h2>
      <UiSwitch
        class="popup-enable"
        :label="t('enable')"
        :checked="settings.enabled"
        :disabled="!settingsReady"
        @change="setEnabled"
      />
      <div v-if="!translationSupported || state === 'unauthorized' || state === 'not-ready'" class="popup-row">
        <span>{{ t('status') }}</span>
        <span class="popup-row-end">
          <span class="state" :class="`state-${state}`" role="status" data-test="state">
            <span class="state-dot" aria-hidden="true"></span>
            {{ t(PAGE_STATE_MESSAGE[state]) }}
          </span>
          <UiButton v-if="state === 'not-ready'" size="sm" @click="reloadTab">{{ t('reload') }}</UiButton>
          <UiButton v-else-if="state === 'unauthorized'" variant="primary" size="sm" @click="authorize">
            {{ t('authorize') }}
          </UiButton>
        </span>
      </div>
    </section>

    <TranslationControls v-if="translationSupported" class="popup-section" />

    <footer class="popup-footer">
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
import TranslationControls from './TranslationControls.vue'
import { isFirefoxBuild } from '../../shared/extension'

const translationSupported = !isFirefoxBuild()
import { PAGE_STATE_MESSAGE, usePopup } from './usePopup'

/** 扩展图标（public/ 下的文件）。用绑定而非静态属性：模板里静态的绝对路径会被编译成模块导入 */
const LOGO_URL = '/icon/48.png'

useUiPreferencesSync()
const { t } = useI18n()

const {
  version,
  settings,
  settingsReady,
  state,
  setEnabled,
  cycleTheme,
  authorize,
  reloadTab,
  openOptions,
} = usePopup()

const themeLabel = computed(() => t('appearanceCurrent', { mode: t(THEME_MESSAGE[settings.value.theme]) }))
</script>

<style scoped>
/*
 * 宽度：中文界面下语言标签（4 字）与下拉（最小 180px）同一行，英文界面下拉换到标签下方。
 * 不设高度上限、不做内层滚动：内容低于弹出页上限 600px；超出时（页面缩放、最小字号）整页滚动。
 * Chromium 不随窗口收窄：自适应尺寸时先在很窄的窗口里排版，收窄后内容变高、超出上限，
 * 量出的宽度带上了滚动条；内容恢复 300px 后滚动条消失，宽度不变，右侧留下一条空白。
 * min-width：弹出页比 300px 宽时铺满，不留空白；计算弹出页宽度时百分比不计，仍为 300px
 */
.popup {
  width: 300px;
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

/* 排在一行的末尾（顶部的外观按钮、底部的存储库链接） */
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

/* 总开关与当前页状态：同属当前页，放在一个分区 */
.popup-status {
  gap: 8px;
}

.popup-enable {
  font-weight: 600;
}

.popup-details > summary {
  cursor: pointer;
  user-select: none;
}

.popup-details[open] {
  gap: 12px;
}

.popup-details :deep(section) {
  display: grid;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--gcn-border-muted);
}

/* 状态：标签在左，状态与操作在右，与上方开关右缘对齐 */
.popup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: var(--gcn-control-sm);
}

.popup-row-end {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.state {
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

.state-dot {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}

.state-translated {
  color: var(--gcn-success-fg);
  background: var(--gcn-success-bg);
}

.state-not-ready {
  color: var(--gcn-attention-fg);
  background: var(--gcn-attention-bg);
}

.state-unauthorized {
  color: var(--gcn-danger-fg);
  background: var(--gcn-danger-bg);
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
