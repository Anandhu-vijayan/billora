// Fails if anything that looks like a real secret is staged for commit.
// Run in CI before build. Allows obvious placeholders (example, "xxx", "your-...").
import { execSync } from 'node:child_process'

const staged = execSync('git diff --cached --name-only -z', { encoding: 'buffer' })
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter((f) => !f.includes('package-lock.json'))

if (staged.length === 0) {
  console.log('secret-scan: no staged files, OK')
  process.exit(0)
}

const diff = execSync('git diff --cached --unified=0 -- ' + staged.map((f) => `"${f}"`).join(' '), {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
})

const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
const offenders = []
const patterns = [
  /sb_secret_[A-Za-z0-9_\-]{10,}/, // Supabase secret key
  /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}/, // JWT-shaped token
  /sk-(live|test)-[A-Za-z0-9]{10,}/, // Stripe-style keys
  /AKIA[0-9A-Z]{16}/, // AWS access key id
]

for (const line of added) {
  const body = line.slice(1)
  if (/example|placeholder|your-|xxx+|test-key|dummy/i.test(body)) continue
  for (const re of patterns) {
    if (re.test(body)) {
      offenders.push(body.slice(0, 80))
      break
    }
  }
}

if (offenders.length > 0) {
  console.error('secret-scan: FAILED — possible secret in staged diff:')
  for (const o of [...new Set(offenders)]) console.error(`  ${o}…`)
  console.error('Remove the secret, use .env.local, and retry the commit.')
  process.exit(1)
}
console.log(`secret-scan: OK (${staged.length} staged files checked)`)
