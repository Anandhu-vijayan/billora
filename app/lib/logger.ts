type Level = 'debug' | 'info' | 'warn' | 'error'

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    // Never log anything that looks like a token/key.
    if (/^(sb_|eyJ|sk-|secret|bearer )/i.test(value.trim())) return '[redacted]'
    if (value.length > 2000) return `${value.slice(0, 2000)}…[truncated]`
    return value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (/key|token|secret|password|auth|cookie|credential/i.test(k)) {
        out[k] = '[redacted]'
      } else {
        out[k] = redact(v)
      }
    }
    return out
  }
  return value
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (level === 'debug' && process.env.NODE_ENV === 'production') return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: 'billora',
    msg,
    ...(fields ? { fields: redact(fields) } : {}),
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
}
