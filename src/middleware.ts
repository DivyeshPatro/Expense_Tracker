import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRateLimit, type RateLimitBucket } from "./server/rate-limit";

// Rate-limited by path — brute-force/credential-stuffing on sign-in,
// spam account creation, and email-bombing via password-reset requests are
// the abuse patterns that actually matter here. Keyed by IP: good enough at
// this app's scale, and avoids reading/re-streaming the request body in
// middleware just to key by email too.
const RATE_LIMITED_PATHS: { path: string; bucket: RateLimitBucket }[] = [
  { path: "/api/auth/sign-in/email", bucket: "auth" },
  { path: "/api/auth/sign-up/email", bucket: "auth" },
  { path: "/api/auth/request-password-reset", bucket: "sensitive" },
];

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

// Security headers, applied to every response. CSP uses a per-request nonce
// (Next's documented pattern: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)
// so script-src can stay nonce-only instead of 'unsafe-inline' — Next reads
// the nonce off the CSP response header itself for its own inline
// hydration/streaming scripts, no extra plumbing needed. style-src keeps
// 'unsafe-inline' because CSP nonces only cover <style> elements, not
// inline style="" attributes (which this app uses for chart bars, dynamic
// colors, etc.) — blocking those has much lower XSS value than blocking
// inline scripts, so it's not worth the churn.
export async function middleware(request: NextRequest) {
  if (request.method === "POST") {
    const hit = RATE_LIMITED_PATHS.find((p) => request.nextUrl.pathname === p.path);
    if (hit) {
      const { allowed, retryAfterSeconds } = await checkRateLimit(hit.bucket, clientIp(request));
      if (!allowed) {
        return NextResponse.json(
          { error: "Too many attempts — try again shortly." },
          { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
        );
      }
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // dev-only: Next's Fast Refresh/HMR runs webpack's eval-based source maps,
  // which CSP's script-src otherwise blocks outright — production builds
  // don't eval() anything, so this never loosens the deployed policy.
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next's App Router reads the nonce for its own inline hydration/streaming
  // scripts off the CSP header on the *incoming request* it sees internally,
  // not just the outgoing response — both must carry it (documented pattern).
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Browsers ignore this header entirely when served over plain HTTP, so it's
  // safe to always send — only takes effect once the app is actually on HTTPS.
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [
    // Skip static assets and Next's own image optimizer — headers on those
    // don't matter and this avoids the nonce/CSP work on every asset request.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
