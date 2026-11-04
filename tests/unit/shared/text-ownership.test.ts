import { afterEach, describe, expect, it } from 'vitest'
import { BUILD_ID } from '../../../src/shared/build-id'
import { textOwnership, type TextOwnership } from '../../../src/shared/text-ownership'

const LEGACY_KEY = Symbol.for('wt:text-ownership')
const OWNERSHIP_KEY = Symbol.for(`wt:text-ownership:v2:${BUILD_ID}`)
const holder = globalThis as Record<symbol, unknown>

afterEach(() => {
  Reflect.deleteProperty(holder, LEGACY_KEY)
  Reflect.deleteProperty(holder, OWNERSHIP_KEY)
})

describe('textOwnership', () => {
  it('claim 后 ownerOf 返回所有者；节点文字改变后返回 undefined', () => {
    const ownership = textOwnership()
    const node = document.createTextNode('议题')
    expect(ownership.ownerOf(node)).toBeUndefined()

    ownership.claim(node, 'github', '议题')
    expect(ownership.ownerOf(node)).toBe('github')

    ownership.claim(node, 'web', '议题')
    expect(ownership.ownerOf(node)).toBe('web')

    node.data = 'Issues'
    expect(ownership.ownerOf(node)).toBeUndefined()
  })

  it('release 只释放自己的登记，不改动另一方的登记', () => {
    const ownership = textOwnership()
    const node = document.createTextNode('议题')
    ownership.claim(node, 'github', '议题')

    ownership.release(node, 'web')
    expect(ownership.ownerOf(node)).toBe('github')

    ownership.release(node, 'github')
    expect(ownership.ownerOf(node)).toBeUndefined()
  })

  it('两次 textOwnership() 返回同一对象', () => {
    const first = textOwnership()
    const second = textOwnership()
    expect(second).toBe(first)
  })

  it('globalThis 下已有合规对象时直接复用，非法对象（缺函数、版本或构建号不符）时替换为新实例', () => {
    const custom: TextOwnership = {
      version: 2,
      buildId: BUILD_ID,
      claim() {},
      release() {},
      ownerOf: () => 'github',
    }
    holder[OWNERSHIP_KEY] = custom
    expect(textOwnership()).toBe(custom)

    holder[OWNERSHIP_KEY] = { ...custom, version: 1 }
    const fromBadVersion = textOwnership()
    expect(fromBadVersion).not.toBe(custom)
    expect(fromBadVersion.version).toBe(2)
    expect(fromBadVersion.buildId).toBe(BUILD_ID)

    holder[OWNERSHIP_KEY] = { ...custom, buildId: `${BUILD_ID}-other` }
    const fromBadBuild = textOwnership()
    expect(fromBadBuild).not.toBe(custom)
    expect(fromBadBuild.buildId).toBe(BUILD_ID)

    holder[OWNERSHIP_KEY] = { version: 2, buildId: BUILD_ID, claim() {}, release() {} }
    const replaced = textOwnership()
    expect(replaced).not.toBe(custom)
    expect(typeof replaced.ownerOf).toBe('function')
    expect(holder[OWNERSHIP_KEY]).toBe(replaced)
  })

  it('带 scope 的登记在 scope.active 置为 false 后失效，不影响其他 scope 与无 scope 登记', () => {
    const ownership = textOwnership()
    const scopeA = { active: true }
    const scopeB = { active: true }
    const nodeA = document.createTextNode('议题')
    const nodeB = document.createTextNode('拉取请求')
    const nodeWeb = document.createTextNode('设置')

    ownership.claim(nodeA, 'github', '议题', scopeA)
    ownership.claim(nodeB, 'github', '拉取请求', scopeB)
    ownership.claim(nodeWeb, 'web', '设置')

    scopeA.active = false
    expect(ownership.ownerOf(nodeA)).toBeUndefined()
    expect(ownership.ownerOf(nodeB)).toBe('github')
    expect(ownership.ownerOf(nodeWeb)).toBe('web')
  })
})
