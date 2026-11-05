import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zhCN from '../../../src/i18n/zh-CN'
import { createSubtitleTranslation } from '../../../src/translation/subtitles'
import { readSubtitleSample } from '../../../src/translation/subtitle-source'
import { getCapturedShadowRoot, installShadowRootCapture, requireCapturedShadowRoot } from '../shared/shadow-roots'

interface FakeCue {
  startTime: number
  endTime: number
  text: string
  getCueAsHTML?: () => DocumentFragment
}

class FakeTrack extends EventTarget {
  mode: TextTrackMode = 'showing'
  kind: TextTrackKind = 'subtitles'
  language = 'en'
  activeCues: FakeCue[] = []
  cues: FakeCue[] = []
}

function attachFakeTracks(video: HTMLVideoElement, tracks: FakeTrack[]): EventTarget {
  const listTarget = new EventTarget()
  const trackList = Object.assign(listTarget, {
    length: tracks.length,
    ...Object.fromEntries(tracks.map((track, idx) => [idx, track])),
  })
  Object.defineProperty(video, 'textTracks', {
    configurable: true,
    get: () => trackList,
  })
  return listTarget
}

let restoreShadowCapture: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  restoreShadowCapture = installShadowRootCapture()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 20, y: 20, width: 640, height: 360, top: 20, left: 20, right: 660, bottom: 380 }) as DOMRect,
  )
  vi.stubGlobal('location', new URL('https://example.com/watch'))
})

afterEach(() => {
  restoreShadowCapture?.()
  restoreShadowCapture = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function overlayBubble(): HTMLElement | null {
  const host = document.querySelector('[data-wt-root]')
  const root = getCapturedShadowRoot(host)
  return root?.querySelector<HTMLElement>('.bubble') ?? null
}

function isOverlayVisible(): boolean {
  const host = document.querySelector<HTMLElement>('[data-wt-root]')
  return host !== null && host.style.display !== 'none'
}

describe('标准 HTMLVideoElement TextTrack 字幕翻译', () => {
  it('翻译英语和日语字幕并预取后续最多 4 条（总计 <=5），保留源轨道且不重复请求已缓存行', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'currentTime', { value: 2, writable: true, configurable: true })
    document.body.append(video)

    const track = new FakeTrack()
    track.language = 'ja'
    const c1: FakeCue = { startTime: 1, endTime: 4, text: 'こんにちは' }
    const c2: FakeCue = { startTime: 5, endTime: 8, text: '世界' }
    const c3: FakeCue = { startTime: 9, endTime: 11, text: '字幕テスト' }
    const c4: FakeCue = { startTime: 12, endTime: 14, text: '四番目' }
    const c5: FakeCue = { startTime: 15, endTime: 16, text: '五番目' }
    const c6: FakeCue = { startTime: 16, endTime: 17, text: '六番目（超上限）' }
    const cFar: FakeCue = { startTime: 30, endTime: 32, text: '远期字幕' }
    track.activeCues = [c1]
    track.cues = [c1, c2, c3, c4, c5, c6, cFar]
    attachFakeTracks(video, [track])

    const sample = readSubtitleSample(video)
    expect(sample?.text).toBe('こんにちは')
    expect(sample?.upcoming).toEqual(['世界', '字幕テスト', '四番目', '五番目'])

    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: texts.map((t) => `译:${t}`),
    }))
    const cancel = vi.fn()
    const watcher = createSubtitleTranslation({
      translate,
      cancel,
      t: (k) => zhCN[k],
    })

    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['こんにちは', '世界', '字幕テスト', '四番目', '五番目'])
    expect(isOverlayVisible()).toBe(true)
    expect(overlayBubble()?.textContent).toBe('译:こんにちは')
    expect(track.mode).toBe('showing')

    track.activeCues = [c2]
    track.dispatchEvent(new Event('cuechange'))
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(overlayBubble()?.textContent).toBe('译:世界')

    watcher.dispose()
    expect(document.querySelector('[data-wt-root]')).toBeNull()
  })

  it('定位跳转、切轨与旧请求晚到：seeking/ended 期间暂停请求并隐藏，seeked 后翻译新行且忽略过期回复', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'currentTime', { value: 1, writable: true, configurable: true })
    let seekingState = false
    let endedState = false
    Object.defineProperty(video, 'seeking', { get: () => seekingState, configurable: true })
    Object.defineProperty(video, 'ended', { get: () => endedState, configurable: true })
    document.body.append(video)
    const track = new FakeTrack()
    track.language = 'en'
    track.activeCues = [{ startTime: 0, endTime: 3, text: 'Old line before seek' }]
    attachFakeTracks(video, [track])

    let resolveFirst!: (val: { ok: true; texts: string[] }) => void
    const translate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementation(async (texts: string[]) => ({
        ok: true as const,
        texts: texts.map((t) => `新:${t}`),
      }))
    const cancel = vi.fn()
    const watcher = createSubtitleTranslation({
      translate,
      cancel,
      t: (k) => zhCN[k],
    })

    expect(translate).toHaveBeenCalledTimes(1)
    const firstId = translate.mock.calls[0]?.[1] as string

    seekingState = true
    video.currentTime = 21
    track.activeCues = [{ startTime: 20, endTime: 25, text: 'New line after seek' }]
    video.dispatchEvent(new Event('seeking'))
    expect(cancel).toHaveBeenCalledWith(firstId)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(isOverlayVisible()).toBe(false)

    resolveFirst({ ok: true, texts: ['旧译文不应覆盖'] })
    await Promise.resolve()
    expect(isOverlayVisible()).toBe(false)

    seekingState = false
    video.dispatchEvent(new Event('seeked'))
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(overlayBubble()?.textContent).toBe('新:New line after seek')

    endedState = true
    video.dispatchEvent(new Event('ended'))
    expect(isOverlayVisible()).toBe(false)

    watcher.dispose()
  })

  it('同代同源同文本请求 A 被取消后发出请求 B，A 先返回绝不能显示/缓存或吞掉 B 的 pendingSample，时间跳变但未触发 seeking 的旧回复也被丢弃', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'currentTime', { value: 5, writable: true, configurable: true })
    document.body.append(video)
    const track = new FakeTrack()
    track.language = 'en'
    track.activeCues = [{ startTime: 5, endTime: 8, text: 'Same text' }]
    attachFakeTracks(video, [track])

    const resolvers: Array<(val: { ok: true; texts: string[] }) => void> = []
    const translate = vi.fn(
      (_texts: string[], _requestId: string) =>
        new Promise<{ ok: true; texts: string[] }>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const cancel = vi.fn()
    const watcher = createSubtitleTranslation({
      translate,
      cancel,
      t: (k) => zhCN[k],
    })

    expect(translate).toHaveBeenCalledTimes(1)
    const idA = translate.mock.calls[0]?.[1] as string

    track.dispatchEvent(new Event('cuechange'))
    expect(cancel).toHaveBeenCalledWith(idA)
    expect(translate).toHaveBeenCalledTimes(2)

    track.activeCues = [{ startTime: 6, endTime: 9, text: 'Pending while B in flight' }]
    resolvers[0]!({ ok: true, texts: ['Stale-A'] })
    await Promise.resolve()
    expect(isOverlayVisible()).toBe(false)
    expect(translate).toHaveBeenCalledTimes(2)

    resolvers[1]!({ ok: true, texts: ['Fresh-B'] })
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(3)
    expect(translate.mock.calls[2]?.[0]).toEqual(['Pending while B in flight'])

    video.currentTime = 100
    track.activeCues = [{ startTime: 100, endTime: 104, text: 'Jumped line' }]
    resolvers[2]!({ ok: true, texts: ['Stale before time jump'] })
    await Promise.resolve()
    expect(overlayBubble()?.textContent ?? '').not.toBe('Stale before time jump')
    expect(translate).toHaveBeenCalledTimes(4)
    expect(translate.mock.calls[3]?.[0]).toEqual(['Jumped line'])

    resolvers[3]!({ ok: true, texts: ['Translated jumped line'] })
    await Promise.resolve()
    expect(overlayBubble()?.textContent).toBe('Translated jumped line')

    watcher.dispose()
  })

  it('旧字幕源迟到回复在下次发现前返回不能污染新字幕源缓存', async () => {
    vi.stubGlobal('location', new URL('https://www.youtube.com/watch?v=test'))
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
        <video></video>
        <div class="ytp-caption-window-container">
          <span class="ytp-caption-segment">Shared line</span>
        </div>
      </div>
    `
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'currentTime', { value: 2, writable: true, configurable: true })

    let resolveDomReq!: (val: { ok: true; texts: string[] }) => void
    const translate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDomReq = resolve
          }),
      )
      .mockImplementation(async (texts: string[]) => ({
        ok: true as const,
        texts: texts.map((t) => `Track:${t}`),
      }))
    const watcher = createSubtitleTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    expect(translate).toHaveBeenCalledTimes(1)

    const track = new FakeTrack()
    track.language = 'en'
    track.activeCues = [{ startTime: 1, endTime: 4, text: 'Shared line' }]
    attachFakeTracks(video, [track])

    resolveDomReq({ ok: true, texts: ['Stale-DOM-Translation'] })
    await Promise.resolve()
    await Promise.resolve()

    expect(translate).toHaveBeenCalledTimes(2)
    expect(overlayBubble()?.textContent).toBe('Track:Shared line')

    watcher.dispose()
  })

  it('恶意服务端返回内容仅按纯文本渲染，不解析 HTML', async () => {
    const video = document.createElement('video')
    document.body.append(video)
    const track = new FakeTrack()
    track.activeCues = [{ startTime: 0, endTime: 5, text: 'Hello' }]
    attachFakeTracks(video, [track])

    const malicious = '<img src=x onerror="window.__xss=1">'
    const watcher = createSubtitleTranslation({
      translate: async () => ({ ok: true, texts: [malicious] }),
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })
    await Promise.resolve()

    const shadow = requireCapturedShadowRoot(document.querySelector('[data-wt-root]'))
    expect(shadow.querySelector('img')).toBeNull()
    expect(overlayBubble()?.textContent).toBe(malicious)
    watcher.dispose()
  })
})

describe('YouTube 与 Netflix DOM 字幕回退（基于 DOM 夹具）', () => {
  it('YouTube 字幕滚动更新经过防抖，保留原字幕节点，广告期间暂停并清空', async () => {
    vi.stubGlobal('location', new URL('https://www.youtube.com/watch?v=test'))
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
        <video></video>
        <div class="ytp-caption-window-container">
          <span class="ytp-caption-segment">First part</span>
        </div>
        <div class="ytp-chrome-bottom"><button class="ytp-play-button">Play</button></div>
      </div>
    `
    const player = document.getElementById('movie_player')!
    const segContainer = player.querySelector('.ytp-caption-window-container')!
    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: texts.map((t) => `YT:${t}`),
    }))
    const cancel = vi.fn()
    const watcher = createSubtitleTranslation({
      translate,
      cancel,
      t: (k) => zhCN[k],
    })

    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(overlayBubble()?.textContent).toBe('YT:First part')
    expect(segContainer.textContent?.trim()).toBe('First part')

    segContainer.innerHTML = '<span class="ytp-caption-segment">Rolling 1</span>'
    await vi.advanceTimersByTimeAsync(100)
    segContainer.innerHTML = '<span class="ytp-caption-segment">Rolling 1</span><span class="ytp-caption-segment">Rolling 2</span>'
    await vi.advanceTimersByTimeAsync(240)
    expect(translate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]?.[0]).toEqual(['Rolling 1\nRolling 2'])
    expect(overlayBubble()?.textContent).toBe('YT:Rolling 1\nRolling 2')

    player.classList.add('ad-showing')
    await vi.advanceTimersByTimeAsync(50)
    expect(isOverlayVisible()).toBe(false)

    watcher.dispose()
  })

  it('Netflix 文字字幕正常翻译，图像字幕不发请求并显示不支持提示，非官方域名不启用选择器', async () => {
    vi.stubGlobal('location', new URL('https://www.netflix.com/watch/123'))
    document.body.innerHTML = `
      <div class="watch-video--player-view">
        <video></video>
        <div class="player-timedtext">
          <div class="player-timedtext-text-container"><span>Netflix line one</span></div>
        </div>
      </div>
    `
    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: texts.map((t) => `NF:${t}`),
    }))
    const watcher = createSubtitleTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(overlayBubble()?.textContent).toBe('NF:Netflix line one')

    const timedText = document.querySelector('.player-timedtext')!
    timedText.innerHTML = '<svg><image href="sub.png"/></svg>'
    await vi.advanceTimersByTimeAsync(300)
    expect(translate).toHaveBeenCalledTimes(1)
    expect(overlayBubble()?.textContent).toBe(zhCN.wtSubtitleWaitingHint)
    watcher.dispose()

    vi.stubGlobal('location', new URL('https://evil-netflix.com/watch/123'))
    const video = document.querySelector('video')!
    expect(readSubtitleSample(video)).toBeUndefined()
  })

  it('Netflix 隐藏叶子 span 不泄漏，且嵌套行内元素与 BR 换行完整保留而不重复或改动原 DOM', async () => {
    vi.stubGlobal('location', new URL('https://www.netflix.com/watch/123'))
    const hiddenHtml = '<span style="display:none">Secret hidden line</span>'
    document.body.innerHTML = `
      <div class="watch-video--player-view">
        <video></video>
        <div class="player-timedtext">
          <div class="player-timedtext-text-container">${hiddenHtml}</div>
        </div>
      </div>
    `
    const video = document.querySelector('video')!
    const container = document.querySelector<HTMLElement>('.player-timedtext-text-container')!
    expect(readSubtitleSample(video)).toBeUndefined()

    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: texts.map((t) => `NF:${t}`),
    }))
    const watcher = createSubtitleTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })
    await Promise.resolve()
    expect(translate).not.toHaveBeenCalled()
    expect(container.innerHTML).toBe(hiddenHtml)

    const nestedHtml = '<span>Hello <b>world</b><br><span hidden>hidden</span>こんにちは</span>'
    container.innerHTML = nestedHtml
    const renderedSnapshot = container.innerHTML
    const sample = readSubtitleSample(video)
    expect(sample?.text).toBe('Hello world\nこんにちは')

    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]?.[0]).toEqual(['Hello world\nこんにちは'])
    expect(overlayBubble()?.textContent).toBe('NF:Hello world\nこんにちは')
    expect(container.innerHTML).toBe(renderedSnapshot)

    watcher.dispose()
  })

  it('缓存上限 128 条且失败按 retryAfterMs 退避不死循环重试', async () => {
    const video = document.createElement('video')
    document.body.append(video)
    const track = new FakeTrack()
    attachFakeTracks(video, [track])

    let shouldFail = false
    const translate = vi.fn(async (texts: string[]) => {
      if (shouldFail) {
        return { ok: false as const, error: 'rate limit', code: 'rate_limited' as const, retryAfterMs: 3000 }
      }
      return { ok: true as const, texts: texts.map((t) => `C:${t}`) }
    })
    const watcher = createSubtitleTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    for (let i = 0; i < 130; i += 1) {
      video.currentTime = i + 0.5
      track.activeCues = [{ startTime: i, endTime: i + 1, text: `Line-${i}` }]
      track.dispatchEvent(new Event('cuechange'))
      await Promise.resolve()
    }
    expect(translate).toHaveBeenCalledTimes(130)

    video.currentTime = 129.5
    track.activeCues = [{ startTime: 129, endTime: 130, text: 'Line-129' }]
    track.dispatchEvent(new Event('cuechange'))
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(130)

    video.currentTime = 0.5
    track.activeCues = [{ startTime: 0, endTime: 1, text: 'Line-0' }]
    track.dispatchEvent(new Event('cuechange'))
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(131)

    shouldFail = true
    video.currentTime = 201
    track.activeCues = [{ startTime: 200, endTime: 205, text: 'Fail-Line' }]
    track.dispatchEvent(new Event('cuechange'))
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(132)
    expect(overlayBubble()?.textContent).toBe(zhCN.wtRetryBubbleTitle)

    video.currentTime = 207
    track.activeCues = [{ startTime: 206, endTime: 210, text: 'During-Backoff' }]
    track.dispatchEvent(new Event('cuechange'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(translate).toHaveBeenCalledTimes(132)

    shouldFail = false
    await vi.advanceTimersByTimeAsync(1100)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(133)
    expect(overlayBubble()?.textContent).toBe('C:During-Backoff')

    shouldFail = true
    video.currentTime = 301
    track.activeCues = [{ startTime: 300, endTime: 305, text: 'Fail-Then-CC-Off' }]
    track.dispatchEvent(new Event('cuechange'))
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(134)

    track.activeCues = [{ startTime: 306, endTime: 310, text: 'Obsolete-Retry-Sample' }]
    track.dispatchEvent(new Event('cuechange'))
    track.mode = 'disabled'
    track.activeCues = []
    track.dispatchEvent(new Event('cuechange'))
    expect(isOverlayVisible()).toBe(false)

    shouldFail = false
    await vi.advanceTimersByTimeAsync(3500)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(134)
    expect(isOverlayVisible()).toBe(false)

    watcher.dispose()
  })

  it('隐藏祖先或样式表隐藏的字幕不发请求，YouTube/Netflix 无可用字幕时提示，无关进度条变更不无限推迟防抖，广告期间拒绝原生轨道', async () => {
    vi.stubGlobal('location', new URL('https://www.youtube.com/watch?v=test'))
    const styleEl = document.createElement('style')
    styleEl.textContent = '.cc-hidden { display: none; }'
    document.head.append(styleEl)
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
        <video></video>
        <div class="ytp-caption-window-container cc-hidden">
          <span class="ytp-caption-segment">Hidden by stylesheet</span>
        </div>
        <div class="ytp-chrome-bottom"><div class="ytp-progress-bar" style="width: 10%"></div></div>
      </div>
    `
    const player = document.getElementById('movie_player')!
    const segContainer = player.querySelector<HTMLElement>('.ytp-caption-window-container')!
    const progressBar = player.querySelector<HTMLElement>('.ytp-progress-bar')!

    const translate = vi.fn(async (texts: string[]) => ({
      ok: true as const,
      texts: texts.map((t) => `YT:${t}`),
    }))
    const watcher = createSubtitleTranslation({
      translate,
      cancel: () => undefined,
      t: (k) => zhCN[k],
    })

    await Promise.resolve()
    expect(translate).not.toHaveBeenCalled()
    expect(isOverlayVisible()).toBe(true)
    expect(overlayBubble()?.textContent).toBe(zhCN.wtSubtitleWaitingHint)

    segContainer.classList.remove('cc-hidden')
    segContainer.innerHTML = '<span class="ytp-caption-segment">Visible caption</span>'
    await vi.advanceTimersByTimeAsync(100)
    progressBar.style.width = '20%'
    await vi.advanceTimersByTimeAsync(100)
    progressBar.style.width = '30%'
    await vi.advanceTimersByTimeAsync(80)
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(overlayBubble()?.textContent).toBe('YT:Visible caption')

    const video = player.querySelector('video')!
    const track = new FakeTrack()
    track.activeCues = [{ startTime: 0, endTime: 5, text: 'Ad track line' }]
    attachFakeTracks(video, [track])
    player.classList.add('ad-showing')
    await vi.advanceTimersByTimeAsync(50)
    track.dispatchEvent(new Event('cuechange'))
    await Promise.resolve()
    expect(translate).toHaveBeenCalledTimes(1)
    expect(isOverlayVisible()).toBe(false)

    watcher.dispose()
    styleEl.remove()
  })
})
