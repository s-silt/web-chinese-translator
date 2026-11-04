import { vi } from 'vitest'

const capturedRoots = new WeakMap<Element, ShadowRoot>()
const nativeAttachShadow = Element.prototype.attachShadow

export function installShadowRootCapture(): () => void {
  const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = nativeAttachShadow.call(this, init)
    capturedRoots.set(this, root)
    return root
  })
  return () => {
    spy.mockRestore()
  }
}

export function getCapturedShadowRoot(host: Element | null | undefined): ShadowRoot | undefined {
  if (host === null || host === undefined) return undefined
  return capturedRoots.get(host)
}

export function requireCapturedShadowRoot(host: Element | null | undefined): ShadowRoot {
  const root = getCapturedShadowRoot(host)
  if (root === undefined) throw new Error('Missing captured shadow root')
  return root
}
