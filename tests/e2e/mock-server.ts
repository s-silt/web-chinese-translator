import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export const PHYSICS = 'Quantum decoherence destroys the interference pattern.'
export const ENTROPY = 'Entropy increases when information about the system is lost.'
export const THIRD = 'Measurements can change the state of an isolated quantum system.'
export const LONG_RESULT = '这是一段用于验证换行与内部滚动的较长译文。'.repeat(80)
export const PAGE_HTML = `<!doctype html><html><head><title>Physics notes</title>
<style>body{margin:24px;font:16px/1.6 sans-serif;min-height:1800px}p{max-width:720px;margin:24px 0}
pre{white-space:pre-wrap}#p2{margin-top:260px}.hostile *{box-sizing:content-box} .hostile div{font-size:40px!important}</style>
</head><body>
<main><h1>Physics notes</h1><p id="p1">${PHYSICS}</p>
<p id="p2">${ENTROPY}</p><p id="p3">${THIRD}</p>
<p>Understand this <span id="term">token</span> in its context.
<span hidden>HIDDEN_FIXTURE_MARKER</span><span data-sensitive>SENSITIVE_FIXTURE_MARKER</span>
<span style="opacity:0;position:absolute">TRANSPARENT_FIXTURE_MARKER</span>
<span style="opacity:0;position:absolute"><span>TRANSPARENT_ANCESTOR_MARKER</span></span>
<code>CODE_FIXTURE_MARKER</code><span contenteditable>EDITABLE_FIXTURE_MARKER</span></p>
<div id="shadow-host"></div>
<script>
  document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML =
    '<p id="shadow-p">Shadow DOM paragraph to translate.</p>'
</script></main>
</body></html>`

export interface MockCall {
  path: string
  auth: string | undefined
  kind: 'texts' | 'assist' | 'other'
  payload: Record<string, unknown>
  requestBody: Record<string, unknown>
  customHeader: string | undefined
  aborted: boolean
  /** 服务端收到请求、发现连接被客户端中止的时刻（毫秒） */
  at: number
  abortedAt: number | undefined
  /** 服务端发出正常（或 release 的）回复的时刻（毫秒）；挂起、注入故障时为 undefined */
  respondedAt: number | undefined
}

export interface MockModelCall {
  path: string
  auth: string | undefined
  customHeader: string | undefined
  status: number
}

/** 依次作用于之后的批量翻译请求：hang 不回复，等扩展自己超时；status 回错误状态 */
export type MockFault = { kind: 'hang' } | { kind: 'status'; status: number; retryAfter?: string }

export async function startMock(): Promise<{
  url: string
  calls: MockCall[]
  modelCalls: MockModelCall[]
  failModelsNext(status: number): void
  hold(text: string): void
  release(text: string, error?: boolean): void
  longResults(): void
  failNext(...next: MockFault[]): void
  wrongCountWhen(predicate: (texts: readonly string[]) => boolean): void
  /** 模拟慢接口：之后每个批量翻译请求都等这么久才回复 */
  delayTexts(ms: number): void
  close(): Promise<void>
}> {
  const calls: MockCall[] = []
  const modelCalls: MockModelCall[] = []
  let nextModelsStatus: number | undefined
  const held = new Set<string>()
  const responses = new Map<string, (error: boolean) => void>()
  const faults: MockFault[] = []
  let wrongCount: (texts: readonly string[]) => boolean = () => false
  let long = false
  let textsDelayMs = 0
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://fixture.test').pathname
    if (req.method === 'GET' && pathname.endsWith('/models')) {
      const status = nextModelsStatus ?? 200
      nextModelsStatus = undefined
      const customHeader = req.headers['x-fixture-token']
      modelCalls.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        customHeader: typeof customHeader === 'string' ? customHeader : undefined,
        status,
      })
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status === 200
        ? { data: [{ id: 'fixture-model-b' }, { id: 'fixture-model-a' }] }
        : { error: { message: 'Synthetic model-list failure' } }))
      return
    }
    if (new URL(req.url ?? '/', 'http://fixture.test').pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
      return
    }
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on('end', () => {
      if (req.method !== 'POST' || data === '') {
        res.writeHead(404).end()
        return
      }
      const responsesApi = new URL(req.url ?? '/', 'http://fixture.test').pathname.endsWith('/responses')
      const parsed = JSON.parse(data) as Record<string, unknown> & {
        messages?: { content: string }[]
        input?: { role: string; content: { type: string; text: string }[] }[]
      }
      const userText = responsesApi
        ? parsed.input?.find((item) => item.role === 'user')?.content.find((part) => part.type === 'input_text')?.text
        : parsed.messages?.[1]?.content
      const user = JSON.parse(userText ?? '{}') as Record<string, unknown>
      const customHeader = req.headers['x-fixture-token']
      const call: MockCall = {
        path: req.url ?? '',
        auth: req.headers.authorization,
        kind: 'texts' in user ? 'texts' : 'text' in user && 'trigger' in user ? 'assist' : 'other',
        payload: user,
        requestBody: parsed,
        customHeader: typeof customHeader === 'string' ? customHeader : undefined,
        aborted: false,
        at: Date.now(),
        abortedAt: undefined,
        respondedAt: undefined,
      }
      calls.push(call)
      res.on('close', () => {
        if (res.writableEnded) return
        call.aborted = true
        call.abortedAt = Date.now()
      })
      let content: string
      if (call.kind === 'texts') {
        const fault = faults.shift()
        if (fault?.kind === 'hang') return
        if (fault?.kind === 'status') {
          res.writeHead(fault.status, {
            'Content-Type': 'application/json',
            ...(fault.retryAfter === undefined ? {} : { 'Retry-After': fault.retryAfter }),
          })
          res.end('{"error":"synthetic failure"}')
          return
        }
        const texts = (user as { texts: string[] }).texts
        const results = texts.map((text) =>
          long || text.includes('constrained')
            ? LONG_RESULT
            : text.includes('</')
              // 行内占位：每个文本段译成「中文译文」，占位原样保留以便回填校验通过
              ? text
                  .split(/(<\/?\d+\/?>)/)
                  .map((part) => (part.startsWith('<') || part.trim() === '' ? part : '中文译文'))
                  .join('')
              : '中文译文',
        )
        content = JSON.stringify(wrongCount(texts) ? [...results, '多余条目'] : results)
      } else if (call.kind === 'assist') {
        content = JSON.stringify({
          decision: 'show',
          intent: 'define',
          translation: long ? LONG_RESULT : user.text === ENTROPY ? '熵与信息' : '量子退相干',
          explanation: '',
        })
      } else {
        content = JSON.stringify(['中文译文'])
      }
      const respond = (error = false): void => {
        if (res.destroyed) return
        call.respondedAt = Date.now()
        res.writeHead(error ? 500 : 200, { 'Content-Type': 'application/json' })
        const output = responsesApi
          ? {
              object: 'response',
              status: 'completed',
              output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Synthetic reasoning is not translation.' }] },
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: content, annotations: [] }],
                },
              ],
            }
          : { choices: [{ message: { content } }] }
        res.end(error ? '{"error":"synthetic failure"}' : JSON.stringify(output))
      }
      const heldText = typeof user.text === 'string'
        ? user.text
        : Array.isArray(user.texts) ? user.texts.find((text): text is string => typeof text === 'string' && held.has(text)) : undefined
      if (heldText !== undefined && held.delete(heldText)) responses.set(heldText, respond)
      else if (call.kind === 'texts' && textsDelayMs > 0) setTimeout(respond, textsDelayMs)
      else respond()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    modelCalls,
    failModelsNext: (status) => { nextModelsStatus = status },
    hold: (text) => { held.add(text) },
    release: (text, error = false) => {
      const respond = responses.get(text)
      if (respond === undefined) throw new Error(`No held response for fixture: ${text}`)
      respond(error)
      responses.delete(text)
    },
    longResults: () => { long = true },
    failNext: (...next) => { faults.push(...next) },
    wrongCountWhen: (predicate) => { wrongCount = predicate },
    delayTexts: (ms) => { textsDelayMs = ms },
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
