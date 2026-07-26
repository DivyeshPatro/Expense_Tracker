"use client";

// Last resort: the root layout itself failed, so Next replaces the whole
// document — this file has to supply <html> and <body> of its own.
//
// Deliberately self-contained rather than reusing ErrorState. At this point the
// root layout never ran, so there is no guarantee of a router context, the theme
// cookie, or the font variable; anything that leans on them could fail inside
// the error page and leave the user with a blank screen. Plain anchors and a
// direct stylesheet import always work. globals.css is imported here because the
// layout that normally pulls it in is exactly what's missing.

import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[error-boundary] global", error);
  }, [error]);

  return (
    // No data-theme: the cookie read lives in the root layout, so this falls back
    // to the light palette rather than guessing wrong.
    <html lang="en">
      <body>
        <div className="min-h-screen flex items-center justify-center p-5" style={{ background: "var(--bg)" }}>
          <div className="flex flex-col items-center gap-4 w-full">
            <div className="text-[15px] font-extrabold tracking-tight" style={{ color: "var(--acc)" }}>
              ₹ Ledgerly
            </div>
            <div className="card p-8 max-w-[440px] w-full text-center" role="alert">
              <div className="text-[34px] mb-2" aria-hidden="true">⚠️</div>
              <h1 className="text-[17px] font-extrabold tracking-tight m-0">Ledgerly couldn&apos;t start</h1>
              <p className="text-[13px] text-mut2 mt-2 mb-0 leading-relaxed">
                Something went wrong before the app could load. Your data is safe — nothing was changed by this error.
                Reloading usually fixes it.
              </p>
              <div className="flex gap-2 justify-center flex-wrap mt-5">
                <button onClick={reset} className="btn-primary">Reload</button>
                <a
                  href="/dashboard"
                  className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc no-underline hover:bg-accsoft"
                >
                  Go to Dashboard
                </a>
              </div>
              {error.digest && (
                <div className="text-[11px] text-mut2 mt-4">
                  Reference: <code className="font-mono">{error.digest}</code>
                </div>
              )}
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
