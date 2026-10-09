// lib/encryption/index.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ENGINE_ALGORITHM = 'aes-256-gcm';
const CORE_IV_LENGTH = 12;
const VERIFICATION_TAG_LENGTH = 16;

/**
 * Encrypts arbitrary strings locally before database serialization to protect against leakage.
 */
export function encryptExtractedPayload(plainText: string, masterKeyHex: string): Buffer {
  if (!masterKeyHex || masterKeyHex.length !== 64) {
    throw new Error('CRYPTOGRAPHIC_FAULT: Master key parameters must match 32-byte hex formatting.');
  }

  const initializationVector = randomBytes(CORE_IV_LENGTH);
  const cryptoKey = Buffer.from(masterKeyHex, 'hex');
  const cipherInstance = createCipheriv(ENGINE_ALGORITHM, cryptoKey, initializationVector);

  const encryptedContent = Buffer.concat([
    cipherInstance.update(plainText, 'utf8'),
    cipherInstance.final()
  ]);

  const authenticationTag = cipherInstance.getAuthTag();

  // Unified byte payload structural layout: [IV (12B)] + [Auth Tag (16B)] + [Encrypted Content Data]
  return Buffer.concat([initializationVector, authenticationTag, encryptedContent]);
}

/**
 * Decrypts binary payloads locally into structured content.
 */
export function decryptExtractedPayload(encryptedData: Buffer, masterKeyHex: string): string {
  if (!masterKeyHex || masterKeyHex.length !== 64) {
    throw new Error('CRYPTOGRAPHIC_FAULT: Master key parameters must match 32-byte hex formatting.');
  }

  const initializationVector = encryptedData.subarray(0, CORE_IV_LENGTH);
  const authenticationTag = encryptedData.subarray(CORE_IV_LENGTH, CORE_IV_LENGTH + VERIFICATION_TAG_LENGTH);
  const rawCipherBytes = encryptedData.subarray(CORE_IV_LENGTH + VERIFICATION_TAG_LENGTH);

  const cryptoKey = Buffer.from(masterKeyHex, 'hex');
  const decipherInstance = createDecipheriv(ENGINE_ALGORITHM, cryptoKey, initializationVector);
  decipherInstance.setAuthTag(authenticationTag);

  return decipherInstance.update(rawCipherBytes) + decipherInstance.final('utf8');
}
