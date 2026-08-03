"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { BrandMark } from "@/components/shell/brand-mark";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Something went wrong");
      return;
    }
    setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-[380px] p-7 flex flex-col gap-4" style={{ animation: "rise .25s ease" }}>
        <div className="flex items-center gap-2.5 mb-1">
          <BrandMark size={32} />
          <div className="font-extrabold text-[17px] tracking-tight">Ledgerly</div>
        </div>
        {sent ? (
          <>
            <div className="text-[19px] font-extrabold tracking-tight">Check your email</div>
            <div className="text-[12.5px] text-mut">
              If an account exists for <strong>{email}</strong>, we&apos;ve sent a link to reset your password. It expires in 1 hour.
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <div className="text-[19px] font-extrabold tracking-tight">Reset your password</div>
              <div className="text-[12.5px] text-mut mt-1">Enter your email and we&apos;ll send you a reset link.</div>
            </div>
            <div>
              <div className="label-caps">EMAIL</div>
              <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus />
            </div>
            {error && <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>}
            <button type="submit" disabled={busy} className="btn-primary py-3 text-[13.5px] font-bold disabled:opacity-60">
              {busy ? "…" : "Send reset link"}
            </button>
          </form>
        )}
        <div className="text-[12.5px] text-mut text-center">
          <a href="/sign-in">Back to sign in</a>
        </div>
      </div>
    </div>
  );
}
