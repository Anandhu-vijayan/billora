// scripts/_ts-import.mjs — load a dependency-light TypeScript module from a
// plain .mjs runner (kept explicit so the suite also runs on Node 20, which
// has no native type-stripping). Transpiles the source with the installed
// `typescript` package and dynamic-imports it.
//
// Supports RELATIVE imports between dependency-free modules (e.g. ledger.ts ->
// ./gstin): every relative `.ts` dependency is transpiled too, into a cache dir
// that mirrors the source layout, and the import specifiers are rewritten to
// the emitted `.mjs` files. The `@/` alias is still NOT supported — modules that
// need it (anything touching Supabase/env/logger) stay out of this loader.
// Used by reencrypt-legacy.mjs and the tests so they exercise the REAL code,
// not a copy — a divergent reimplementation would silently break production.
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const req = createRequire(join(process.cwd(), '_resolver-anchor.js'))

let cacheDir
const compiled = new Map() // absolute .ts path -> emitted .mjs path
const root = process.cwd()

function resolveRelative(fromAbs, spec) {
  const base = resolve(dirname(fromAbs), spec)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate
  }
  throw new Error(`_ts-import: cannot resolve relative import "${spec}" from ${fromAbs}`)
}

function compile(abs) {
  const cached = compiled.get(abs)
  if (cached) return cached
  cacheDir ??= mkdtempSync(join(tmpdir(), 'billora-ts-import-'))
  const outFile = join(cacheDir, relative(root, abs).replace(/\.ts$/, '.mjs'))
  compiled.set(abs, outFile) // set first: tolerates import cycles
  const src = readFileSync(abs, 'utf8')
  let { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: abs,
  })
  // Rewrite relative specifiers (static + dynamic) to the emitted .mjs files.
  outputText = outputText.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_m, lead, quote, spec) => {
      const dep = compile(resolveRelative(abs, spec))
      return `${lead}${quote}${pathToFileURL(dep).href}${quote}`
    },
  )
  // Bridge BARE third-party specifiers (e.g. 'exceljs') to their resolved file
  // URL. The emitted module lives in a temp dir, so Node's own node_modules
  // walk-up would not find the package; resolving from the project root lets a
  // dependency-light module exercise the REAL package (never a copy). Builtins
  // (node:*), the unsupported '@/' alias, and anything unresolvable are left
  // untouched so existing behaviour is preserved.
  outputText = outputText.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(['"])(?!node:|\/|\.{1,2}\/|file:)([A-Za-z@][^'"]*)\2/g,
    (m, lead, quote, spec) => {
      if (spec.startsWith('@/')) return m // alias stays unsupported by design
      try { return `${lead}${quote}${pathToFileURL(req.resolve(spec)).href}${quote}` }
      catch { return m }
    },
  )
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, outputText)
  return outFile
}

export async function importTs(tsRelPath) {
  const abs = resolve(root, tsRelPath)
  return import(pathToFileURL(compile(abs)).href)
}
