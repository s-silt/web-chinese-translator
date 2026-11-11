import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import ts from 'typescript'

const TRANSLATION_DIR = resolve(import.meta.dirname, '../../src/translation')

/** 转译后仍保留的相对导入（仅类型的导入已被擦除），依赖在前、入口在后 */
async function transpileTranslationModules(entryFiles: readonly string[]): Promise<Array<{ readonly spec: string; readonly code: string }>> {
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  }
  const ordered: Array<{ readonly spec: string; readonly code: string }> = []
  const visited = new Set<string>()
  async function visit(file: string, chain: readonly string[]): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const raw = await readFile(resolve(TRANSLATION_DIR, file), 'utf8')
    const code = ts.transpileModule(raw, { compilerOptions }).outputText
    for (const match of code.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]!
      if (spec === '../components/ui-tokens.css?inline' || spec === '../components/progress.css?inline') {
        if (!visited.has(spec)) {
          visited.add(spec)
          const css = await readFile(resolve(TRANSLATION_DIR, spec.replace(/\?inline$/, '')), 'utf8')
          ordered.push({ spec, code: `export default ${JSON.stringify(css)};` })
        }
        continue
      }
      // 只支持同目录模块：越出 src/translation 的依赖说明组件不再适合在页面里单独挂载
      if (!/^\.\/[\w-]+$/.test(spec)) {
        throw new Error(`${[...chain, file].join(' → ')} 导入了 ${spec}，组件夹具只支持同目录模块`)
      }
      await visit(`${spec.slice(2)}.ts`, [...chain, file])
    }
    ordered.push({ spec: `./${file.replace(/\.ts$/, '')}`, code })
  }
  for (const entry of entryFiles) await visit(entry, [])
  return ordered
}

export async function createTranslationModuleUrls(page: Page, entryFiles: readonly string[]): Promise<Record<string, string>> {
  const modules = await transpileTranslationModules(entryFiles)
  return page.evaluate(({ list }) => {
    const urlMap: Record<string, string> = {}
    for (const item of list) {
      let rewritten = item.code
      for (const [spec, blobUrl] of Object.entries(urlMap)) {
        rewritten = rewritten
          .replaceAll(`from '${spec}'`, `from '${blobUrl}'`)
          .replaceAll(`from "${spec}"`, `from "${blobUrl}"`)
      }
      urlMap[item.spec] = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
    }
    return urlMap
  }, { list: modules })
}
