"use client";

// Errors thrown by a signed-in page. Placed inside the (app) group on purpose:
// Next renders it in place of the page content only, so the sidebar, bottom nav
// and top bar stay put — the app doesn't collapse to a blank screen because one
// route failed, and every other section is still one click away.

import { useEffect } from "react";
import { ErrorState } from "@/components/shell/error-state";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Same console convention the server actions and cron use. In production the
    // server-side detail is already in the platform logs under `digest`; this
    // catches the client-side case, where nothing else would record it.
    console.error("[error-boundary] page failed", error);
  }, [error]);

  return (
    <ErrorState
      icon="⚠️"
      title="This page didn't load"
      detail="Something went wrong on our side. Your data is safe — nothing was changed by this error. Try again, or head back to your dashboard."
      reference={error.digest}
      actions={[
        { label: "Try again", onClick: reset, primary: true },
        { label: "Go to Dashboard", href: "/dashboard" },
      ]}
    />
  );
}
