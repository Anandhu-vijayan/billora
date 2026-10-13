import { getPublicEnvInfo } from '@/lib/env';
import { hasFileKeyConfig } from '@/lib/encryption/files';

export const dynamic = 'force-dynamic';

// Liveness + safe configuration posture. getPublicEnvInfo()/hasFileKeyConfig()
// return BOOLEANS and the public URL host only — never key material, tokens,
// or values — so an operator can confirm required configuration is present
// without exposing any secret. Fail-closed intake means a false here predicts
// rejected uploads, which is exactly what this diagnostic is meant to surface.
export function GET() {
  const fileKeys = hasFileKeyConfig();
  return Response.json(
    {
      status: 'ok',
      service: 'billora',
      config: {
        ...getPublicEnvInfo(),
        fileEncryptionMasterKey: fileKeys.masterKeyPresent,
        fileEncryptionPathKey: fileKeys.pathKeyPresent,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
