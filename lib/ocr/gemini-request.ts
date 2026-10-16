export interface GeminiInvoiceRequestArgs {
  model: string
  mimeType: string
  imageBase64: string
  prompt: string
  responseSchema: Record<string, unknown>
}

export interface GeminiInvoiceRequest {
  model: string
  contents: Array<{
    role: 'user'
    parts: Array<
      | { inlineData: { mimeType: string; data: string } }
      | { text: string }
    >
  }>
  config: {
    responseMimeType: 'application/json'
    responseSchema: Record<string, unknown>
    // NOTE: no temperature / top_p / top_k. Gemini 3+ models reject legacy
    // sampling parameters; structured JSON extraction is deterministic enough
    // without them.
  }
}

export function buildGeminiInvoiceRequest(args: GeminiInvoiceRequestArgs): GeminiInvoiceRequest {
  return {
    model: args.model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: args.mimeType, data: args.imageBase64 } },
        { text: args.prompt },
      ],
    }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: args.responseSchema,
    },
  }
}
