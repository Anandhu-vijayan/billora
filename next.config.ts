import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // The OCR pipeline loads heavy / native server modules at runtime: pdf.js
  // (large, dynamic worker + font assets) and a native canvas binding for PDF
  // rasterization, plus sharp (native libvips) and tesseract.js (WASM + worker +
  // traineddata) for image OCR. Keep all four out of the server bundle graph and
  // require them at runtime instead, so a deploy without them fails closed rather
  // than breaking the build.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "sharp", "tesseract.js"],
  async headers() {
    const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host
      : "*.supabase.co";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `connect-src 'self' https://${supabaseHost} wss://${supabaseHost}`,
      "img-src 'self' data: blob:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "upgrade-insecure-requests",
    ].join("; ");

    const headers = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
      { key: "Origin-Agent-Cluster", value: "?1" },
      ...(process.env.NODE_ENV === "production"
        ? [
            {
              key: "Strict-Transport-Security",
              value: "max-age=31536000; includeSubDomains",
            },
            { key: "Content-Security-Policy", value: csp },
          ]
        : []),
    ];

    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;

