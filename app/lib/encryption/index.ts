import { crypto } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Encrypts arbitrary strings locally before database serialization to protect against leakage.
 */
export function encryptPayload(plainText: string, secretKeyHex: string): Buffer {
  if (!secretKeyHex || secretKeyHex.length !== 64) {
    throw new Error('ENCRYPTION_FAULT: Key parameter must be a validated 32-byte hex string.');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const key = Buffer.from(secretKeyHex, 'hex');
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Payload structure layout: [IV (12B)] + [Auth Tag (16B)] + [Encrypted Data]
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypts binary payloads locally into structured content.
 */
export function decryptPayload(encryptedBuffer: Buffer, secretKeyHex: string): string {
  if (!secretKeyHex || secretKeyHex.length !== 64) {
    throw new Error('DECRYPTION_FAULT: Key parameter must be a validated 32-byte hex string.');
  }

  const iv = encryptedBuffer.subarray(0, IV_LENGTH);
  const authTag = encryptedBuffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encryptedText = encryptedBuffer.subarray(IV_LENGTH + TAG_LENGTH);

  const key = Buffer.from(secretKeyHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encryptedText) + decipher.final('utf8');
}
