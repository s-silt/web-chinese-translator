import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { importSfc, required } from './sfc'

const UiSwitch = await importSfc(() => import('../../../src/components/ui/UiSwitch.vue'))

enableAutoUnmount(afterEach)

describe.skipIf(!UiSwitch)('UiSwitch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('标签关联开关，状态由 aria-checked 表达', () => {
    const wrapper = mount(required(UiSwitch), { props: { checked: true, label: '启用' } })
    const toggle = wrapper.get('button[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(toggle.attributes('type')).toBe('button')
    expect(wrapper.get('label').attributes('for')).toBe(toggle.attributes('id'))
    expect(wrapper.get('label').text()).toBe('启用')
  })

  it('点击发出相反状态，不自行改变', async () => {
    const wrapper = mount(required(UiSwitch), { props: { checked: false, label: '启用' } })
    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[true]])
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
  })

  it('点击标签同样切换', async () => {
    const wrapper = mount(required(UiSwitch), { props: { checked: true, label: '启用' }, attachTo: document.body })
    await wrapper.get('label').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[false]])
  })

  it('禁用时不发出事件', async () => {
    const wrapper = mount(required(UiSwitch), { props: { checked: false, label: '启用', disabled: true } })
    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('同一页面内多个开关的 id 不重复', () => {
    const toggle = required(UiSwitch)
    const Page = defineComponent({
      render: () => [h(toggle, { checked: false, label: 'A' }), h(toggle, { checked: true, label: 'B' })],
    })
    const ids = mount(Page)
      .findAll('[role="switch"]')
      .map((item) => item.attributes('id'))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('aria、data-test 与 class 落到正确节点，显式 id 关联标签', () => {
    const wrapper = mount(required(UiSwitch), {
      props: { checked: false, label: '启用' },
      attrs: {
        id: 'my-switch',
        'aria-describedby': 'hint-id',
        'aria-label': '总开关',
        'data-test': 'wt-thing',
        class: 'extra-class',
      },
    })
    const root = wrapper.get('.ui-switch')
    const toggle = wrapper.get('[role="switch"]')
    expect(root.attributes('data-test')).toBe('wt-thing')
    expect(root.classes()).toContain('extra-class')
    expect(toggle.attributes('id')).toBe('my-switch')
    expect(wrapper.get('label').attributes('for')).toBe('my-switch')
    expect(toggle.attributes('aria-describedby')).toBe('hint-id')
    expect(toggle.attributes('aria-label')).toBe('总开关')
    expect(root.attributes('aria-describedby')).toBeUndefined()
    expect(root.attributes('aria-label')).toBeUndefined()
  })

  it('水波纹以滑块为中心，不随指针位置；对读屏隐藏', async () => {
    // 光晕层 32 × 32：中心 (16, 16)，半径 hypot(16, 16)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 32, 32))
    const wrapper = mount(required(UiSwitch), { props: { checked: false, label: '启用' } })
    const toggle = wrapper.get('[role="switch"]')
    toggle.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
    await wrapper.vm.$nextTick()
    const wave = toggle.get('.ui-ripple-wave').element as HTMLElement
    const radius = Math.hypot(16, 16)
    expect(parseFloat(wave.style.left)).toBeCloseTo(16 - radius)
    expect(parseFloat(wave.style.top)).toBeCloseTo(16 - radius)
    expect(parseFloat(wave.style.width)).toBeCloseTo(radius * 2)
    expect(toggle.get('.ui-ripple').attributes('aria-hidden')).toBe('true')
    expect(toggle.text()).toBe('')
  })
})
