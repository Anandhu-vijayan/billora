// scripts/reencrypt-legacy.mjs — operator-run recovery for plaintext objects
// that predate Stage-1 envelope encryption.
//
// What it does, per legacy object (path NOT ending in `.bin`, i.e. not already
// an encrypted container):
//   1. download the plaintext bytes,
//   2. envelope-encrypt with the SAME files.ts the live intake uses, using the
//      derived new path as the authenticated context,
//   3. VERIFY by decrypting the container back and comparing byte-for-byte,
//   4. upload the container to the deterministic new path,
//   5. point every referencing row (invoices.file_object_path and/or
//      pending_uploads.object_path) at the new path + key version — in one PATCH
//      per row, only after the ciphertext is stored and verified.
//
// Safety rails (approved Stage 1e):
//   * DRY-RUN is the DEFAULT. Nothing is written unless APPLY=1.
//   * Re-running is safe + resumable: migrated rows end in `.bin` and are then
//     skipped, so an interrupted pass can be resumed.
//   * Old-object deletion is a SEPARATE, explicitly-authorized step (DELETE=1)
//     and runs ONLY after a verified ciphertext exists at the new path AND no
//     remaining row still references the old path. It never deletes first.
//
// Usage (env from the shell, or --env-file, or a local .env / .env.local):
//   node scripts/reencrypt-legacy.mjs                 # dry-run: report only
//   APPLY=1 node scripts/reencrypt-legacy.mjs         # encrypt + repoint rows
//   APPLY=1 DELETE=1 node scripts/reencrypt-legacy.mjs # + remove verified old objects
//   LIMIT=20 APPLY=1 node scripts/reencrypt-legacy.mjs # bound a pass
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import { importTs } from './_ts-import.mjs'

// ---- config (env wins; fall back to a local .env / .env.local) -------------
function loadFileEnv() {
  for (const name of ['.env.local', '.env']) {
    const p = resolve(process.cwd(), name)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      const key = m[1]
      let val = m[2]
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val
    }
  }
}
loadFileEnv()

const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')
const SECRET = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const BUCKET = process.env.SUPABASE_INVOICES_BUCKET || 'billora-invoices'
const APPLY = process.env.APPLY === '1'
const DO_DELETE = process.env.DELETE === '1' && APPLY // delete only ever with writes applied
const LIMIT = Number.parseInt(process.env.LIMIT ?? '0', 10) // 0 = no cap

function die(msg) {
  console.error(`reencrypt-legacy: ${msg}`)
  process.exit(1)
}
if (!URL_BASE || !SECRET) die('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required')
const { encryptFile, decryptFile, deriveObjectKey, resolveFileKeyConfig, deriveKeyVersion } =
  await importTs('lib/encryption/files.ts')
// Fail closed: refuse to run if the live key config is not exactly what intake uses.
const { masterKeyHex, pathKeyHex } = resolveFileKeyConfig()

const H = { apikey: SECRET, Authorization: `Bearer ${SECRET}` }

async function rest(pathname, init) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathname}`, {
    ...init, headers: { ...H, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`REST ${res.status} ${pathname}: ${await res.text().catch(() => '')}`)
  return res.status === 204 ? null : res.json()
}
async function storageGet(objectPath) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${objectPath}`, {
    headers: { ...H, accept: 'application/octet-stream' },
  })
  if (res.status === 400) { const b = await res.json().catch(() => null); if (b?.statusCode === '404') return null }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`download ${res.status}: ${await res.text().catch(() => '')}`)
  return Buffer.from(await res.arrayBuffer())
}
async function storageHead(objectPath) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/info/${BUCKET}/${objectPath}`, { headers: H })
  return res.ok
}
async function storagePut(objectPath, container) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/octet-stream', 'x-upsert': 'true' },
    body: container,
  })
  if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text().catch(() => '')}`)
}
async function storageDelete(objectPath) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'DELETE', headers: H,
  })
  if (!res.ok && res.status !== 404) throw new Error(`delete ${res.status}: ${await res.text().catch(() => '')}`)
}

/** Parse {scope, mediaId} from a legacy plaintext path. Returns null if already .bin. */
function parseLegacy(objectPath) {
  if (!objectPath || objectPath.endsWith('.bin')) return null
  const m = /^whatsapp\/(invoices|pending)\/(.+?)(?:\.[A-Za-z0-9]+)?$/.exec(objectPath)
  if (!m || !m[2]) return null
  return { scope: m[1], mediaId: m[2] }
}

async function main() {
  console.log(`reencrypt-legacy [${APPLY ? 'APPLY' : 'DRY-RUN'}${DO_DELETE ? ' + DELETE' : ''}] bucket=${BUCKET}`)
  console.log(`key version = ${deriveKeyVersion(masterKeyHex)}; STORAGE_PATH_KEY configured`)

  // Gather candidate rows from both tables, then group by old path so a shared
  // object is encrypted + uploaded once and every reference is repointed.
  const invoices = await rest('invoices?select=id,file_object_path&file_object_path=not.is.null')
  const pendings = await rest('pending_uploads?select=id,object_path&object_path=not.is.null')

  /** @type {Map<string, {newPath:string, scope:string, mediaId:string, refs:Array<{table:string, id:string, col:string}>}>} */
  const groups = new Map()
  const addRef = (row, table, pathCol) => {
    const parsed = parseLegacy(row[pathCol])
    if (!parsed) return
    const oldPath = row[pathCol]
    const newPath = deriveObjectKey(parsed.scope === 'pending' ? 'pending' : 'invoices', parsed.mediaId, pathKeyHex)
    let g = groups.get(oldPath)
    if (!g) { g = { newPath, scope: parsed.scope, mediaId: parsed.mediaId, refs: [] }; groups.set(oldPath, g) }
    g.refs.push({ table, id: row.id, col: pathCol })
  }
  for (const r of (invoices ?? [])) addRef(r, 'invoices', 'file_object_path')
  for (const r of (pendings ?? [])) addRef(r, 'pending_uploads', 'object_path')

  let targets = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (LIMIT > 0) targets = targets.slice(0, LIMIT)

  let wouldMigrate = 0, migrated = 0, alreadyCiphertext = 0, missing = 0, failed = 0, deleted = 0
  const keyVersion = deriveKeyVersion(masterKeyHex)

  for (const [oldPath, g] of targets) {
    const plain = await storageGet(oldPath)
    if (plain === null) {
      missing++; console.warn(`  MISSING   ${oldPath} (object gone; leaving row(s) as-is)`)
      continue
    }
    if (plain.length > 0 && plain[0] === 0xbf && await storageHead(g.newPath)) {
      // Already a container at the old path AND a ciphertext exists: nothing to do.
      alreadyCiphertext++
      continue
    }

    // Encrypt + verify BEFORE any write. A failure here aborts the row.
    let container
    try {
      const enc = encryptFile(plain, masterKeyHex, { context: g.newPath })
      const back = decryptFile(enc.container, masterKeyHex, { context: g.newPath })
      if (Buffer.compare(back, plain) !== 0) throw new Error('round-trip mismatch')
      container = enc.container
    } catch (e) {
      failed++; console.error(`  VERIFY-FAIL ${oldPath}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    wouldMigrate++
    if (!APPLY) {
      console.log(`  PLAN      ${oldPath} -> ${g.newPath} (${plain.length}B -> ${container.length}B, ${g.refs.length} row ref(s))`)
      continue
    }

    try {
      await storagePut(g.newPath, container)
      const verified = await storageHead(g.newPath)
      if (!verified) throw new Error('new object not present after upload')
      for (const ref of g.refs) {
        const body = ref.table === 'invoices'
          ? { file_object_path: g.newPath, file_encryption_key_version: keyVersion, size_bytes: plain.length }
          : { object_path: g.newPath, file_encryption_key_version: keyVersion }
        await rest(`${ref.table}?id=eq.${ref.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      }
      migrated++
      console.log(`  MIGRATED  ${oldPath} -> ${g.newPath} (${g.refs.length} row(s) repointed)`)

      // Delete the old plaintext ONLY when authorized, the ciphertext is
      // verified, and no remaining row still references the old path.
      if (DO_DELETE) {
        const stillInv = await rest(`invoices?select=id&file_object_path=eq.${encodeURIComponent(oldPath)}`)
        const stillPend = await rest(`pending_uploads?select=id&object_path=eq.${encodeURIComponent(oldPath)}`)
        if ((stillInv?.length ?? 0) === 0 && (stillPend?.length ?? 0) === 0) {
          await storageDelete(oldPath)
          deleted++
          console.log(`  DELETED   ${oldPath}`)
        } else {
          console.warn(`  KEEP      ${oldPath} (still referenced; not deleted)`)
        }
      }
    } catch (e) {
      failed++; console.error(`  APPLY-FAIL ${oldPath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  console.log('\nsummary:')
  console.log(`  legacy groups scanned : ${groups.size}`)
  console.log(`  ${APPLY ? 'migrated' : 'would migrate'} : ${migrated || wouldMigrate}`)
  console.log(`  already ciphertext    : ${alreadyCiphertext}`)
  console.log(`  missing objects       : ${missing}`)
  console.log(`  failed                : ${failed}`)
  if (DO_DELETE) console.log(`  old objects deleted   : ${deleted}`)
  if (!APPLY) console.log('\nDRY-RUN: nothing written. Re-run with APPLY=1 to migrate'
    + (DO_DELETE || process.env.DELETE === '1' ? ' (DELETE is ignored without APPLY)' : '.'))
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)))
