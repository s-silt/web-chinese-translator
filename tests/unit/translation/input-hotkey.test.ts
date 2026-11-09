import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INPUT_REPLACE_KEY,
  formatHotkey,
  hotkeyFromEvent,
  matchesHotkey,
  normalizeHotkey,
  parseHotkey,
} from '../../../src/translation/input-hotkey'

describe('input-hotkey 解析与规范化', () => {
  it('默认替换键为 Tab，parseHotkey 与 normalizeHotkey 统一修饰键顺序与大小写', () => {
    expect(DEFAULT_INPUT_REPLACE_KEY).toBe('Tab')
    expect(parseHotkey('Tab')).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      key: 'Tab',
    })
    expect(parseHotkey('shift+ctrl+r')).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: 'R',
    })
    expect(normalizeHotkey('tab')).toBe('Tab')
    expect(normalizeHotkey('f1')).toBe('F1')
    expect(normalizeHotkey('F12')).toBe('F12')
    expect(normalizeHotkey('shift+ctrl+r')).toBe('Ctrl+Shift+R')
    expect(normalizeHotkey('Command+Option+Enter')).toBe('Alt+Meta+Enter')
    expect(normalizeHotkey('ctrl+space')).toBe('Ctrl+Space')
    expect(normalizeHotkey('alt+arrowup')).toBe('Alt+ArrowUp')
    expect(normalizeHotkey('')).toBe('')
    expect(normalizeHotkey('   ')).toBe('')
    expect( parseHotkey('')).toBeUndefined()
  })

  it('合法性校验：拒绝无修饰键的普通字符/Enter/Space/Backspace/Escape、Shift+可打印字符及重复或未知修饰键', () => {
    for (const invalid of [
      'a',
      'R',
      '1',
      '/',
      'Enter',
      'Space',
      'Backspace',
      'Delete',
      'ArrowUp',
      'Escape',
      'Esc',
      'Ctrl+Escape',
      'Shift+a',
      'Shift+R',
      'Shift+1',
      'Shift+/',
      'Ctrl+Ctrl+R',
      'Ctrl+',
      '+R',
      'UnknownMod+R',
      'F13',
      'Control',
      'Shift',
      null,
      123,
    ]) {
      expect(parseHotkey(invalid), String(invalid)).toBeUndefined()
      expect(normalizeHotkey(invalid), String(invalid)).toBeUndefined()
    }

    for (const valid of [
      'Tab',
      'F1',
      'F12',
      'Shift+Tab',
      'Ctrl+Enter',
      'Alt+Enter',
      'Shift+Enter',
      'Meta+Enter',
      'Ctrl+Space',
      'Alt+Backspace',
      'Ctrl+R',
      'Alt+S',
      'Ctrl+Shift+Y',
      'Meta+Shift+K',
    ]) {
      expect(normalizeHotkey(valid), valid).toBeDefined()
    }
  })

  it('hotkeyFromEvent 提取组合键，只按修饰键或处于 IME 合成时返回 undefined', () => {
    expect(hotkeyFromEvent({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined()
    expect(hotkeyFromEvent({ key: 'Shift', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBeUndefined()
    expect(hotkeyFromEvent({ key: 'Alt', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false })).toBeUndefined()
    expect(hotkeyFromEvent({ key: 'Meta', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true })).toBeUndefined()
    expect(hotkeyFromEvent({ key: 'Process', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined()
    expect(
      hotkeyFromEvent({
        key: 'Enter',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        isComposing: true,
      }),
    ).toBeUndefined()
    expect(
      hotkeyFromEvent({
        key: 'Enter',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        keyCode: 229,
      }),
    ).toBeUndefined()

    expect(hotkeyFromEvent({ key: 'r', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe('Ctrl+Shift+R')
    expect(hotkeyFromEvent({ key: ' ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe('Ctrl+Space')
    expect(hotkeyFromEvent({ key: 'Tab', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBe('Tab')
    expect(hotkeyFromEvent({ key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBe('A')
  })

  it('matchesHotkey 精确匹配修饰键并拦截 IME 合成、keyCode 229 与 repeat', () => {
    expect(
      matchesHotkey(
        { key: 'Enter', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
        'Ctrl+Enter',
      ),
    ).toBe(true)
    expect(
      matchesHotkey(
        { key: 'r', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false },
        'Ctrl+Alt+R',
      ),
    ).toBe(true)
    // 多按了修饰键不算
    expect(
      matchesHotkey(
        { key: 'Enter', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
        'Ctrl+Enter',
      ),
    ).toBe(false)
    expect(
      matchesHotkey(
        { key: 'Tab', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false },
        'Tab',
      ),
    ).toBe(false)
    // IME 合成、229、repeat 一律不匹配
    expect(
      matchesHotkey(
        { key: 'Tab', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: true },
        'Tab',
      ),
    ).toBe(false)
    expect(
      matchesHotkey(
        { key: 'Tab', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, keyCode: 229 },
        'Tab',
      ),
    ).toBe(false)
    expect(
      matchesHotkey(
        { key: 'Tab', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: true },
        'Tab',
      ),
    ).toBe(false)
    // 空串或非法快捷键一律不匹配
    expect(
      matchesHotkey(
        { key: 'Tab', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
        '',
      ),
    ).toBe(false)
    expect(
      matchesHotkey(
        { key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
        'a',
      ),
    ).toBe(false)
  })

  it('formatHotkey 按平台格式化显示', () => {
    expect(formatHotkey('Ctrl+Alt+Shift+Meta+R', false)).toBe('Ctrl+Alt+Shift+Meta+R')
    expect(formatHotkey('Ctrl+Alt+Shift+Meta+R', true)).toBe('⌃+⌥+⇧+⌘+R')
    expect(formatHotkey('Tab', true)).toBe('Tab')
    expect(formatHotkey('', false)).toBe('')
    expect(formatHotkey('invalid', false)).toBe('')
  })
})
