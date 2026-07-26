"use client";

// Root-level fallback: errors outside the signed-in shell (the auth pages, the
// invite route) and anything thrown by the (app) layout itself, which its own
// error.tsx cannot catch. No navigation exists around these, so this one stands
// on its own and offers the way back explicitly.

import { useEffect } from "react";
import { ErrorState } from "@/components/shell/error-state";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[error-boundary] root", error);
  }, [error]);

  return (
    <ErrorState
      standalone
      icon="⚠️"
      title="Something went wrong"
      detail="We hit an unexpected problem loading this page. Your data is safe — nothing was changed by this error."
      reference={error.digest}
      actions={[
        { label: "Try again", onClick: reset, primary: true },
        { label: "Go to Dashboard", href: "/dashboard" },
      ]}
    />
  );
}
