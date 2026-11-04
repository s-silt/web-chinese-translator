/**
 * 把扩展 zip 打包成 CRX3（格式见 crx.ts）。
 *
 * 用法：bun run pack:crx [--key <私钥文件>] [--expected-id <扩展ID>] <zip>...
 *   私钥：RSA 私钥 PEM（PKCS#1 或 PKCS#8），取自 --key 指定的文件，没有 --key 时取环境变量 CRX_PRIVATE_KEY。
 *   扩展 ID 由私钥决定，各版本须用同一私钥
 * 输出：与 zip 同目录、同名的 .crx，并列出扩展 ID
 */
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { packCrx } from './crx'

const USAGE = '用法：bun run pack:crx [--key <私钥文件>] [--expected-id <扩展ID>] <zip>...'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadKey(file: string | undefined): Promise<KeyObject> {
  const pem = file === undefined ? process.env.CRX_PRIVATE_KEY : await readFile(file, 'utf8')
  if (!pem?.trim()) throw new Error('缺少私钥：--key <私钥文件> 或环境变量 CRX_PRIVATE_KEY')
  try {
    return createPrivateKey(pem)
  } catch (error) {
    throw new Error(`私钥无法解析：${errorMessage(error)}`, { cause: error })
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { key: { type: 'string' }, 'expected-id': { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length === 0) throw new Error(USAGE)
  const expectedId = values['expected-id']
  if (expectedId !== undefined && !/^[a-p]{32}$/.test(expectedId)) {
    throw new Error('扩展 ID 须为 32 位 a-p 字母')
  }
  const bad = positionals.find((file) => !file.endsWith('.zip'))
  if (bad !== undefined) throw new Error(`不是 .zip 文件：${bad}`)
  const key = await loadKey(values.key)
  for (const zip of positionals) {
    const crx = packCrx(await readFile(zip), key)
    if (expectedId !== undefined && crx.id !== expectedId) {
      throw new Error(`签名密钥不匹配：预期扩展 ID ${expectedId}，实际 ${crx.id}`)
    }
    const out = `${zip.slice(0, -'.zip'.length)}.crx`
    await writeFile(out, crx.bytes)
    process.stdout.write(`${out}  扩展 ID ${crx.id}\n`)
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`)
  process.exitCode = 1
}
