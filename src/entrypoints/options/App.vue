<template>
  <div class="options">
    <aside class="options-side">
      <header class="options-header">
        <img class="options-logo" :src="LOGO_URL" width="32" height="32" alt="" />
        <div class="options-brand">
          <h1 class="options-title">{{ t('appName') }}</h1>
          <span class="options-subtitle">{{ t('brandSubtitle') }}</span>
          <span v-if="version" class="options-version" data-test="version">v{{ version }}</span>
        </div>
      </header>

      <nav class="options-nav" aria-label="Sections">
        <div v-for="group in navGroups" :key="group.key" class="options-nav-group">
          <span class="options-nav-group-title">{{ t(group.key) }}</span>
          <a
            v-for="link in group.links"
            :key="link.target"
            :href="`#${link.target}`"
            :aria-current="currentNav === link.target ? 'page' : undefined"
            :data-test="`nav-${link.target}`"
            @click="scrollToSection(link.target, $event)"
          >
            {{ t(link.key) }}
          </a>
        </div>
      </nav>
    </aside>

    <main class="options-main">
      <div v-if="noticeKey && !noticeDismissed" class="section wt-page-notice" role="alert" data-test="wt-page-notice">
        <span>{{ t(noticeKey) }}</span>
        <UiButton size="sm" data-test="wt-notice-dismiss" @click="noticeDismissed = true">{{ t('wtNoticeDismiss') }}</UiButton>
      </div>
      <DictionarySection v-if="translationSupported" v-show="currentNav === 'wt-dictionary-title'" />
      <TranslationSection v-if="translationSupported" v-show="showTranslation" :view="translationView" />
      <div v-show="currentNav === 'github-title'" id="github-title" class="wt-github-group" role="region" :aria-label="t('navGithub')">
        <div class="section wt-github-preferences">
          <h2 id="github-preferences-title" class="section-title">{{ t('navGithub') }}</h2>
          <GeneralSection />
          <LanguageSection />
        </div>
        <ExcludedPathsSection />
        <CustomEntriesSection />
      </div>
      <AppearanceSection v-if="translationSupported" v-show="currentNav === 'appearance-title'" />
      <section v-show="currentNav === 'about-title'" class="section" aria-labelledby="about-title">
        <h2 id="about-title" class="section-title">{{ t('about') }}</h2>
        <dl class="pairs">
          <dt>{{ t('githubRepository') }}</dt>
          <dd>
            <a class="link" :href="REPOSITORY_URL" target="_blank" rel="noreferrer" data-test="repository">
              {{ REPOSITORY_LABEL }}
            </a>
          </dd>
        </dl>
      </section>
    </main>

    <ToastHost />
  </div>
</template>

<script setup lang="ts">
import ToastHost from '../../components/ToastHost.vue'
import UiButton from '../../components/ui/UiButton.vue'
import { useI18n, useUiPreferencesSync } from '../../components/ui-preferences'
import { getExtensionVersion, isFirefoxBuild, REPOSITORY_URL } from '../../shared/extension'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppearanceSection from './AppearanceSection.vue'
import CustomEntriesSection from './CustomEntriesSection.vue'
import type { MessageKey } from '../../i18n'
import DictionarySection from './DictionarySection.vue'
import ExcludedPathsSection from './ExcludedPathsSection.vue'
import GeneralSection from '../popup/GeneralSection.vue'
import LanguageSection from '../popup/LanguageSection.vue'
import TranslationSection from './TranslationSection.vue'

const translationSupported = !isFirefoxBuild()

/** 扩展图标（public/ 下的文件）。用绑定而非静态属性：模板里静态的绝对路径会被编译成模块导入 */
const LOGO_URL = '/icon/96.png'
/** 显示的存储库地址：省略协议 */
const REPOSITORY_LABEL = REPOSITORY_URL.replace(/^https:\/\//, '')

useUiPreferencesSync()
const { t } = useI18n()
const version = getExtensionVersion()

type NavGroupKey = 'navGroupGeneral' | 'navGroupTranslation' | 'navGroupDictionary' | 'navGroupAdvanced'

const navLinks: readonly { target: string; key: MessageKey; group: NavGroupKey }[] = translationSupported ? [
  { target: 'wt-general-title', key: 'navGeneral', group: 'navGroupGeneral' },
  { target: 'appearance-title', key: 'navAppearance', group: 'navGroupGeneral' },
  { target: 'wt-title', key: 'navModel', group: 'navGroupTranslation' },
  { target: 'wt-dictionary-title', key: 'navSites', group: 'navGroupDictionary' },
  { target: 'github-title', key: 'navGithub', group: 'navGroupDictionary' },
  { target: 'about-title', key: 'navAbout', group: 'navGroupAdvanced' },
] : [
  { target: 'github-title', key: 'navGithub', group: 'navGroupDictionary' },
  { target: 'about-title', key: 'navAbout', group: 'navGroupAdvanced' },
]
const navGroupOrder: readonly NavGroupKey[] = [
  'navGroupGeneral',
  'navGroupTranslation',
  'navGroupDictionary',
  'navGroupAdvanced',
]
const navGroups = navGroupOrder
  .map((key) => ({ key, links: navLinks.filter((link) => link.group === key) }))
  .filter((group) => group.links.length > 0)
const defaultNav = translationSupported ? 'wt-general-title' : 'github-title'

function resolveNav(hash: string): string {
  const raw = hash.replace(/^#/, '')
  const target = raw === 'wt-site-settings-title' ? 'wt-dictionary-title' : raw
  return navLinks.some((link) => link.target === target) ? target : defaultNav
}

const currentNav = ref(resolveNav(window.location.hash))
const showTranslation = computed(() =>
  ['wt-general-title', 'wt-title', 'wt-dictionary-title'].includes(currentNav.value),
)
const translationView = computed<'general' | 'model' | 'sites'>(() =>
  currentNav.value === 'wt-title' ? 'model' : currentNav.value === 'wt-dictionary-title' ? 'sites' : 'general',
)
const notice = new URLSearchParams(window.location.search).get('notice')
const noticeKey: MessageKey | undefined = notice === 'disabled'
  ? 'wtPageDisabled'
  : notice === 'page-unavailable' ? 'wtPageUnavailable' : undefined
const noticeDismissed = ref(false)

async function focusSection(target: string): Promise<void> {
  await nextTick()
  if (target !== currentNav.value) return
  const element = document.getElementById(target)
  if (!(element instanceof HTMLElement)) return
  element.setAttribute('tabindex', '-1')
  if (document.activeElement !== element) element.focus({ preventScroll: true })
  element.scrollIntoView?.({ behavior: 'auto', block: 'start' })
}

function scrollToSection(target: string, event: Event): void {
  event.preventDefault()
  currentNav.value = resolveNav(`#${target}`)
  window.location.hash = currentNav.value
  void focusSection(currentNav.value)
}

function onHashChange(): void {
  currentNav.value = resolveNav(window.location.hash)
  void focusSection(currentNav.value)
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  void focusSection(currentNav.value)
})
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))
</script>

<style scoped>
.wt-github-preferences {
  display: grid;
  gap: 16px;
}

.options {
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 24px 48px;
}

.options-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 24px;
  margin-bottom: 8px;
}

/* 图标自带深色底：描一圈细边，深色背景上也能看出轮廓 */
.options-logo {
  flex: none;
  border-radius: 7px;
  box-shadow: 0 0 0 1px var(--gcn-border-muted);
}

/* 名称与版本号按文字基线对齐；窄屏时版本号换到下一行 */
.options-brand {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 8px;
  min-width: 0;
}

.options-title {
  font-size: 24px;
  font-weight: 600;
}

.options-version {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  color: var(--gcn-fg-muted);
  white-space: nowrap;
}

.options-main {
  display: grid;
  gap: 28px;
}

.wt-github-group {
  display: grid;
  gap: 28px;
}

.wt-page-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
  line-height: 1.6;
}

.wt-page-notice > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 窄屏时值换到名称下方 */
.pairs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 16px;
  margin: 0;
  padding: 14px 16px;
  background: var(--gcn-bg-muted);
  border: 1px solid var(--gcn-border-muted);
  border-radius: var(--gcn-radius-lg);
}

.pairs dt {
  font-weight: 500;
}

.pairs dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.link {
  color: var(--gcn-accent);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.options-subtitle {
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--gcn-eyebrow);
  text-transform: uppercase;
}

/* 分区导航：经典风格为胶囊标签；cyber/glass 在 styles/*.css 中覆盖颜色与排布 */
.options-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 0 0 24px;
}

.options-nav-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.options-nav-group-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--gcn-fg-muted);
}

.options-nav a {
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--gcn-border);
  color: var(--gcn-fg);
  text-decoration: none;
}

.options-nav a[aria-current='page'] {
  color: var(--gcn-accent);
  background: var(--gcn-selection);
}
</style>
