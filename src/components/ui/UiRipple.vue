<template>
  <span ref="host" class="ui-ripple" aria-hidden="true">
    <span
      v-for="wave in waves"
      :key="wave.id"
      class="ui-ripple-wave"
      :style="{ left: `${wave.left}px`, top: `${wave.top}px`, width: `${wave.size}px`, height: `${wave.size}px` }"
      @animationend="remove(wave.id)"
    ></span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue'

/**
 * 水波纹：放在按钮（或按钮外观的链接）内部，监听它的按下与点击。
 * 指针按下时从按下位置扩散，键盘（Enter、空格）触发时从中心扩散；按钮禁用、系统要求减少动态效果时不生成。
 * 只追加装饰节点，不拦截、不延迟点击事件
 */
const { centered = false } = defineProps<{
  /** 总从中心扩散（不随指针位置），如开关的滑块 */
  centered?: boolean
}>()

interface Wave {
  readonly id: number
  /** 波纹外接正方形相对宿主的位置与边长 */
  readonly left: number
  readonly top: number
  readonly size: number
}

interface Point {
  readonly clientX: number
  readonly clientY: number
}

/** 同时保留的波纹数：连点时丢弃最早的；动画没有结束（如被浏览器暂停）也不会累积 */
const MAX_WAVES = 3

const host = useTemplateRef<HTMLElement>('host')
const waves = shallowRef<readonly Wave[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 0
let trigger: HTMLElement | null = null
let motionQuery: MediaQueryList | undefined

const FALLBACK_MS = 220

function reducedMotion(): boolean {
  return motionQuery?.matches ?? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function forcedColors(): boolean {
  return window.matchMedia?.('(forced-colors: active)').matches ?? false
}

function clearWaveTimer(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

/** 在指针位置生成波纹；没有位置或 centered 时从中心 */
function spawn(point?: Point): void {
  const element = host.value
  if (
    !element ||
    document.hidden ||
    reducedMotion() ||
    forcedColors() ||
    (trigger instanceof HTMLButtonElement && trigger.disabled) ||
    trigger?.getAttribute('aria-disabled') === 'true'
  ) {
    return
  }
  if (waves.value.length === 0) {
    watchMotionQuery(window.matchMedia?.('(prefers-reduced-motion: reduce)'))
  }
  const rect = element.getBoundingClientRect()
  const fromPoint = point !== undefined && !centered
  const x = fromPoint ? point.clientX - rect.left : rect.width / 2
  const y = fromPoint ? point.clientY - rect.top : rect.height / 2
  // 半径取到最远角的距离：扩散结束时覆盖整个宿主
  const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y))
  const wave: Wave = { id: nextId++, left: x - radius, top: y - radius, size: radius * 2 }
  const next = [...waves.value, wave]
  for (const dropped of next.slice(0, Math.max(0, next.length - MAX_WAVES))) {
    clearWaveTimer(dropped.id)
  }
  waves.value = next.slice(-MAX_WAVES)
  timers.set(
    wave.id,
    setTimeout(() => {
      remove(wave.id)
    }, FALLBACK_MS),
  )
}

function remove(id: number): void {
  clearWaveTimer(id)
  waves.value = waves.value.filter((wave) => wave.id !== id)
  if (waves.value.length === 0) unwatchMotionQuery()
}

function clearWaves(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  waves.value = []
  unwatchMotionQuery()
}

function onPointerdown(event: PointerEvent): void {
  // 只响应主键：鼠标左键、触摸、触控笔
  if (event.button === 0) spawn(event)
}

function onClick(event: MouseEvent): void {
  // 键盘触发的点击没有指针位置（detail 为 0）
  if (event.detail === 0) spawn()
}

function onMotionChange(): void {
  clearWaves()
}

function onPageHide(): void {
  clearWaves()
}

function onVisibilityChange(): void {
  if (document.hidden) clearWaves()
}

function watchMotionQuery(query: MediaQueryList | undefined): void {
  motionQuery = query
  if (typeof query?.addEventListener === 'function') query.addEventListener('change', onMotionChange)
  else query?.addListener?.(onMotionChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
}

function unwatchMotionQuery(): void {
  const query = motionQuery
  motionQuery = undefined
  if (typeof query?.removeEventListener === 'function') query.removeEventListener('change', onMotionChange)
  else query?.removeListener?.(onMotionChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('pagehide', onPageHide)
}

onMounted(() => {
  trigger = host.value?.parentElement?.closest<HTMLElement>('button, a') ?? null
  trigger?.addEventListener('pointerdown', onPointerdown)
  trigger?.addEventListener('click', onClick)
})

onBeforeUnmount(() => {
  trigger?.removeEventListener('pointerdown', onPointerdown)
  trigger?.removeEventListener('click', onClick)
  trigger = null
  clearWaves()
})
</script>

<style scoped>
/* 宿主铺满所在元素并按其圆角裁剪；颜色取文字色 */
.ui-ripple {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  border-radius: inherit;
}

/* 扩散先快后慢，淡出匀速；两段同时结束，animationend 时移除 */
.ui-ripple-wave {
  position: absolute;
  background: currentColor;
  border-radius: 50%;
  opacity: 0;
  transform: scale(0);
  animation:
    ui-ripple-grow var(--gcn-duration-base) var(--gcn-ease-ripple),
    ui-ripple-fade var(--gcn-duration-base) linear;
}

@media (prefers-reduced-motion: reduce) {
  .ui-ripple-wave {
    animation: none;
  }
}

/* 高对比度模式下背景色由系统接管，波纹没有意义 */
@media (forced-colors: active) {
  .ui-ripple {
    display: none;
  }
}

@keyframes ui-ripple-grow {
  from {
    transform: scale(0);
  }

  to {
    transform: scale(1);
  }
}

@keyframes ui-ripple-fade {
  from {
    opacity: 0.28;
  }

  40% {
    opacity: 0.22;
  }

  to {
    opacity: 0;
  }
}
</style>
