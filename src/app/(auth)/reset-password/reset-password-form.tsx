"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { BrandMark } from "@/components/shell/brand-mark";

export function ResetPasswordForm({ token, invalid }: { token?: string; invalid: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const res = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Something went wrong");
      return;
    }
    router.push("/sign-in?reset=1");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-[380px] p-7 flex flex-col gap-4" style={{ animation: "rise .25s ease" }}>
        <div className="flex items-center gap-2.5 mb-1">
          <BrandMark size={32} />
          <div className="font-extrabold text-[17px] tracking-tight">Ledgerly</div>
        </div>
        {invalid || !token ? (
          <>
            <div className="text-[19px] font-extrabold tracking-tight">Link expired</div>
            <div className="text-[12.5px] text-mut">
              This reset link is invalid or has expired. <a href="/forgot-password">Request a new one</a>.
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <div className="text-[19px] font-extrabold tracking-tight">Set a new password</div>
            </div>
            <div>
              <div className="label-caps">NEW PASSWORD</div>
              <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={8} autoFocus />
            </div>
            {error && <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>}
            <button type="submit" disabled={busy} className="btn-primary py-3 text-[13.5px] font-bold disabled:opacity-60">
              {busy ? "…" : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
