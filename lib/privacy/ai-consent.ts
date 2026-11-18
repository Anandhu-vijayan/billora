export const GEMINI_WORKSPACE_CONSENT_VERSION = 'billora-gemini-v1'

export const GEMINI_WORKSPACE_CONSENT_NOTICE = [
  'If enabled, invoice files and related document content from this workspace may be sent to Google Gemini to extract invoice fields.',
  'Local extraction remains available when this permission is off. Enabling this setting does not replace Billora’s privacy notice or the applicable Google processing terms.',
  'An authorised workspace owner or administrator can withdraw permission at any time. Withdrawal prevents future Gemini processing; it cannot reverse processing already performed.',
].join(' ')
