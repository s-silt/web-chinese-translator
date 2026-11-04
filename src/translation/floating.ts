import type { UiStyle } from '../shared/settings'

export interface FloatingPosition {
  readonly side: 'left' | 'right'
  readonly ratio: number
  readonly collapsed: boolean
}

export interface FloatingView {
  readonly visible: boolean
  readonly hostname: string
  readonly fixedOn: boolean
  readonly autoEnabled: boolean
  readonly pageOn?: boolean
  readonly configured: boolean
  readonly restored: boolean
  readonly canRestore: boolean
  readonly resumable: boolean
  readonly busy: boolean
  readonly checking: boolean
  readonly error: string
}

export type FloatingAction = 'translate-page' | 'toggle-auto' | 'restore' | 'resume' | 'settings'

export interface FloatingLabels {
  readonly title: string
  readonly open: string
  readonly expand: string
  readonly close: string
  readonly move: string
  readonly translatePage: string
  readonly enable: string
  readonly disable: string
  readonly autoTranslate?: string
  readonly fold: string
  readonly disclosure: string
  readonly consent: string
  readonly confirm: string
  readonly cancel: string
  readonly restore: string
  readonly resume: string
  readonly settings: string
  readonly configure: string
  readonly fixedOn: string
  readonly modelOn: string
  readonly modelOff: string
  readonly pageOn: string
  readonly restored: string
  readonly paused: string
  readonly loading: string
  readonly positionFailed: string
}

export interface FloatingCallbacks {
  readonly imageUrl: string
  readonly readPosition: () => Promise<unknown>
  readonly writePosition: (position: FloatingPosition) => Promise<void>
  readonly onOpen: () => void
  readonly onAction: (action: FloatingAction) => void
}

export interface FloatingEntry {
  update(view: FloatingView, labels: FloatingLabels, callbacks: FloatingCallbacks): void
  setStyle(style: UiStyle): void
  closeMenu(returnFocus?: boolean): void
  isMenuOpen(): boolean
  reposition(): void
  getAnchor(): FloatingAnchor | undefined
  setNoticeVisible(visible: boolean): void
  dispose(): void
}

export interface FloatingAnchor {
  readonly side: 'left' | 'right'
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

const BUTTON = 40
const MARGIN = 12
const AVOID = 6
const VISIBLE_COLLAPSED = 20
const DRAG_PX = 5
const NUDGE_PX = 20
const MENU_MAX = 232
const AUTO_DOCK_MS = 900

const DEFAULT_POSITION: FloatingPosition = { side: 'right', ratio: 0.5, collapsed: true }

const FLOATING_CSS = `
.floating-entry, .floating-menu {
  --wt-floating-scale: 1;
  box-sizing: border-box;
  font: calc(13px / var(--wt-floating-scale))/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.floating-entry {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  width: calc(${BUTTON}px / var(--wt-floating-scale));
  height: calc(${BUTTON}px / var(--wt-floating-scale));
  padding: 0;
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: calc(14px / var(--wt-floating-scale));
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.8);
  cursor: pointer;
  pointer-events: auto;
  touch-action: none;
}
.floating-entry:hover {
  background: #f6f8fa;
  border-color: #afb8c1;
}
.floating-entry img {
  width: calc(38px / var(--wt-floating-scale));
  height: calc(38px / var(--wt-floating-scale));
  border-radius: calc(9px / var(--wt-floating-scale));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
  pointer-events: none;
}
.floating-entry.is-dragging { transition: none; }
@media (prefers-reduced-motion: no-preference) {
  .floating-entry { transition: left 120ms ease, top 120ms ease, border-color 100ms ease, background-color 100ms ease; }
  .floating-menu button { transition: background-color 100ms ease, border-color 100ms ease, color 100ms ease; }
}
@media (prefers-reduced-motion: reduce) {
  .floating-entry, .floating-menu, .floating-menu button { transition: none; }
}
.floating-entry:focus-visible, .floating-menu button:focus-visible, .floating-menu input:focus-visible {
  outline: 2px solid #0969da;
  outline-offset: 2px;
}
.floating-menu {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: calc(8px / var(--wt-floating-scale));
  width: calc(${MENU_MAX}px / var(--wt-floating-scale));
  padding: calc(12px / var(--wt-floating-scale));
  color: #1f2328;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: calc(12px / var(--wt-floating-scale));
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
  pointer-events: auto;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
}
/* 类选择器的 display 会盖过浏览器默认的 [hidden]{display:none}：hidden 时必须显式不渲染，否则会挡住页面点击 */
.floating-menu[hidden], .floating-consent[hidden], .floating-menu [hidden] { display: none !important; }
.floating-head {
  display: flex;
  flex-direction: column;
  gap: calc(2px / var(--wt-floating-scale));
  padding-bottom: calc(8px / var(--wt-floating-scale));
  border-bottom: 1px solid #eaeef2;
}
.floating-title {
  font-weight: 600;
  font-size: calc(14px / var(--wt-floating-scale));
  line-height: calc(20px / var(--wt-floating-scale));
}
.floating-host, .floating-disclosure, .floating-configure, .floating-error {
  margin: 0;
  font-size: calc(12px / var(--wt-floating-scale));
  line-height: calc(18px / var(--wt-floating-scale));
}
.floating-host, .floating-disclosure { color: #57606a; }
.floating-configure {
  padding: calc(6px / var(--wt-floating-scale)) calc(8px / var(--wt-floating-scale));
  color: #7d4e00;
  background: #fff8c5;
  border: 1px solid #eac54f66;
  border-radius: calc(6px / var(--wt-floating-scale));
}
.floating-status {
  display: flex;
  flex-direction: column;
  gap: calc(2px / var(--wt-floating-scale));
  padding: calc(6px / var(--wt-floating-scale)) calc(10px / var(--wt-floating-scale));
  font-size: calc(12px / var(--wt-floating-scale));
  font-weight: 500;
  line-height: calc(18px / var(--wt-floating-scale));
  background: #f6f8fa;
  border: 1px solid #eaeef2;
  border-radius: calc(8px / var(--wt-floating-scale));
}
.floating-consent {
  display: flex;
  align-items: flex-start;
  gap: calc(8px / var(--wt-floating-scale));
  padding: calc(8px / var(--wt-floating-scale)) calc(10px / var(--wt-floating-scale));
  font-size: calc(12px / var(--wt-floating-scale));
  line-height: calc(18px / var(--wt-floating-scale));
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: calc(8px / var(--wt-floating-scale));
  cursor: pointer;
}
.floating-consent input {
  flex: none;
  width: calc(15px / var(--wt-floating-scale));
  height: calc(15px / var(--wt-floating-scale));
  margin: calc(2px / var(--wt-floating-scale)) 0 0;
  accent-color: #0969da;
}
.floating-consent span {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
.floating-actions-main {
  display: flex;
  flex-direction: column;
  gap: calc(6px / var(--wt-floating-scale));
}
.floating-actions-sub {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: calc(6px / var(--wt-floating-scale));
  padding-top: calc(8px / var(--wt-floating-scale));
  border-top: 1px solid #eaeef2;
}
.floating-menu button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: calc(34px / var(--wt-floating-scale));
  min-width: 0;
  padding: calc(6px / var(--wt-floating-scale)) calc(10px / var(--wt-floating-scale));
  font: inherit;
  font-size: calc(12px / var(--wt-floating-scale));
  font-weight: 500;
  line-height: calc(18px / var(--wt-floating-scale));
  color: #1f2328;
  text-align: center;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: calc(8px / var(--wt-floating-scale));
}
.floating-menu button:hover:not(:disabled, [aria-disabled='true']) {
  background: #eaeef2;
  border-color: #afb8c1;
}
.floating-actions-sub button {
  min-height: calc(32px / var(--wt-floating-scale));
  color: #424a53;
  background: transparent;
  border-color: #d8dee4;
}
.floating-primary {
  font-weight: 600;
  color: #ffffff;
  background: #0969da;
  border-color: #0969da;
}
.floating-menu .floating-primary:hover:not(:disabled, [aria-disabled='true']) {
  background: #0860ca;
  border-color: #0860ca;
}
.floating-menu button:disabled, .floating-menu button[aria-disabled='true'] {
  color: #636c76;
  background: #eaeef2;
  border-color: #d0d7de;
  cursor: not-allowed;
}
.floating-error { color: #cf222e; font-weight: 500; }
.floating-move {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.floating-entry[data-style='cyber'] {
  color: #e7f4ff;
  background:
    linear-gradient(90deg, #55e5ff 8px, transparent 8px) 0 0 / 100% 1.5px no-repeat,
    linear-gradient(180deg, #55e5ff 8px, transparent 8px) 0 0 / 1.5px 100% no-repeat,
    linear-gradient(270deg, #55e5ff 8px, transparent 8px) 100% 100% / 100% 1.5px no-repeat,
    linear-gradient(0deg, #55e5ff 8px, transparent 8px) 100% 100% / 1.5px 100% no-repeat,
    #0b1526;
  border: 1px solid #2b4f6e;
  border-radius: calc(10px / var(--wt-floating-scale));
  box-shadow: 0 6px 20px rgba(2, 8, 20, 0.65);
}
.floating-entry[data-style='cyber']:hover {
  background-color: #101f36;
  border-color: #55e5ff;
}
.floating-menu[data-style='cyber'] {
  color: #e7f4ff;
  background:
    linear-gradient(90deg, #55e5ff 10px, transparent 10px) 0 0 / 100% 1.5px no-repeat,
    linear-gradient(180deg, #55e5ff 10px, transparent 10px) 0 0 / 1.5px 100% no-repeat,
    linear-gradient(270deg, #55e5ff 10px, transparent 10px) 100% 100% / 100% 1.5px no-repeat,
    linear-gradient(0deg, #55e5ff 10px, transparent 10px) 100% 100% / 1.5px 100% no-repeat,
    #0b1526;
  border: 1px solid #264561;
  border-radius: calc(10px / var(--wt-floating-scale));
  box-shadow: 0 10px 28px rgba(2, 8, 20, 0.72), 0 0 20px rgba(26, 166, 217, 0.08);
}
.floating-menu[data-style='cyber'] .floating-head,
.floating-menu[data-style='cyber'] .floating-actions-sub {
  border-color: #1e3850;
}
.floating-menu[data-style='cyber'] .floating-status,
.floating-menu[data-style='cyber'] .floating-consent {
  background: #101c2e;
  border-color: #264561;
}
.floating-menu[data-style='cyber'] .floating-consent input {
  accent-color: #55e5ff;
}
.floating-menu[data-style='cyber'] .floating-configure {
  color: #ffd166;
  background: #2b2310;
  border-color: #6b531b;
}
.floating-menu[data-style='cyber'] button {
  color: #e7f4ff;
  background: #101c2e;
  border-color: #2b4f6e;
}
.floating-menu[data-style='cyber'] .floating-actions-sub button {
  color: #b8cde3;
  background: transparent;
  border-color: #203c56;
}
.floating-menu[data-style='cyber'] button:hover:not(:disabled, [aria-disabled='true']) {
  background: #16263e;
  border-color: #3f73a1;
}
.floating-menu[data-style='cyber'] .floating-primary {
  color: #051c26;
  background: #55e5ff;
  border-color: #55e5ff;
}
.floating-menu[data-style='cyber'] .floating-primary:hover:not(:disabled, [aria-disabled='true']) {
  background: #7fecff;
  border-color: #7fecff;
}
.floating-menu[data-style='cyber'] button:disabled, .floating-menu[data-style='cyber'] button[aria-disabled='true'],
.floating-menu[data-style='cyber'] .floating-primary:disabled, .floating-menu[data-style='cyber'] .floating-primary[aria-disabled='true'] {
  color: #7c97b3;
  background: #122033;
  border-color: #213b54;
}
/* 深色底上的辅助说明不能沿用浅色主题的灰字（对比度不足） */
.floating-menu[data-style='cyber'] .floating-host, .floating-menu[data-style='cyber'] .floating-disclosure { color: #9cb4cf; }
.floating-menu[data-style='cyber'] .floating-error { color: #ff7b8a; }
.floating-entry[data-style='cyber']:focus-visible, .floating-menu[data-style='cyber'] button:focus-visible, .floating-menu[data-style='cyber'] input:focus-visible {
  outline-color: #55e5ff;
}
.floating-entry[data-style='glass'], .floating-menu[data-style='glass'] {
  color: #1d2b43;
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.85);
  border-radius: calc(16px / var(--wt-floating-scale));
  box-shadow: 0 10px 32px rgba(36, 56, 92, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.65);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}
.floating-entry[data-style='glass']:hover {
  background: rgba(255, 255, 255, 0.94);
}
.floating-menu[data-style='glass'] .floating-head,
.floating-menu[data-style='glass'] .floating-actions-sub {
  border-color: rgba(193, 205, 221, 0.6);
}
.floating-menu[data-style='glass'] .floating-status,
.floating-menu[data-style='glass'] .floating-consent {
  background: rgba(242, 246, 252, 0.85);
  border-color: rgba(193, 205, 221, 0.75);
}
.floating-menu[data-style='glass'] .floating-host,
.floating-menu[data-style='glass'] .floating-disclosure {
  color: #4a5c75;
}
.floating-menu[data-style='glass'] button {
  color: #1d2b43;
  background: rgba(255, 255, 255, 0.82);
  border-color: #c5d2e3;
  border-radius: calc(10px / var(--wt-floating-scale));
}
.floating-menu[data-style='glass'] .floating-actions-sub button {
  background: rgba(255, 255, 255, 0.45);
}
.floating-menu[data-style='glass'] button:hover:not(:disabled, [aria-disabled='true']) {
  background: #f5f8ff;
  border-color: #9cb1cc;
}
.floating-menu[data-style='glass'] .floating-primary {
  color: #ffffff;
  background: #1268e8;
  border-color: #1268e8;
}
.floating-menu[data-style='glass'] .floating-primary:hover:not(:disabled, [aria-disabled='true']) {
  background: #0f5ccf;
  border-color: #0f5ccf;
}
/* 主题的主按钮配色比通用禁用规则更具体：禁用态要单独压回灰色，否则未配置模型时仍像可点 */
.floating-menu[data-style='glass'] button:disabled, .floating-menu[data-style='glass'] button[aria-disabled='true'],
.floating-menu[data-style='glass'] .floating-primary:disabled, .floating-menu[data-style='glass'] .floating-primary[aria-disabled='true'] {
  color: #5b6d85;
  background: #e6ecf5;
  border-color: #c5d2e3;
}
/* 空间不够时菜单会压在入口上：此时入口让位（仍可聚焦，Escape 能把焦点还回来） */
.floating-entry.is-covered { opacity: 0; pointer-events: none; }
@media (prefers-color-scheme: dark) {
  .floating-entry:not([data-style='cyber']), .floating-menu:not([data-style='cyber']) {
    color: #e6edf3;
    background: #161b22;
    border-color: #30363d;
  }
  .floating-entry:not([data-style='cyber']):hover {
    background: #1f2630;
  }
  .floating-menu:not([data-style='cyber']) .floating-head,
  .floating-menu:not([data-style='cyber']) .floating-actions-sub {
    border-color: #30363d;
  }
  .floating-menu:not([data-style='cyber']) .floating-status,
  .floating-menu:not([data-style='cyber']) .floating-consent {
    background: #21262d;
    border-color: #30363d;
  }
  .floating-menu:not([data-style='cyber']) .floating-host,
  .floating-menu:not([data-style='cyber']) .floating-disclosure {
    color: #9ca6b2;
  }
  .floating-menu:not([data-style='cyber']) .floating-configure {
    color: #e3b341;
    background: #2d230f;
    border-color: #5c4617;
  }
  .floating-menu:not([data-style='cyber']) button {
    color: #e6edf3;
    background: #21262d;
    border-color: #3d444d;
  }
  .floating-menu:not([data-style='cyber']) .floating-actions-sub button {
    color: #c9d1d9;
    background: transparent;
  }
  .floating-menu:not([data-style='cyber']) button:hover:not(:disabled, [aria-disabled='true']) {
    background: #292f38;
    border-color: #656c76;
  }
  .floating-menu:not([data-style='cyber']) .floating-primary {
    color: #ffffff;
    background: #1f6feb;
    border-color: #1f6feb;
  }
  .floating-menu:not([data-style='cyber']) .floating-primary:hover:not(:disabled, [aria-disabled='true']) {
    background: #388bfd;
    border-color: #388bfd;
  }
  .floating-menu:not([data-style='cyber']) button:disabled, .floating-menu:not([data-style='cyber']) button[aria-disabled='true'] {
    color: #8b949e;
    background: #21262d;
    border-color: #30363d;
  }
  .floating-error { color: #f85149; }
  .floating-entry[data-style='glass'], .floating-menu[data-style='glass'] {
    color: #e6edf7;
    background: rgba(24, 34, 52, 0.86);
    border-color: rgba(255, 255, 255, 0.18);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.48);
  }
  .floating-entry[data-style='glass']:hover {
    background: rgba(32, 45, 68, 0.92);
  }
  .floating-menu[data-style='glass'] .floating-head,
  .floating-menu[data-style='glass'] .floating-actions-sub {
    border-color: rgba(255, 255, 255, 0.12);
  }
  .floating-menu[data-style='glass'] .floating-status,
  .floating-menu[data-style='glass'] .floating-consent {
    background: rgba(15, 23, 36, 0.72);
    border-color: rgba(255, 255, 255, 0.14);
  }
  .floating-menu[data-style='glass'] .floating-host,
  .floating-menu[data-style='glass'] .floating-disclosure {
    color: #a3b4cc;
  }
  .floating-menu[data-style='glass'] button {
    color: #e6edf7;
    background: rgba(30, 43, 64, 0.82);
    border-color: #33445e;
  }
  .floating-menu[data-style='glass'] .floating-actions-sub button {
    background: rgba(30, 43, 64, 0.4);
  }
  .floating-menu[data-style='glass'] button:hover:not(:disabled, [aria-disabled='true']) {
    background: #263650;
    border-color: #4d6487;
  }
  .floating-menu[data-style='glass'] .floating-primary {
    color: #ffffff;
    background: #2f7bff;
    border-color: #2f7bff;
  }
  .floating-menu[data-style='glass'] .floating-primary:hover:not(:disabled, [aria-disabled='true']) {
    background: #4a8cff;
    border-color: #4a8cff;
  }
  .floating-menu[data-style='glass'] button:disabled, .floating-menu[data-style='glass'] button[aria-disabled='true'],
  .floating-menu[data-style='glass'] .floating-primary:disabled, .floating-menu[data-style='glass'] .floating-primary[aria-disabled='true'] {
    color: #7f92ad;
    background: #1b2638;
    border-color: #2c3b52;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .floating-entry[data-style='glass'], .floating-menu[data-style='glass'] {
    background: #ffffff;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  @media (prefers-color-scheme: dark) {
    .floating-entry[data-style='glass'], .floating-menu[data-style='glass'] {
      background: #182234;
    }
  }
}
.floating-menu {
  --wt-menu-bg: #f8fafc;
  --wt-menu-text: #24374a;
  --wt-menu-muted: #63778a;
  --wt-menu-border: #d4dee8;
  --wt-menu-primary: #e7eff5;
  --wt-menu-accent: #355f7c;
  color: var(--wt-menu-text);
  background: var(--wt-menu-bg);
  border-color: var(--wt-menu-border);
}
.floating-menu[data-style='cyber'] {
  --wt-menu-bg: #101c29;
  --wt-menu-text: #dce7ef;
  --wt-menu-muted: #9aafbf;
  --wt-menu-border: #304759;
  --wt-menu-primary: #20384a;
  --wt-menu-accent: #a9cddd;
  color: var(--wt-menu-text);
  background: var(--wt-menu-bg);
  border-color: var(--wt-menu-border);
  box-shadow: 0 8px 24px #06101e38;
}
.floating-menu[data-style='glass'] {
  color: var(--wt-menu-text);
  background: rgba(248,250,253,.94);
  border-color: var(--wt-menu-border);
}
.floating-entry[data-style='cyber'], .floating-entry[data-style='cyber']:hover {
  background: #101c29; border-color: #304759; box-shadow: 0 4px 14px #06101e24;
}
.floating-menu[data-style] .floating-title, .floating-menu[data-style] .floating-host,
.floating-menu[data-style] .floating-disclosure { color: var(--wt-menu-muted); }
@media (prefers-color-scheme: dark) {
  .floating-menu:not([data-style='cyber']) {
    --wt-menu-bg: #182534;
    --wt-menu-text: #dce7ef;
    --wt-menu-muted: #a6b6c4;
    --wt-menu-border: #3a4c5d;
    --wt-menu-primary: #2a4053;
    --wt-menu-accent: #bad5e5;
    color: var(--wt-menu-text);
    background: var(--wt-menu-bg);
    border-color: var(--wt-menu-border);
  }
}
.floating-menu .floating-head {
  position: relative;
  padding: 0 calc(28px / var(--wt-floating-scale)) 0 0;
  border: 0;
}
.floating-menu .floating-title { font-size: calc(12px / var(--wt-floating-scale)); letter-spacing: 0; }
.floating-menu .floating-host, .floating-menu .floating-disclosure, .floating-menu .floating-fixed {
  color: var(--wt-menu-muted);
  font-size: calc(10px / var(--wt-floating-scale));
  line-height: 1.5;
}
.floating-menu .floating-close, .floating-menu[data-style] .floating-close {
  position: absolute;
  top: 0;
  right: 0;
  min-height: calc(24px / var(--wt-floating-scale));
  width: calc(24px / var(--wt-floating-scale));
  padding: 0;
  color: var(--wt-menu-muted);
  background: transparent;
  border: 0;
}
.floating-menu .floating-primary, .floating-menu[data-style] .floating-primary {
  color: var(--wt-menu-accent);
  background: var(--wt-menu-primary);
  border-color: var(--wt-menu-border);
}
.floating-menu .floating-primary:hover:not(:disabled, [aria-disabled='true']),
.floating-menu[data-style] .floating-primary:hover:not(:disabled, [aria-disabled='true']) {
  color: var(--wt-menu-accent);
  background: var(--wt-menu-primary);
  border-color: var(--wt-menu-accent);
}
.floating-menu .floating-auto, .floating-menu[data-style] .floating-auto {
  justify-content: space-between;
  gap: calc(8px / var(--wt-floating-scale));
  padding-left: 0;
  padding-right: 0;
  text-align: start;
  color: var(--wt-menu-text);
  background: transparent;
  border-color: transparent;
}
.floating-auto::after {
  content: '';
  flex: none;
  width: calc(32px / var(--wt-floating-scale));
  height: calc(18px / var(--wt-floating-scale));
  border-radius: calc(12px / var(--wt-floating-scale));
  background: radial-gradient(circle at calc(9px / var(--wt-floating-scale)) 50%, #fff 0 calc(6px / var(--wt-floating-scale)), transparent calc(6.5px / var(--wt-floating-scale))), #8092a3;
}
.floating-auto[aria-checked='true']::after {
  background: radial-gradient(circle at calc(23px / var(--wt-floating-scale)) 50%, #fff 0 calc(6px / var(--wt-floating-scale)), transparent calc(6.5px / var(--wt-floating-scale))), #497c99;
}
.floating-menu .floating-actions-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 0;
  border: 0;
}
.floating-menu .floating-settings, .floating-menu[data-style] .floating-settings {
  padding-left: 0;
  padding-right: 0;
  color: var(--wt-menu-muted);
  background: transparent;
  border-color: transparent;
}
@media (prefers-reduced-transparency: reduce) {
  .floating-menu[data-style='glass'] { background: var(--wt-menu-bg); }
}
@media (forced-colors: active) {
  .floating-entry, .floating-menu, .floating-menu button {
    background: Canvas;
    color: CanvasText;
    border: 1px solid ButtonText;
    box-shadow: none;
  }
  .floating-entry:focus-visible, .floating-menu button:focus-visible, .floating-menu input:focus-visible {
    outline: 2px solid Highlight;
  }
  .floating-auto::after { border: 1px solid ButtonText; }
  .floating-auto[aria-checked='true']::after { background: Highlight; }
}
`

interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface Viewport {
  readonly width: number
  readonly height: number
  readonly scale: number
}

interface Drag {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly originLeft: number
  readonly originTop: number
  readonly origin: FloatingPosition
  moved: boolean
  readonly onMove: (event: PointerEvent) => void
  readonly onUp: (event: PointerEvent) => void
  readonly onCancel: (event: PointerEvent) => void
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function readPosition(value: unknown): FloatingPosition {
  if (!isPlainObject(value)) return DEFAULT_POSITION
  const side = value.side
  const ratio = value.ratio
  const collapsed = value.collapsed
  if (
    (side !== 'left' && side !== 'right') ||
    typeof ratio !== 'number' ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1 ||
    typeof collapsed !== 'boolean'
  ) {
    return DEFAULT_POSITION
  }
  return { side, ratio, collapsed: true }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

export function createFloatingEntry(
  shadow: ShadowRoot,
  geometry: {
    viewport(): Viewport
    avoidRects(): readonly Rect[]
    onPosition?(): void
  },
): FloatingEntry {
  const style = document.createElement('style')
  style.textContent = FLOATING_CSS
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.className = 'floating-entry'
  entry.setAttribute('aria-expanded', 'false')
  const image = document.createElement('img')
  image.alt = ''
  image.draggable = false
  entry.append(image)
  const menu = document.createElement('div')
  menu.className = 'floating-menu'
  menu.id = 'wt-floating-menu'
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-modal', 'false')
  menu.hidden = true
  const head = document.createElement('div')
  head.className = 'floating-head'
  const title = document.createElement('div')
  title.className = 'floating-title'
  title.id = 'wt-floating-title'
  menu.setAttribute('aria-labelledby', title.id)
  const hostname = document.createElement('div')
  hostname.className = 'floating-host'
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'floating-close'
  closeButton.textContent = '×'
  head.append(title, hostname, closeButton)
  const statusFixed = document.createElement('div')
  statusFixed.className = 'floating-fixed'
  const disclosure = document.createElement('p')
  disclosure.className = 'floating-disclosure'
  const mainActions = document.createElement('div')
  mainActions.className = 'floating-actions-main'
  const translateButton = document.createElement('button')
  translateButton.type = 'button'
  translateButton.className = 'floating-translate floating-primary'
  const primary = document.createElement('button')
  primary.type = 'button'
  primary.className = 'floating-auto'
  primary.setAttribute('role', 'switch')
  const pageButton = document.createElement('button')
  pageButton.type = 'button'
  pageButton.className = 'floating-page'
  const resumeButton = document.createElement('button')
  resumeButton.type = 'button'
  resumeButton.className = 'floating-resume'
  mainActions.append(translateButton, pageButton, resumeButton, primary)
  const subActions = document.createElement('div')
  subActions.className = 'floating-actions-sub'
  const settingsButton = document.createElement('button')
  settingsButton.type = 'button'
  settingsButton.className = 'floating-settings'
  subActions.append(settingsButton, statusFixed)
  const error = document.createElement('div')
  error.className = 'floating-error'
  error.setAttribute('role', 'status')
  menu.append(head, mainActions, disclosure, subActions, error)
  const move = document.createElement('p')
  move.className = 'floating-move'
  move.id = 'wt-floating-move'
  entry.setAttribute('aria-controls', menu.id)
  entry.setAttribute('aria-describedby', move.id)
  shadow.append(style, entry, menu, move)

  let position = DEFAULT_POSITION
  let view: FloatingView | undefined
  let labels: FloatingLabels | undefined
  let callbacks: FloatingCallbacks | undefined
  let imageUrl = ''
  let disposed = false
  let dirty = false
  let readStarted = false
  let readEpoch = 0
  let menuOpen = false
  let hovered = false
  let noticeVisible = false
  let dockTimer: ReturnType<typeof setTimeout> | undefined
  let positionFailed = false
  let suppressClick = false
  let drag: Drag | undefined
  let raf = 0
  let writing = false
  let pendingWrite: FloatingPosition | undefined
  let viewport: Viewport = { width: 1, height: 1, scale: 1 }
  const menuObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reposition()) : undefined

  function clearDockTimer(): void {
    if (dockTimer !== undefined) clearTimeout(dockTimer)
    dockTimer = undefined
  }

  function keepExpanded(): boolean {
    return menuOpen || hovered || noticeVisible || drag !== undefined || entry.matches(':focus-visible')
  }

  function expandEntry(): void {
    clearDockTimer()
    if (!position.collapsed) return
    position = { ...position, collapsed: false }
    place()
    render()
  }

  function scheduleDock(): void {
    clearDockTimer()
    if (disposed || position.collapsed || keepExpanded()) return
    dockTimer = setTimeout(() => {
      dockTimer = undefined
      if (disposed || keepExpanded()) return
      position = { ...position, collapsed: true }
      place()
      render()
    }, AUTO_DOCK_MS)
  }

  function onPointerEnter(event: PointerEvent): void {
    if (!trusted(event) || event.pointerType === 'touch') return
    hovered = true
    expandEntry()
  }

  function onPointerLeave(event: PointerEvent): void {
    if (!event.isTrusted) return
    hovered = false
    scheduleDock()
  }

  function onFocusIn(): void {
    if (!disposed) expandEntry()
  }

  function onFocusOut(): void {
    // focus-visible still refers to the old target during focusout.
    queueMicrotask(() => {
      if (!disposed) scheduleDock()
    })
  }

  function scaleOf(next: Viewport): number {
    return next.scale > 0 && Number.isFinite(next.scale) ? next.scale : 1
  }

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text
  }

  function setHidden(node: HTMLElement, hidden: boolean): void {
    if (node.hidden !== hidden) node.hidden = hidden
  }

  function sameView(next: FloatingView): boolean {
    const current = view
    return (
      current !== undefined &&
      current.visible === next.visible &&
      current.hostname === next.hostname &&
      current.fixedOn === next.fixedOn &&
      current.autoEnabled === next.autoEnabled &&
      current.pageOn === next.pageOn &&
      current.configured === next.configured &&
      current.restored === next.restored &&
      current.canRestore === next.canRestore &&
      current.resumable === next.resumable &&
      current.busy === next.busy &&
      current.checking === next.checking &&
      current.error === next.error
    )
  }

  function sameLabels(next: FloatingLabels): boolean {
    const current = labels
    if (current === undefined) return false
    const keys = Object.keys(next) as (keyof FloatingLabels)[]
    return keys.every((key) => current[key] === next[key])
  }

  function render(): void {
    if (view === undefined || labels === undefined) return
    setText(title, labels.title)
    setText(hostname, view.hostname)
    setText(move, labels.move)
    setText(disclosure, labels.disclosure)
    setText(statusFixed, view.fixedOn ? labels.fixedOn : '')
    setHidden(statusFixed, !view.fixedOn || view.checking)
    setText(translateButton, view.configured ? labels.translatePage : labels.configure)
    if (view.busy) translateButton.setAttribute('aria-disabled', 'true')
    else translateButton.removeAttribute('aria-disabled')
    setText(primary, labels.autoTranslate ?? labels.enable)
    primary.setAttribute('aria-checked', String(view.autoEnabled))
    primary.disabled = (!view.configured && !view.autoEnabled) || view.checking
    if (view.busy) primary.setAttribute('aria-disabled', 'true')
    else primary.removeAttribute('aria-disabled')
    setText(pageButton, labels.restore)
    pageButton.disabled = !view.canRestore || view.checking
    setHidden(pageButton, !view.canRestore || view.restored)
    if (view.busy) pageButton.setAttribute('aria-disabled', 'true')
    else pageButton.removeAttribute('aria-disabled')
    setText(resumeButton, labels.resume)
    resumeButton.disabled = !view.resumable || view.checking
    setHidden(resumeButton, !view.resumable)
    if (view.busy) resumeButton.setAttribute('aria-disabled', 'true')
    else resumeButton.removeAttribute('aria-disabled')
    setText(settingsButton, labels.settings)
    closeButton.setAttribute('aria-label', labels.close)
    const errorText = [positionFailed ? labels.positionFailed : '', view.error].filter((item) => item !== '').join('\n')
    setText(error, errorText)
    setHidden(error, errorText === '')
    const entryLabel = position.collapsed ? labels.expand : menuOpen ? labels.close : labels.open
    if (entry.getAttribute('aria-label') !== entryLabel) entry.setAttribute('aria-label', entryLabel)
    entry.setAttribute('aria-expanded', menuOpen ? 'true' : 'false')
    if (!view.visible) {
      entry.style.visibility = 'hidden'
      entry.tabIndex = -1
      closeMenu(false)
    }
  }

  function trusted(event: Event): boolean {
    return event.isTrusted && !disposed && view?.visible === true
  }

  function blocked(button: HTMLButtonElement): boolean {
    return button.disabled || button.getAttribute('aria-disabled') === 'true'
  }

  function openMenu(keyboard: boolean): void {
    if (callbacks === undefined || menuOpen || disposed) return
    callbacks.onOpen()
    if (disposed) return
    menuOpen = true
    expandEntry()
    menu.hidden = false
    entry.setAttribute('aria-expanded', 'true')
    if (labels !== undefined && view !== undefined) {
      const entryLabel = position.collapsed ? labels.expand : labels.close
      entry.setAttribute('aria-label', entryLabel)
    }
    menuObserver?.observe(menu)
    place()
    if (keyboard) {
      const target = [translateButton, primary, pageButton, resumeButton, settingsButton, closeButton].find((button) => !button.hidden && !blocked(button))
      target?.focus({ preventScroll: true })
    }
  }

  function closeMenu(returnFocus = false): void {
    if (!menuOpen && menu.hidden) {
      if (returnFocus) entry.focus({ preventScroll: true })
      return
    }
    menuOpen = false
    menu.hidden = true
    entry.classList.remove('is-covered')
    menuObserver?.unobserve(menu)
    entry.setAttribute('aria-expanded', 'false')
    if (labels !== undefined) entry.setAttribute('aria-label', position.collapsed ? labels.expand : labels.open)
    if (returnFocus) entry.focus({ preventScroll: true })
    scheduleDock()
    geometry.onPosition?.()
  }

  function buttonBox(left: number, top: number, size: number): Rect {
    return { left, top, right: left + size, bottom: top + size }
  }

  function restedY(next: Viewport, size: number, margin: number): number {
    const min = margin
    const max = next.height - size - margin
    if (max < min) return clamp(0, 0, Math.max(0, next.height - size))
    return min + (max - min) * position.ratio
  }

  function dockX(next: Viewport, size: number, collapsed: boolean): number {
    const scale = scaleOf(next)
    if (collapsed) {
      return position.side === 'left' ? -(BUTTON - VISIBLE_COLLAPSED) / scale : next.width - VISIBLE_COLLAPSED / scale
    }
    return position.side === 'left' ? 0 : Math.max(0, next.width - size)
  }

  function avoidY(preferred: number, size: number, next: Viewport, margin: number): number | undefined {
    const scale = scaleOf(next)
    const gap = AVOID / scale
    const obstacles = geometry.avoidRects().map((rect) => ({
      left: rect.left - gap,
      top: rect.top - gap,
      right: rect.right + gap,
      bottom: rect.bottom + gap,
    }))
    const min = Math.min(margin, Math.max(0, next.height - size))
    const max = Math.max(min, next.height - size - (next.height - size >= margin * 2 ? margin : 0))
    const candidates = [preferred]
    for (const rect of obstacles) {
      candidates.push(rect.top - size - gap, rect.bottom + gap)
    }
    let best: number | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const top = clamp(candidate, 0, Math.max(0, next.height - size))
      if (top < min - 0.5 || top > max + 0.5) continue
      const box = buttonBox(dockX(next, size, position.collapsed), top, size)
      if (obstacles.some((rect) => intersects(box, rect))) continue
      const distance = Math.abs(top - preferred)
      if (distance < bestDistance) {
        best = top
        bestDistance = distance
      }
    }
    return best
  }

  function place(): void {
    if (disposed || drag !== undefined) return
    viewport = geometry.viewport()
    const scale = scaleOf(viewport)
    const size = BUTTON / scale
    const margin = MARGIN / scale
    const scaleText = String(scale)
    entry.style.setProperty('--wt-floating-scale', scaleText)
    menu.style.setProperty('--wt-floating-scale', scaleText)
    if (view?.visible === false) {
      entry.style.visibility = 'hidden'
      entry.tabIndex = -1
      geometry.onPosition?.()
      return
    }
    const preferred = restedY(viewport, size, margin)
    const y = avoidY(preferred, size, viewport, margin)
    if (y === undefined) {
      // 入口没有可用位置时一并收起菜单，不让菜单孤零零留在旧坐标
      entry.style.visibility = 'hidden'
      entry.tabIndex = -1
      if (menuOpen) closeMenu(false)
      geometry.onPosition?.()
      return
    }
    entry.style.visibility = 'visible'
    entry.tabIndex = 0
    entry.style.left = `${dockX(viewport, size, position.collapsed)}px`
    entry.style.top = `${y}px`
    placeMenu(scale, size, margin)
    geometry.onPosition?.()
  }

  function placeMenu(scale: number, size: number, margin: number): void {
    if (!menuOpen) return
    const maxWidth = Math.max(1, Math.min(MENU_MAX / scale, viewport.width - margin * 2))
    const maxHeight = Math.max(1, viewport.height - margin * 2)
    menu.style.maxWidth = `${maxWidth}px`
    menu.style.maxHeight = `${maxHeight}px`
    const rect = menu.getBoundingClientRect()
    const width = rect.width / scale || maxWidth
    const height = rect.height / scale || maxHeight
    const left = Number.parseFloat(entry.style.left) || 0
    const top = Number.parseFloat(entry.style.top) || 0
    const gap = AVOID / scale
    const inner = position.side === 'right'
      ? { left: left - width - gap, top }
      : { left: left + size + gap, top }
    const other = position.side === 'right'
      ? { left: left + size + gap, top }
      : { left: left - width - gap, top }
    const candidates = [inner, other, { left, top: top - height - gap }, { left, top: top + size + gap }]
    const obstacles = geometry.avoidRects()
    let chosen = candidates[0]!
    let chosenOverlap = Number.POSITIVE_INFINITY
    let foundClear = false
    for (const candidate of candidates) {
      const box = {
        left: clamp(candidate.left, margin, Math.max(margin, viewport.width - width - margin)),
        top: clamp(candidate.top, margin, Math.max(margin, viewport.height - height - margin)),
        right: 0,
        bottom: 0,
      }
      const placed = { ...box, right: box.left + width, bottom: box.top + height }
      const area = obstacles.reduce((sum, obstacle) => sum + overlapArea(placed, obstacle), 0)
      if (area === 0 && !foundClear) {
        foundClear = true
        chosen = { left: placed.left, top: placed.top }
        chosenOverlap = 0
      } else if (!foundClear && area < chosenOverlap) {
        chosenOverlap = area
        chosen = { left: placed.left, top: placed.top }
      } else if (area === 0 && foundClear && chosenOverlap === 0) {
        continue
      }
    }
    menu.style.left = `${chosen.left}px`
    menu.style.top = `${chosen.top}px`
    const covered = intersects(
      { left: chosen.left, top: chosen.top, right: chosen.left + width, bottom: chosen.top + height },
      buttonBox(left, top, size),
    )
    entry.classList.toggle('is-covered', covered)
  }

  function reposition(): void {
    if (disposed) return
    if (raf !== 0) return
    raf = requestAnimationFrame(() => {
      raf = 0
      if (!disposed) place()
    })
  }

  function persist(next: FloatingPosition): void {
    pendingWrite = { ...next, collapsed: true }
    if (writing || callbacks === undefined) return
    writing = true
    void flushWrites()
  }

  async function flushWrites(): Promise<void> {
    while (pendingWrite !== undefined && !disposed && callbacks !== undefined) {
      const job = pendingWrite
      pendingWrite = undefined
      try {
        await callbacks.writePosition(job)
        if (pendingWrite === undefined && !disposed) {
          positionFailed = false
          render()
        }
      } catch {
        if (!disposed) {
          positionFailed = true
          render()
        }
      }
    }
    writing = false
    if (pendingWrite !== undefined && !disposed) {
      writing = true
      await flushWrites()
    }
  }

  function currentLeftTop(): { left: number; top: number } {
    return {
      left: Number.parseFloat(entry.style.left) || 0,
      top: Number.parseFloat(entry.style.top) || 0,
    }
  }

  function stopDrag(commit: boolean): void {
    const current = drag
    if (current === undefined) return
    drag = undefined
    document.removeEventListener('pointermove', current.onMove)
    document.removeEventListener('pointerup', current.onUp)
    document.removeEventListener('pointercancel', current.onCancel)
    entry.classList.remove('is-dragging')
    try {
      entry.releasePointerCapture(current.pointerId)
    } catch {
      /* Capture may already be gone. */
    }
    if (!commit || !current.moved) {
      position = current.origin
      place()
      scheduleDock()
      return
    }
    suppressClick = true
    const scale = scaleOf(viewport)
    const size = BUTTON / scale
    const point = currentLeftTop()
    const center = point.left + size / 2
    const side = center < viewport.width / 2 ? 'left' : 'right'
    const margin = MARGIN / scale
    const min = margin
    const max = viewport.height - size - margin
    const ratio = max <= min ? 0.5 : clamp((point.top - min) / (max - min), 0, 1)
    position = { side, ratio, collapsed: false }
    hovered = false
    dirty = true
    place()
    persist(position)
    render()
    scheduleDock()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!event.isTrusted || event.isPrimary !== true || event.button !== 0 || disposed || view?.visible !== true) return
    suppressClick = false
    clearDockTimer()
    if (drag !== undefined) stopDrag(false)
    place()
    const point = currentLeftTop()
    const onMove = (move: PointerEvent): void => {
      if (drag === undefined || move.pointerId !== drag.pointerId) return
      const distance = Math.hypot(move.clientX - drag.startX, move.clientY - drag.startY)
      if (!drag.moved && distance < DRAG_PX) return
      if (!drag.moved) {
        drag.moved = true
        closeMenu(false)
        entry.classList.add('is-dragging')
      }
      const scale = scaleOf(viewport)
      const size = BUTTON / scale
      const left = clamp(drag.originLeft + (move.clientX - drag.startX) / scale, 0, Math.max(0, viewport.width - size))
      const top = clamp(drag.originTop + (move.clientY - drag.startY) / scale, 0, Math.max(0, viewport.height - size))
      entry.style.visibility = 'visible'
      entry.tabIndex = 0
      entry.style.left = `${left}px`
      entry.style.top = `${top}px`
      geometry.onPosition?.()
    }
    const onUp = (up: PointerEvent): void => {
      if (drag === undefined || up.pointerId !== drag.pointerId) return
      stopDrag(true)
    }
    const onCancel = (cancel: PointerEvent): void => {
      if (drag === undefined || cancel.pointerId !== drag.pointerId) return
      stopDrag(false)
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: point.left,
      originTop: point.top,
      origin: position,
      moved: false,
      onMove,
      onUp,
      onCancel,
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    try {
      entry.setPointerCapture(event.pointerId)
    } catch {
      /* The pointer may already be inactive. */
    }
  }

  function onLostCapture(event: PointerEvent): void {
    if (drag !== undefined && event.pointerId === drag.pointerId) stopDrag(false)
  }

  function onEntryClick(event: MouseEvent): void {
    if (!trusted(event)) return
    if (event.detail > 0 && suppressClick) {
      suppressClick = false
      return
    }
    expandEntry()
    if (menuOpen) closeMenu(false)
    else openMenu(event.detail === 0)
  }

  function nudge(key: string): void {
    viewport = geometry.viewport()
    const scale = scaleOf(viewport)
    const size = BUTTON / scale
    const margin = MARGIN / scale
    let next: FloatingPosition
    if (key === 'ArrowLeft') next = { ...position, side: 'left' }
    else if (key === 'ArrowRight') next = { ...position, side: 'right' }
    else {
      const min = margin
      const max = viewport.height - size - margin
      const y = restedY(viewport, size, margin) + (key === 'ArrowDown' ? NUDGE_PX / scale : -NUDGE_PX / scale)
      const clamped = clamp(y, max < min ? 0 : min, max < min ? Math.max(0, viewport.height - size) : max)
      const ratio = max <= min ? 0.5 : clamp((clamped - min) / (max - min), 0, 1)
      next = { ...position, ratio }
    }
    position = next
    dirty = true
    place()
    persist(position)
    scheduleDock()
  }

  function onEntryKeyDown(event: KeyboardEvent): void {
    if (!event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      if (event.key === 'Escape' && menuOpen) {
        event.preventDefault()
        closeMenu(true)
      }
      return
    }
    if (!trusted(event)) return
    event.preventDefault()
    nudge(event.key)
  }

  function onMenuKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !menuOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
  }

  function onTranslate(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || blocked(translateButton)) return
    callbacks?.onAction('translate-page')
  }

  function onPrimary(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || blocked(primary)) return
    callbacks?.onAction('toggle-auto')
  }

  function onPage(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || blocked(pageButton)) return
    callbacks?.onAction('restore')
  }

  function onResume(event: MouseEvent): void {
    if (!trusted(event) || view === undefined || !view.resumable || blocked(resumeButton)) return
    callbacks?.onAction('resume')
  }

  function onSettings(event: MouseEvent): void {
    if (!trusted(event) || blocked(settingsButton)) return
    callbacks?.onAction('settings')
  }

  function onCloseClick(event: MouseEvent): void {
    if (!trusted(event)) return
    closeMenu(true)
  }

  function onBlur(): void {
    if (drag !== undefined) stopDrag(false)
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden' && drag !== undefined) stopDrag(false)
  }

  entry.addEventListener('pointerdown', onPointerDown)
  entry.addEventListener('pointerenter', onPointerEnter)
  entry.addEventListener('pointerleave', onPointerLeave)
  entry.addEventListener('focusin', onFocusIn)
  entry.addEventListener('focusout', onFocusOut)
  entry.addEventListener('lostpointercapture', onLostCapture)
  entry.addEventListener('click', onEntryClick)
  entry.addEventListener('keydown', onEntryKeyDown)
  menu.addEventListener('keydown', onMenuKeyDown)
  translateButton.addEventListener('click', onTranslate)
  primary.addEventListener('click', onPrimary)
  pageButton.addEventListener('click', onPage)
  resumeButton.addEventListener('click', onResume)
  settingsButton.addEventListener('click', onSettings)
  closeButton.addEventListener('click', onCloseClick)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    update(nextView, nextLabels, nextCallbacks) {
      const first = !readStarted
      callbacks = nextCallbacks
      const unchanged = sameView(nextView) && sameLabels(nextLabels) && imageUrl === nextCallbacks.imageUrl
      view = nextView
      labels = nextLabels
      if (imageUrl !== nextCallbacks.imageUrl) {
        imageUrl = nextCallbacks.imageUrl
        image.src = imageUrl
      }
      if (!unchanged) render()
      if (first) {
        readStarted = true
        const token = ++readEpoch
        void Promise.resolve()
          .then(() => callbacks?.readPosition())
          .then((value) => {
            if (disposed || dirty || token !== readEpoch) return
            position = readPosition(value)
            if (keepExpanded()) position = { ...position, collapsed: false }
            place()
            render()
          })
          .catch(() => undefined)
      }
      if (!unchanged || first) reposition()
    },
    setStyle(styleName) {
      for (const node of [entry, menu]) {
        if (styleName === 'classic') node.removeAttribute('data-style')
        else node.setAttribute('data-style', styleName)
      }
    },
    closeMenu,
    isMenuOpen() {
      return menuOpen
    },
    reposition,
    getAnchor() {
      if (disposed || view?.visible !== true || entry.style.visibility !== 'visible') return undefined
      const { left, top } = currentLeftTop()
      const size = BUTTON / scaleOf(viewport)
      return { side: position.side, left, top, right: left + size, bottom: top + size }
    },
    setNoticeVisible(visible) {
      if (disposed || noticeVisible === visible) return
      noticeVisible = visible
      if (visible) expandEntry()
      else scheduleDock()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearDockTimer()
      readEpoch += 1
      if (drag !== undefined) stopDrag(false)
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
      menuObserver?.disconnect()
      entry.removeEventListener('pointerdown', onPointerDown)
      entry.removeEventListener('pointerenter', onPointerEnter)
      entry.removeEventListener('pointerleave', onPointerLeave)
      entry.removeEventListener('focusin', onFocusIn)
      entry.removeEventListener('focusout', onFocusOut)
      entry.removeEventListener('lostpointercapture', onLostCapture)
      entry.removeEventListener('click', onEntryClick)
      entry.removeEventListener('keydown', onEntryKeyDown)
      menu.removeEventListener('keydown', onMenuKeyDown)
      translateButton.removeEventListener('click', onTranslate)
      primary.removeEventListener('click', onPrimary)
      pageButton.removeEventListener('click', onPage)
      resumeButton.removeEventListener('click', onResume)
      settingsButton.removeEventListener('click', onSettings)
      closeButton.removeEventListener('click', onCloseClick)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      style.remove()
      entry.remove()
      menu.remove()
      move.remove()
    },
  }
}
