import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../scripts/_ts-import.mjs'

const { reconstructPdfText } = await importTs('lib/ocr/pdf-text-layout.ts')

const item = (str, x, y, width, size = 10) => ({
  str, width, height: size,
  transform: [size, 0, 0, size, x, y],
})

test('PDF text runs on the same visual line are reconstructed with spaces', () => {
  const text = reconstructPdfText([
    item('Sunrise Agro', 40, 780, 57),
    item('Products', 101, 780, 39),
    item('TAX INVOICE', 40, 800, 65),
    item('Bill To:', 40, 750, 30),
    item('Anandhu Enterprises', 75, 750, 91),
    item('Invoice No:', 40, 720, 48),
    item('INV-2026-11-001', 92, 720, 82),
  ])
  assert.equal(text, [
    'TAX INVOICE',
    'Sunrise Agro Products',
    'Bill To: Anandhu Enterprises',
    'Invoice No: INV-2026-11-001',
  ].join('\n'))
})

test('PDF text extraction falls back to original item order when geometry is incomplete', () => {
  const text = reconstructPdfText([
    { str: 'Sunrise Agro' },
    { str: 'Products' },
    { str: 'Invoice No: INV-1' },
  ])
  assert.equal(text, 'Sunrise Agro\nProducts\nInvoice No: INV-1')
})

test('empty PDF text items remain empty', () => {
  assert.equal(reconstructPdfText([{ str: ' ' }, { str: '' }]), '')
})
