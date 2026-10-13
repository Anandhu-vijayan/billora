// lib/ocr/local.ts — pluggable LOCAL extraction seam (no bundled engine).
//
// The approved architecture is LOCAL-FIRST with a gated AI fallback: run a local
// PDF-text / OCR engine, parse deterministically, and only reach for a cloud
// provider for fields still uncertain (and only when the operator enabled AI).
// This file is the *seam* the extraction handler calls. It deliberately ships
// with NO OCR/PDF engine wired, because:
//   * tesseract.js / pdftotext are heavy, and their traineddata/binaries cannot
//     be installed or behaviorally verified in this environment;
//   * a fabricated or unverified "extraction result" would be worse than none.
// So the honest default is: no engine available -> tryLocalExtract reports a
// miss (never a made-up candidate), and the caller routes the invoice to
// needs_review. An operator enables a real engine by (a) installing it, (b)
// wiring an adapter that returns a LedgerCandidate, and (c) registering it here
// + setting LOCAL_OCR_ENGINE. Nothing in this module invents invoice data.
//
// Alias-free + import-only-types so it is unit-testable in-process (the test
// harness transpiles a single file and cannot resolve `@/` runtime imports).
import { createRequire } from 'node:module'
import type { LedgerCandidate } from './ledger'

export interface LocalExtractArgs {
  /** Decrypted original bytes, in memory only. */
  buffer: Buffer
  /** The validated MIME type stored on the invoice (pdf vs image pipeline). */
  mimeType: string
}

export interface LocalExtractHit {
  ok: true
  engine: string
  candidate: LedgerCandidate
}
export interface LocalExtractMiss {
  ok: false
  reason: 'no-engine' | 'engine-unavailable' | 'engine-error' | 'no-candidate'
  detail?: string
}
export type LocalExtractResult = LocalExtractHit | LocalExtractMiss

/** An operator-supplied local extractor (PDF text or OCR) -> raw candidate. */
export interface LocalEngineAdapter {
  id: string
  /** Return a candidate, or null when this input cannot be processed locally. */
  extract(args: LocalExtractArgs): Promise<LedgerCandidate | null>
}

const ENGINE_IDS = ['none', 'pdfjs-text', 'pdftotext', 'tesseract'] as const

let registered: LocalEngineAdapter | null = null

/** Test/operator seam: install (or clear with null) a local engine adapter. */
export function registerLocalEngine(engine: LocalEngineAdapter | null): void {
  registered = engine
}

/** The configured engine id from the environment (default 'none'). */
export function configuredEngineId(): (typeof ENGINE_IDS)[number] {
  const v = (process.env.LOCAL_OCR_ENGINE ?? 'none').trim().toLowerCase()
  return (ENGINE_IDS as readonly string[]).includes(v)
    ? (v as (typeof ENGINE_IDS)[number])
    : 'none'
}

/** The id that would run now: the wired adapter, else the configured engine. */
export function getLocalEngineId(): string {
  return registered ? registered.id : configuredEngineId()
}

/**
 * Whether a local engine is actually usable right now: a registered adapter, or
 * a configured engine whose module can be resolved. Never claims availability
 * for an uninstalled package.
 */
export function localEngineAvailable(): boolean {
  if (registered) return true
  const id = configuredEngineId()
  if (id === 'none') return false
  return probeEngineModule(id) !== null
}

// Best-effort PRESENCE check only — resolves (never executes) the module so we
// do not claim a package is usable when it is not installed. Any throw resolves
// to "unavailable". This is consulted only when NO adapter is registered; the
// hybrid worker registers the real pdfjs-text adapter (see engines/).
//
// The names are assembled at runtime (never a string literal) on purpose: a
// bundler must NOT statically resolve these optional, unbundled engines into the
// build graph (that fails when they are absent, which is the honest default).
// Reaching them through a computed key keeps the probe purely dynamic.
const ENGINE_PACKAGE_PARTS: Record<string, string[]> = {
  'pdfjs-text': ['pdfjs-dist', '/', 'legacy', '/', 'build', '/', 'pdf', '.mjs'],
  tesseract: ['tesseract', '.', 'js'],
  pdftotext: ['pdftotext', '-', 'npm', '-', 'wrapper'],
}

function probeEngineModule(id: string): unknown | null {
  const parts = ENGINE_PACKAGE_PARTS[id]
  if (!parts) return null
  const moduleName = parts.join('')
  try {
    const req = createRequire(import.meta.url)
    // resolve() proves presence without loading/executing an ESM module.
    return req.resolve(moduleName)
  } catch {
    return null
  }
}

/**
 * The single entry point the extraction handler uses. It NEVER fabricates:
 *   * registered adapter present -> run it (errors become a miss, not a guess);
 *   * configured engine but no code adapter wired -> miss (operator must wire it);
 *   * engine 'none' / not installed -> miss.
 * A miss carries a stable reason the caller turns into a needs_review cause.
 */
export async function tryLocalExtract(args: LocalExtractArgs): Promise<LocalExtractResult> {
  if (registered) {
    try {
      const candidate = await registered.extract(args)
      if (!candidate) return { ok: false, reason: 'no-candidate', detail: `${registered.id} produced no candidate` }
      return { ok: true, engine: registered.id, candidate }
    } catch (e) {
      return { ok: false, reason: 'engine-error', detail: brief(e) }
    }
  }
  const id = configuredEngineId()
  if (id === 'none') return { ok: false, reason: 'no-engine', detail: 'LOCAL_OCR_ENGINE=none' }
  if (probeEngineModule(id) === null) {
    return { ok: false, reason: 'engine-unavailable', detail: `LOCAL_OCR_ENGINE=${id} is not installed` }
  }
  // The package exists but no in-code adapter maps its output to a candidate.
  // Do not guess: report that an operator adapter is required.
  return { ok: false, reason: 'engine-unavailable', detail: `LOCAL_OCR_ENGINE=${id} needs registerLocalEngine() wiring` }
}

function brief(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.slice(0, 160)
}
