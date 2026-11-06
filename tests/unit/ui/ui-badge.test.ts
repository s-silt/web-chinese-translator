import { enableAutoUnmount, mount } from '@vue/test-utils'
import { importSfc, required } from './sfc'

const UiBadge = await importSfc(() => import('../../../src/components/ui/UiBadge.vue'))

enableAutoUnmount(afterEach)

describe.skipIf(!UiBadge)('UiBadge', () => {
  it('默认中性色调，不显示圆点，不是读屏状态区', () => {
    const wrapper = mount(required(UiBadge), { slots: { default: '未启用' } })
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['ui-badge', 'ui-badge-neutral']))
    expect(wrapper.attributes('role')).toBeUndefined()
    expect(wrapper.find('.ui-badge-dot').exists()).toBe(false)
    expect(wrapper.text()).toBe('未启用')
  })

  it.each(['success', 'attention', 'danger', 'accent'] as const)('tone=%s 带对应类名', (tone) => {
    const wrapper = mount(required(UiBadge), { props: { tone }, slots: { default: '状态' } })
    expect(wrapper.classes()).toContain(`ui-badge-${tone}`)
  })

  it('live 时作为读屏状态区', () => {
    const wrapper = mount(required(UiBadge), { props: { live: true }, slots: { default: '已翻译' } })
    expect(wrapper.attributes('role')).toBe('status')
  })

  it('dot 显示左侧圆点并对读屏隐藏', () => {
    const wrapper = mount(required(UiBadge), { props: { tone: 'success', dot: true }, slots: { default: '已翻译' } })
    const dot = wrapper.get('.ui-badge-dot')
    expect(dot.attributes('aria-hidden')).toBe('true')
    expect(wrapper.text()).toBe('已翻译')
  })
})
