"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "sign-up"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Something went wrong");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-[380px] p-7 flex flex-col gap-4" style={{ animation: "rise .25s ease" }}>
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-8 h-8 rounded-[9px] bg-acc grid place-items-center text-white font-extrabold text-[15px]">₹</div>
          <div className="font-extrabold text-[17px] tracking-tight">Ledgerly</div>
        </div>
        <div>
          <div className="text-[19px] font-extrabold tracking-tight">{mode === "sign-up" ? "Create your account" : "Welcome back"}</div>
          <div className="text-[12.5px] text-mut mt-1">
            {mode === "sign-up" ? "Every rupee, visible in one place." : "Sign in to your ledger."}
          </div>
        </div>
        {mode === "sign-up" && (
          <div>
            <div className="label-caps">NAME</div>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Arjun" required autoFocus />
          </div>
        )}
        <div>
          <div className="label-caps">EMAIL</div>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus={mode === "sign-in"} />
        </div>
        <div>
          <div className="label-caps">PASSWORD</div>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
        </div>
        {error && <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>}
        <button type="submit" disabled={busy} className="btn-primary py-3 text-[13.5px] font-bold disabled:opacity-60">
          {busy ? "…" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
        <div className="text-[12.5px] text-mut text-center">
          {mode === "sign-up" ? (
            <>Already have an account? <a href="/sign-in">Sign in</a></>
          ) : (
            <>New here? <a href="/sign-up">Create an account</a></>
          )}
        </div>
      </form>
    </div>
  );
}
