// Scan the complete Git working tree (tracked + non-ignored untracked files).
// CI checks the committed tree; local runs also catch newly-added files before commit.
// Never print matched secret values.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  encoding: 'buffer',
}).toString().split('\0').filter(Boolean)

const patterns = [
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['AWS access key ID', /AKIA[0-9A-Z]{16}/],
  ['GitHub personal access token', /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe secret key', /sk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['Meta access token', /EA[A-Za-z0-9]{80,}/],
  ['Private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
]

const offenders = []
let scanned = 0
for (const file of files) {
  if (file === '.git' || file.startsWith('.git/')) continue
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    continue // deleted between git listing and read
  }
  if (buffer.includes(0)) continue // binary file
  const source = buffer.toString('utf8')
  scanned += 1
  for (const [label, pattern] of patterns) {
    if (pattern.test(source)) offenders.push({ file, label })
  }

  // Detect a Supabase service-role JWT without flagging public anon keys or
  // ordinary test JWTs. Decode only the payload; never print token contents.
  const jwtPattern = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
  for (const match of source.matchAll(jwtPattern)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'))
      if (payload.role === 'service_role') offenders.push({ file, label: 'Supabase service-role JWT' })
    } catch {
      // Not a decodable JWT; other secret patterns still apply.
    }
  }
}

if (offenders.length) {
  console.error(`secret-scan: FAILED — found ${offenders.length} possible secret(s):`)
  for (const item of offenders) console.error(`  ${item.file}: ${item.label}`)
  console.error('Remove exposed credentials, rotate them if they were real, and retry.')
  process.exit(1)
}
console.log(`secret-scan: OK (${scanned} text files scanned; values are never printed)`)
