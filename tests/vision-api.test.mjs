import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GoogleGenAI } from '@google/genai'
import sharp from 'sharp'
import { importTs } from '../scripts/_ts-import.mjs'

const { buildGeminiInvoiceRequest } = await importTs('lib/ocr/gemini-request.ts')

function readDotEnv() {
  try {
    return new Map(readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/, '$2')]))
  } catch {
    return new Map()
  }
}

const localEnv = readDotEnv()
const liveCheckEnabled = process.env.GEMINI_LIVE_TEST === '1'
const liveEnv = liveCheckEnabled ? localEnv : new Map()
const apiKey = process.env.GEMINI_API_KEY || liveEnv.get('GEMINI_API_KEY')
const model = process.env.GEMINI_MODEL || liveEnv.get('GEMINI_MODEL') || 'gemini-flash-lite-latest'

test('Gemini invoice request uses the multimodal JSON wire format', async () => {
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#ffffff' },
  }).png().toBuffer()
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const image = png.toString('base64')
  const schema = {
    type: 'OBJECT',
    properties: { invoice_number: { type: 'STRING' } },
    required: ['invoice_number'],
  }
  const request = buildGeminiInvoiceRequest({
    model: 'gemini-test-model',
    mimeType: 'image/png',
    imageBase64: image,
    prompt: 'Extract the requested field as JSON.',
    responseSchema: schema,
  })

  assert.equal(request.model, 'gemini-test-model')
  assert.deepEqual(request.contents, [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'image/png', data: image } },
      { text: 'Extract the requested field as JSON.' },
    ],
  }])
  assert.deepEqual(request.config, {
    responseMimeType: 'application/json',
    responseSchema: schema,
  })
  assert.ok(Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64').length > 0)
})

test('Gemini live API accepts a synthetic image and structured JSON response', {
  skip: !liveCheckEnabled || !apiKey,
  timeout: 45_000,
}, async () => {
  const image = await sharp({
    create: { width: 48, height: 48, channels: 3, background: '#ffffff' },
  }).png().toBuffer()
  const schema = {
    type: 'OBJECT',
    properties: { ok: { type: 'BOOLEAN' } },
    required: ['ok'],
  }
  const request = buildGeminiInvoiceRequest({
    model,
    mimeType: 'image/png',
    imageBase64: image.toString('base64'),
    prompt: 'This is a synthetic blank test image, not a customer document. Return {"ok":true}.',
    responseSchema: schema,
  })

  let response
  try {
    response = await new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 15_000 },
    }).models.generateContent(request)
  } catch (error) {
    const status = error && typeof error === 'object'
      ? error.status ?? error.statusCode ?? null
      : null
    const failure = status ? `HTTP ${status}` : 'network or timeout'
    assert.fail(`Gemini live API request failed (${failure}); credential and payload values were not logged`)
  }

  let parsed
  try {
    parsed = JSON.parse(response.text ?? '')
  } catch {
    assert.fail('Gemini live API returned a response that was not valid JSON')
  }
  assert.equal(parsed.ok, true)
})
