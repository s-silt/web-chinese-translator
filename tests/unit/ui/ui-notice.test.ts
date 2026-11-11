import { enableAutoUnmount, mount } from '@vue/test-utils'
import { importSfc, required } from './sfc'

const UiNotice = await importSfc(() => import('../../../src/components/ui/UiNotice.vue'))

enableAutoUnmount(afterEach)

describe.skipIf(!UiNotice)('UiNotice', () => {
  it('默认静态：无 role、无 aria-live，标题与内容正常渲染', () => {
    const wrapper = mount(required(UiNotice), {
      props: { tone: 'info', title: '提示' },
      slots: { default: '正文内容' },
    })
    const notice = wrapper.get('.ui-notice')
    expect(notice.attributes('role')).toBeUndefined()
    expect(notice.attributes('aria-live')).toBeUndefined()
    expect(notice.attributes('aria-atomic')).toBeUndefined()
    expect(wrapper.get('.ui-notice-title').text()).toBe('提示')
    expect(wrapper.get('.ui-notice-body').text()).toBe('正文内容')
  })

  it('live=polite 时是 status，live=assertive 时是 alert，且 aria-atomic', () => {
    const polite = mount(required(UiNotice), { props: { live: 'polite' }, slots: { default: '稍后' } })
    expect(polite.get('.ui-notice').attributes('role')).toBe('status')
    expect(polite.get('.ui-notice').attributes('aria-live')).toBe('polite')
    expect(polite.get('.ui-notice').attributes('aria-atomic')).toBe('true')
    const assertive = mount(required(UiNotice), { props: { live: 'assertive' }, slots: { default: '出错了' } })
    expect(assertive.get('.ui-notice').attributes('role')).toBe('alert')
    expect(assertive.get('.ui-notice').attributes('aria-live')).toBe('assertive')
    expect(assertive.get('.ui-notice').attributes('aria-atomic')).toBe('true')
  })

  it('槽位可放操作行，tone 决定样式类', () => {
    const wrapper = mount(required(UiNotice), {
      props: { tone: 'warning' },
      slots: { default: '<button data-test="act">去设置</button>' },
    })
    expect(wrapper.get('.ui-notice').classes()).toContain('ui-notice-warning')
    expect(wrapper.get('[data-test="act"]').text()).toBe('去设置')
  })
})
