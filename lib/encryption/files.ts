// lib/encryption/files.ts — envelope encryption for original invoice files.
//
// Design (approved Stage 1):
//   * One fresh random 256-bit DEK per file. The file bytes are encrypted with
//     AES-256-GCM under the DEK; the DEK is then wrapped with AES-256-GCM under
//     the master key (ENCRYPTION_MASTER_KEY). Ciphertext AND metadata are
//     authenticated (the key version + object context are bound as AAD), so a
//     byte of tampering or a swapped path fails closed.
//   * The container is versioned and self-describing so rotation is detectable
//     and decrypt needs no out-of-band IV/tag.
//   * Object paths are a deterministic HMAC under a DEDICATED path key
//     (STORAGE_PATH_KEY), so webhook redelivery resolves to the same object and
//     the invoices.file_object_path unique constraint keeps intake idempotent.
//   * NEVER a plaintext fallback: a missing/misconfigured key is a hard error.
//
// All operations are server-side only. This module reads no DB and stores no
// plaintext to disk; callers pass buffers and keep everything in memory.
import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual,
} from 'node:crypto'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const DEK_LEN = 32
const KEY_VER_LEN = 8
const HEX_64 = /^[0-9a-fA-F]{64}$/

// Container header (all big-endian, fixed layout):
//   [0]      MAGIC 0xBF
//   [1]      SCHEMA_VER
//   [2..10]  KEY_VER (8 bytes, derived from the master key)
//   [10..22] DEK-wrap IV
//   [22..38] DEK-wrap auth tag
//   [38..70] wrapped DEK (32 bytes; GCM ciphertext == plaintext length)
//   [70..82] content IV
//   [82..98] content auth tag
//   [98..n]  content ciphertext
const MAGIC = 0xbf
const SCHEMA_VER = 0x01
const OFF_SCHEMA = 1
const OFF_KEYVER = 2
const OFF_IVK = 10
const OFF_TAGK = 22
const OFF_WDEK = 38
const OFF_IVC = 70
const OFF_TAGC = 82
const OFF_CT = 98

/** A configured key is missing or malformed (wrong length/charset). */
export class EncryptionConfigError extends Error {
  override name = 'EncryptionConfigError'
}

/** A stored container is corrupt, tampered, or not decryptable with this key. */
export class MediaDecryptFailed extends Error {
  override name = 'MediaDecryptFailed'
}

/** Decrypt failure that a retry can never fix (auth/tag/format), for job classification. */
export function isMediaDecryptFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'MediaDecryptFailed'
}

/**
 * A missing/malformed key is an operator-configuration error, not a transient
 * fault: no retry can succeed until the environment is fixed and the server
 * restarts. Callers use this to keep such a failure OUT of a webhook retry loop
 * (which would also re-download the same media for nothing).
 */
export function isEncryptionConfigFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'EncryptionConfigError'
}

/**
 * Non-throwing readiness probe for the file-encryption keys, for health /
 * startup diagnostics. Reports presence + well-formedness only; it never
 * returns or logs key material.
 */
export function hasFileKeyConfig(): { masterKeyPresent: boolean; pathKeyPresent: boolean } {
  return {
    masterKeyPresent: HEX_64.test(process.env.ENCRYPTION_MASTER_KEY ?? ''),
    pathKeyPresent: HEX_64.test(process.env.STORAGE_PATH_KEY ?? ''),
  }
}

function requireKey(hex: string | undefined, label: string): Buffer {
  if (!hex || !HEX_64.test(hex)) {
    throw new EncryptionConfigError(
      `${label} must be a 32-byte hex string (64 hex chars). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    )
  }
  return Buffer.from(hex, 'hex')
}

/** Stable 8-byte key fingerprint derived from the master key (rotation detection). */
export function deriveKeyVersion(masterKeyHex: string): string {
  const key = requireKey(masterKeyHex, 'ENCRYPTION_MASTER_KEY')
  return createHmac('sha256', key).update('billora-file-keyver').digest().subarray(0, KEY_VER_LEN)
    .toString('hex')
}

function keyVersionBytes(masterKeyHex: string): Buffer {
  const key = Buffer.from(masterKeyHex, 'hex')
  return createHmac('sha256', key).update('billora-file-keyver').digest().subarray(0, KEY_VER_LEN)
}

// Domain-separated AAD binds schema version + key version + object context, so
// both the DEK wrap and the content are authenticated against the intended path.
function baseAad(keyVerBytes: Buffer, context: string): Buffer {
  return Buffer.concat([
    Buffer.from([SCHEMA_VER]),
    keyVerBytes,
    Buffer.from(context, 'utf8'),
  ])
}

export interface EncryptedFile {
  /** Self-describing ciphertext container ready for object storage upload. */
  container: Buffer
  /** 8-byte hex key fingerprint; store on the invoice for rotation auditing. */
  keyVersion: string
  /** Plaintext byte length (accounting; the SHA-256 stays over plaintext). */
  sizeBytes: number
}

/**
 * Envelope-encrypt a file. `context` must be the same value at decrypt time
 * (we use the deterministic object path), binding the container to its slot.
 */
export function encryptFile(
  plain: Buffer, masterKeyHex: string, args: { context: string },
): EncryptedFile {
  const masterKey = requireKey(masterKeyHex, 'ENCRYPTION_MASTER_KEY')
  if (!plain || plain.length === 0) throw new EncryptionConfigError('encryptFile: empty plaintext')
  const keyVer = keyVersionBytes(masterKeyHex)
  const aad = baseAad(keyVer, args.context)

  const dek = randomBytes(DEK_LEN)

  // Wrap the DEK under the master key.
  const ivK = randomBytes(IV_LEN)
  const wrapCipher = createCipheriv(ALG, masterKey, ivK)
  wrapCipher.setAAD(Buffer.concat([aad, Buffer.from('WRAP', 'utf8')]))
  const wrappedDEK = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()])
  const tagK = wrapCipher.getAuthTag()

  // Encrypt the file bytes under the DEK.
  const ivC = randomBytes(IV_LEN)
  const contentCipher = createCipheriv(ALG, dek, ivC)
  contentCipher.setAAD(Buffer.concat([aad, Buffer.from('DATA', 'utf8')]))
  const ciphertext = Buffer.concat([contentCipher.update(plain), contentCipher.final()])
  const tagC = contentCipher.getAuthTag()

  // Zero the DEK from this buffer reference best-effort (Node buffers aren't
  // guaranteed zeroable, but we avoid holding the key longer than this scope).
  dek.fill(0)

  const header = Buffer.alloc(OFF_CT)
  header[0] = MAGIC
  header[OFF_SCHEMA] = SCHEMA_VER
  keyVer.copy(header, OFF_KEYVER)
  ivK.copy(header, OFF_IVK)
  tagK.copy(header, OFF_TAGK)
  wrappedDEK.copy(header, OFF_WDEK)
  ivC.copy(header, OFF_IVC)
  tagC.copy(header, OFF_TAGC)

  const container = Buffer.concat([header, ciphertext])
  return { container, keyVersion: keyVer.toString('hex'), sizeBytes: plain.length }
}

/**
 * Decrypt a container produced by `encryptFile`. Any structural or
 * authentication failure throws MediaDecryptFailed — never returns plaintext
 * for a tampered/unauthentic object, and never falls back to returning input.
 */
export function decryptFile(
  container: Buffer, masterKeyHex: string, args: { context: string; expectedKeyVersion?: string },
): Buffer {
  const masterKey = requireKey(masterKeyHex, 'ENCRYPTION_MASTER_KEY')
  if (!Buffer.isBuffer(container) || container.length < OFF_CT) {
    throw new MediaDecryptFailed('container truncated or not a buffer')
  }
  if (container[0] !== MAGIC) throw new MediaDecryptFailed('bad magic')
  if (container[OFF_SCHEMA] !== SCHEMA_VER) {
    throw new MediaDecryptFailed(`unsupported schema version ${container[OFF_SCHEMA]}`)
  }
  const keyVer = container.subarray(OFF_KEYVER, OFF_KEYVER + KEY_VER_LEN)
  if (args.expectedKeyVersion && keyVer.toString('hex') !== args.expectedKeyVersion) {
    // Reject on version mismatch BEFORE attempting decrypt; fail closed.
    throw new MediaDecryptFailed('key-version-mismatch')
  }
  const aad = baseAad(keyVer, args.context)

  const ivK = container.subarray(OFF_IVK, OFF_IVK + IV_LEN)
  const tagK = container.subarray(OFF_TAGK, OFF_TAGK + TAG_LEN)
  const wrappedDEK = container.subarray(OFF_WDEK, OFF_WDEK + DEK_LEN)
  const ivC = container.subarray(OFF_IVC, OFF_IVC + IV_LEN)
  const tagC = container.subarray(OFF_TAGC, OFF_TAGC + TAG_LEN)
  const ciphertext = container.subarray(OFF_CT)

  let dek: Buffer
  try {
    const unwrap = createDecipheriv(ALG, masterKey, ivK)
    unwrap.setAAD(Buffer.concat([aad, Buffer.from('WRAP', 'utf8')]))
    unwrap.setAuthTag(tagK)
    dek = Buffer.concat([unwrap.update(wrappedDEK), unwrap.final()])
  } catch {
    throw new MediaDecryptFailed('dek-unwrap-failed')
  }

  try {
    const content = createDecipheriv(ALG, dek, ivC)
    content.setAAD(Buffer.concat([aad, Buffer.from('DATA', 'utf8')]))
    content.setAuthTag(tagC)
    const plain = Buffer.concat([content.update(ciphertext), content.final()])
    dek.fill(0)
    return plain
  } catch {
    dek.fill(0)
    throw new MediaDecryptFailed('content-auth-failed')
  }
}

/** Deterministic, non-guessable object path for a provider media id under a scope. */
export function deriveObjectKey(
  scope: 'invoices' | 'pending', mediaId: string, pathKeyHex: string,
): string {
  requireKey(pathKeyHex, 'STORAGE_PATH_KEY')
  if (!mediaId) throw new EncryptionConfigError('deriveObjectKey: empty media id')
  const h = createHmac('sha256', pathKeyHex).update(`${scope}:${mediaId}`).digest('hex')
  return `whatsapp/${scope}/${h}.bin`
}

/**
 * Deterministic, non-guessable object path for a generated workbook, keyed by
 * batch id under the same dedicated path key. Re-running a batch regenerates
 * the same `.xlsx` slot (upsert) instead of accumulating duplicates, while an
 * unrelated batch can never collide.
 *
 * §separate-files-per-category: an optional category token widens the HMAC seed
 * so a batch's multiple per-category registers occupy DISTINCT object slots and
 * never overwrite one another. With no token the seed is the historical
 * `exports:<batch>` string, so the purchase register (and every pre-split object)
 * keeps its EXACT prior key — full backward compatibility.
 */
export function deriveWorkbookKey(batchId: string, pathKeyHex: string, categoryToken?: string | null): string {
  requireKey(pathKeyHex, 'STORAGE_PATH_KEY')
  if (!batchId) throw new EncryptionConfigError('deriveWorkbookKey: empty batch id')
  const seed = categoryToken ? `exports:${batchId}:${categoryToken}` : `exports:${batchId}`
  const h = createHmac('sha256', pathKeyHex).update(seed).digest('hex')
  return `whatsapp/exports/${h}.xlsx`
}

/** Constant-time compare for hex key versions (used by the legacy migrator). */
export function keyVersionMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Read + validate the file-encryption key configuration from the environment.
 * Fail-closed: any malformed/missing key throws EncryptionConfigError so intake
 * never stores plaintext by accident.
 */
export function resolveFileKeyConfig(): { masterKeyHex: string; pathKeyHex: string } {
  const masterKeyHex = process.env.ENCRYPTION_MASTER_KEY ?? ''
  const pathKeyHex = process.env.STORAGE_PATH_KEY ?? ''
  if (!HEX_64.test(masterKeyHex)) {
    throw new EncryptionConfigError('ENCRYPTION_MASTER_KEY is missing or not a 64-hex-char key')
  }
  if (!HEX_64.test(pathKeyHex)) {
    throw new EncryptionConfigError('STORAGE_PATH_KEY is missing or not a 64-hex-char key')
  }
  return { masterKeyHex, pathKeyHex }
}
