// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crxIdOf, extensionIdOf, packCrx } from '../../../scripts/crx'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')
const SCRIPT = join(ROOT, 'scripts/pack-crx.ts')
/** 单次运行的时限：含 tsx 启动 */
const CLI_TIMEOUT_MS = 20_000

/** 以本地文件头开始的 zip（内容不必完整，CRX 原样附上） */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('Sample text')])
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const SPKI = publicKey.export({ type: 'spki', format: 'der' })

function uint32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

describe('扩展 ID', () => {
  it('crx_id 是公钥 SHA-256 的前 16 字节；扩展 ID 是其十六进制写法，0-f 换成 a-p', () => {
    expect(crxIdOf(SPKI)).toEqual(createHash('sha256').update(SPKI).digest().subarray(0, 16))
    expect(extensionIdOf(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'))).toBe(
      'aaabacadaeafagahaiajakalamanaoap',
    )
    expect(extensionIdOf(Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'))).toBe(
      'ppoonnmmllkkjjiihhggffeeddccbbaa',
    )
  })
})

describe('packCrx', () => {
  const crx = packCrx(ZIP, privateKey)
  const headerLength = crx.bytes.readUInt32LE(8)
  const header = crx.bytes.subarray(12, 12 + headerLength)
  const crxId = createHash('sha256').update(SPKI).digest().subarray(0, 16)
  /** SignedData：字段 1（crx_id），长度 16 */
  const signedData = Buffer.concat([Buffer.from([0x0a, 0x10]), crxId])
  const signedContent = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), uint32LE(18), signedData, ZIP])

  it('魔数「Cr24」、格式版本 3、文件头长度，zip 原样附在文件头之后', () => {
    expect(crx.bytes.subarray(0, 4).toString('latin1')).toBe('Cr24')
    expect(crx.bytes.readUInt32LE(4)).toBe(3)
    expect(crx.bytes.subarray(12 + headerLength)).toEqual(ZIP)
  })

  it('文件头逐字节同 crx3.proto：sha256_with_rsa（公钥、签名）在前，signed_header_data（字段 10000）在后', () => {
    // RSA-2048 的 SPKI 294 字节、签名 256 字节；PKCS#1 v1.5 签名是确定的，可独立算出
    expect(SPKI.length).toBe(294)
    const signature = sign('sha256', signedContent, privateKey)
    const expected = Buffer.concat([
      Buffer.from([0x12, 0xac, 0x04]), // 字段 2，长度 556
      Buffer.from([0x0a, 0xa6, 0x02]), // 字段 1（公钥），长度 294
      SPKI,
      Buffer.from([0x12, 0x80, 0x02]), // 字段 2（签名），长度 256
      signature,
      Buffer.from([0x82, 0xf1, 0x04, 0x12]), // 字段 10000，长度 18
      signedData,
    ])
    expect(header).toEqual(expected)
    expect(headerLength).toBe(581)
  })

  it('签名用公钥验证通过；zip 改动后不通过', () => {
    const signature = header.subarray(3 + 3 + 294 + 3, 3 + 3 + 294 + 3 + 256)
    expect(verify('sha256', signedContent, publicKey, signature)).toBe(true)
    const tampered = Buffer.from(signedContent)
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1)
    expect(verify('sha256', tampered, publicKey, signature)).toBe(false)
  })

  it('扩展 ID 由私钥决定：同一私钥相同，换私钥不同', () => {
    expect(crx.id).toBe(extensionIdOf(crxId))
    expect(crx.id).toMatch(/^[a-p]{32}$/)
    expect(packCrx(Buffer.concat([ZIP, Buffer.from('2')]), privateKey).id).toBe(crx.id)
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    expect(packCrx(ZIP, other).id).not.toBe(crx.id)
  })

  it('不是 RSA 私钥、不是 zip：报错', () => {
    expect(() => packCrx(ZIP, generateKeyPairSync('ed25519').privateKey)).toThrow('私钥须为 RSA 私钥')
    expect(() => packCrx(ZIP, publicKey)).toThrow('私钥须为 RSA 私钥')
    expect(() => packCrx(Buffer.from('Sample text'), privateKey)).toThrow('不是 zip 文件')
  })
})

describe('pack-crx 命令', { timeout: CLI_TIMEOUT_MS * 4 }, () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pack-crx-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 不带 CRX_PRIVATE_KEY 的环境，另加 extra */
  function run(args: readonly string[], extra: Readonly<Record<string, string>> = {}) {
    const { CRX_PRIVATE_KEY: _, ...env } = process.env
    const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...env, ...extra },
      timeout: CLI_TIMEOUT_MS,
    })
    return { status: result.status, output: `${result.stdout}${result.stderr}${result.error?.message ?? ''}` }
  }

  it('--key 指定 PKCS#8 私钥文件、环境变量给 PKCS#1 私钥：zip 旁生成同名 .crx，列出扩展 ID', () => {
    const zips = ['sample-chrome.zip', 'sample-edge.zip'].map((name) => join(dir, name))
    for (const zip of zips) writeFileSync(zip, ZIP)
    const keyFile = join(dir, 'key.pem')
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const { id } = packCrx(ZIP, privateKey)

    const byFile = run(['--key', keyFile, ...zips])
    expect(byFile.status, byFile.output).toBe(0)
    for (const zip of zips) {
      const crx = zip.replace(/\.zip$/, '.crx')
      expect(readFileSync(crx)).toEqual(packCrx(ZIP, privateKey).bytes)
      expect(byFile.output).toContain(`${crx}  扩展 ID ${id}`)
    }

    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    const byEnv = run([zips[0]!], { CRX_PRIVATE_KEY: pkcs1 })
    expect(byEnv.status, byEnv.output).toBe(0)
    expect(byEnv.output).toContain(`扩展 ID ${id}`)
  })

  it('匹配固定扩展ID才生成Chrome与Edge包', () => {
    const zips = ['chrome.zip', 'edge.zip'].map((name) => join(dir, name))
    for (const zip of zips) writeFileSync(zip, ZIP)
    const expectedId = createHash('sha256').update(SPKI).digest('hex').slice(0, 32)
      .split('').map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('')
    const result = run(['--expected-id', expectedId, ...zips], {
      CRX_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
    expect(result.status, result.output).toBe(0)
    for (const zip of zips) expect(readFileSync(zip.replace(/\.zip$/, '.crx')).subarray(0, 4).toString()).toBe('Cr24')
    expect(result.output).toContain(`扩展 ID ${expectedId}`)
  })

  it('固定ID不匹配不创建或覆盖任何输出，非法ID也拒绝', () => {
    const zips = ['chrome.zip', 'edge.zip'].map((name) => join(dir, name))
    for (const zip of zips) writeFileSync(zip, ZIP)
    const extra = { CRX_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
    const mismatch = 'a'.repeat(32)
    expect(createHash('sha256').update(SPKI).digest('hex').slice(0, 32)).not.toBe('0'.repeat(32))
    const result = run(['--expected-id', mismatch, ...zips], extra)
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('签名密钥不匹配')
    for (const zip of zips) expect(existsSync(zip.replace(/\.zip$/, '.crx'))).toBe(false)
    for (const zip of zips) writeFileSync(zip.replace(/\.zip$/, '.crx'), 'sentinel')
    expect(run(['--expected-id', mismatch, ...zips], extra).status).toBe(1)
    for (const zip of zips) expect(readFileSync(zip.replace(/\.zip$/, '.crx'), 'utf8')).toBe('sentinel')
    expect(run(['--expected-id', 'invalid-id', ...zips], extra)).toMatchObject({ status: 1, output: expect.stringContaining('32 位 a-p') })
  })

  it('缺少参数、私钥，私钥无法解析，不是 .zip：退出码 1', () => {
    const zip = join(dir, 'sample.zip')
    writeFileSync(zip, ZIP)
    for (const [args, extra, message] of [
      [[], {}, '用法：bun run pack:crx'],
      [[zip], {}, '缺少私钥'],
      [[zip], { CRX_PRIVATE_KEY: 'Sample text' }, '私钥无法解析'],
      [[join(dir, 'sample.txt')], {}, '不是 .zip 文件'],
    ] as const) {
      const { status, output } = run(args, extra)
      expect(status, output).toBe(1)
      expect(output).toContain(message)
    }
  })
})
