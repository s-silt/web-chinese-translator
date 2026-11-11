import tokens from '../components/ui-tokens.css?inline'
import type { UiLanguage } from '../shared/locale'
import type { ThemePreference, UiStyle } from '../shared/settings'

export interface SurfacePreferences {
  readonly uiStyle: UiStyle
  readonly theme: ThemePreference
  readonly language: UiLanguage
}

export const DEFAULT_SURFACE_PREFERENCES: SurfacePreferences = {
  uiStyle: 'classic',
  theme: 'auto',
  language: 'zh-CN',
}

export function syncSurfaceVisibility(host: HTMLElement): void {
  host.toggleAttribute('data-wt-page-hidden', document.hidden)
}

export function applySurfacePreferences(
  host: HTMLElement,
  preferences: Partial<SurfacePreferences>,
): void {
  if (preferences.uiStyle !== undefined) {
    if (preferences.uiStyle === 'classic') host.removeAttribute('data-style')
    else host.dataset.style = preferences.uiStyle
  }
  if (preferences.theme !== undefined) {
    if (preferences.theme === 'auto') host.removeAttribute('data-theme')
    else host.dataset.theme = preferences.theme
  }
  if (preferences.language !== undefined) host.lang = preferences.language
  const scheme =
    host.dataset.style === 'cyber'
      ? 'dark'
      : host.dataset.theme === 'dark'
        ? 'dark'
        : host.dataset.theme === 'light'
          ? 'light'
          : 'light dark'
  host.style.setProperty('color-scheme', scheme, 'important')
  host.style.setProperty('direction', 'ltr', 'important')
  syncSurfaceVisibility(host)
}

export const SURFACE_CSS = tokens + '\n' + `:host {
  --wt-surface: var(--gcn-surface);
  --wt-ink: var(--gcn-fg);
  --wt-muted: var(--gcn-fg-muted);
  --wt-border: var(--gcn-surface-border);
  --wt-soft: var(--gcn-btn-bg);
  --wt-accent: var(--gcn-accent);
}
button, input, summary { font-family: var(--gcn-font); }
button:focus-visible, input:focus-visible, summary:focus-visible {
  outline: 2px solid var(--gcn-focus); outline-offset: 2px;
}
:host([data-wt-page-hidden]) * { animation: none !important; transition: none !important; }
@keyframes wt-surface-enter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: no-preference) {
  .panel, .hint, .selection-toolbar, .popover, .floating-menu:not([hidden]), .notice-speech {
    animation: wt-surface-enter var(--gcn-duration-base) var(--gcn-ease-out);
  }
  button { transition: background-color var(--gcn-duration-fast) var(--gcn-ease), border-color var(--gcn-duration-fast) var(--gcn-ease); }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (prefers-reduced-transparency: reduce) {
  :host([data-style='glass']) { --gcn-surface: Canvas; --gcn-surface-blur: 0px; }
}
@media (forced-colors: active) {
  :host, :host([data-style]) {
    --gcn-fg: CanvasText; --gcn-fg-muted: CanvasText; --gcn-fg-disabled: GrayText;
    --gcn-bg: Canvas; --gcn-bg-muted: Canvas; --gcn-bg-disabled: Canvas;
    --gcn-surface: Canvas; --gcn-surface-border: ButtonText; --gcn-surface-blur: 0px;
    --gcn-border: ButtonText; --gcn-border-muted: ButtonText; --gcn-border-emphasis: Highlight;
    --gcn-accent: LinkText; --gcn-focus: Highlight; --gcn-danger-fg: CanvasText;
    --gcn-btn-fg: ButtonText; --gcn-btn-bg: ButtonFace; --gcn-btn-border: ButtonText;
    --gcn-btn-hover-bg: ButtonFace; --gcn-btn-active-bg: ButtonFace;
    --gcn-primary-fg: HighlightText; --gcn-primary-bg: Highlight; --gcn-primary-border: Highlight;
    --gcn-primary-hover-bg: Highlight; --gcn-primary-active-bg: Highlight;
    --gcn-primary-disabled-fg: GrayText; --gcn-primary-disabled-bg: Canvas;
    --gcn-switch-off: Canvas; --gcn-switch-on: Highlight; --gcn-knob: CanvasText;
    --gcn-shadow-overlay: none;
  }
  * { box-shadow: none !important; }
}
`
