/**
 * 统计 src/locales/zh-CN 与 src/locales/zh-TW 的重复文件与共享英文键体积，
 * 为后续简繁词库基线 + 差异补丁重构提供量化依据。
 * 用法：bun run scripts/locale-dedup-report.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

function listTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) results.push(...listTsFiles(full))
    else if (entry.endsWith('.ts')) results.push(full)
  }
  return results.sort()
}

export function analyzeLocaleDuplication(root: string): {
  cnFiles: number
  twFiles: number
  cnBytes: number
  twBytes: number
  identicalFiles: number
  identicalBytes: number
} {
  const cnRoot = join(root, 'src/locales/zh-CN')
  const twRoot = join(root, 'src/locales/zh-TW')
  const cnList = listTsFiles(cnRoot)
  const twList = listTsFiles(twRoot)
  let cnBytes = 0
  let twBytes = 0
  let identicalFiles = 0
  let identicalBytes = 0

  for (const file of cnList) {
    const content = readFileSync(file)
    cnBytes += content.byteLength
    const rel = relative(cnRoot, file)
    const twFile = join(twRoot, rel)
    try {
      const twContent = readFileSync(twFile)
      if (content.equals(twContent)) {
        identicalFiles += 1
        identicalBytes += twContent.byteLength
      }
    } catch {
      // missing pair handled by check:parity
    }
  }
  for (const file of twList) {
    twBytes += statSync(file).size
  }
  return { cnFiles: cnList.length, twFiles: twList.length, cnBytes, twBytes, identicalFiles, identicalBytes }
}

if (import.meta.main) {
  const report = analyzeLocaleDuplication(process.cwd())
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
