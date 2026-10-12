// scripts/_ts-import.mjs — load a dependency-light TypeScript module from a
// plain .mjs runner (Node 20 has no native type-stripping). Transpiles the
// source with the installed `typescript` package and dynamic-imports it.
//
// Only for modules whose imports are Node builtins or relative paths WITHOUT the
// `@/` alias (lib/encryption/files.ts qualifies). Used by reencrypt-legacy.mjs
// and the Stage-1 crypto tests so they exercise the REAL encryption code, not a
// copy — a divergent reimplementation would silently break Stage-3 decryption.
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let cacheDir
export async function importTs(tsRelPath) {
  const abs = resolve(process.cwd(), tsRelPath)
  const src = readFileSync(abs, 'utf8')
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: abs,
  })
  cacheDir ??= mkdtempSync(join(tmpdir(), 'billora-ts-import-'))
  const outFile = join(cacheDir, abs.replace(/[A-Za-z]:|[\\/]/g, '_') + '.mjs')
  writeFileSync(outFile, outputText)
  return import(pathToFileURL(outFile).href)
}
