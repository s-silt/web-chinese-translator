import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ConnectionStatus from '../../../src/entrypoints/options/ConnectionStatus.vue'

describe('ConnectionStatus 草稿三态与放弃修改交互', () => {
  it('dirty=true 时展示未保存草稿徽章，并在 canDiscard=true 时提供放弃修改按钮', async () => {
    const wrapper = mount(ConnectionStatus, {
      props: {
        kind: 'ok',
        latencyMs: 120,
        dirty: true,
        canDiscard: true,
        disabled: true,
        disabledReason: 'Save your changes before testing',
      },
    })
    expect(wrapper.find('[data-test="wt-draft-badge"]').exists()).toBe(true)
    const discard = wrapper.find('[data-test="wt-discard-draft"]')
    expect(discard.exists()).toBe(true)
    await discard.trigger('click')
    expect(wrapper.emitted('discardDraft')).toHaveLength(1)
  })

  it('dirty=false 时隐藏未保存草稿徽章与放弃修改按钮', () => {
    const wrapper = mount(ConnectionStatus, {
      props: {
        kind: 'ok',
        latencyMs: 85,
        dirty: false,
        canDiscard: true,
      },
    })
    expect(wrapper.find('[data-test="wt-draft-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="wt-discard-draft"]').exists()).toBe(false)
  })

  it('首次配置无已保存配置（canDiscard=false）时显示草稿徽章但不显示放弃修改按钮', () => {
    const wrapper = mount(ConnectionStatus, {
      props: {
        kind: 'missing-model',
        dirty: true,
        canDiscard: false,
      },
    })
    expect(wrapper.find('[data-test="wt-draft-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="wt-discard-draft"]').exists()).toBe(false)
  })
})
