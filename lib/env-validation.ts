export function isUsableGeminiApiKey(value: string | undefined): boolean {
  const key = value?.trim() ?? ''
  return key.length >= 20
    && !/^(your|replace|insert|change|placeholder|example|todo)([_ -]|$)/i.test(key)
}