"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { BrandMark } from "@/components/shell/brand-mark";

export function AuthForm({
  mode,
  justReset,
  signupOpen = true,
}: {
  mode: "sign-in" | "sign-up";
  justReset?: boolean;
  /** When registration is closed, the "Create an account" link is a dead end. */
  signupOpen?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #200: before React hydrates, this form's onSubmit doesn't exist yet, so a
  // fast typist pressing the button gets the browser's DEFAULT behaviour — a
  // native GET submit that reloads the page and silently clears every field,
  // with no error and no clue what happened. Hit three times during testing.
  // The button stays disabled until the effect below runs, which is precisely
  // the moment the React handler becomes real.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

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
          <BrandMark size={32} />
          <div className="font-extrabold text-[17px] tracking-tight">Ledgerly</div>
        </div>
        <div>
          <div className="text-[19px] font-extrabold tracking-tight">{mode === "sign-up" ? "Create your account" : "Welcome back"}</div>
          <div className="text-[12.5px] text-mut mt-1">
            {mode === "sign-up" ? "Every rupee, visible in one place." : "Sign in to your ledger."}
          </div>
        </div>
        {justReset && <div className="text-[12.5px] font-semibold text-green bg-greensoft rounded-lg px-3 py-2">Password reset — sign in with your new password.</div>}
        {mode === "sign-up" && (
          <div>
            <div className="label-caps">NAME</div>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required autoFocus />
          </div>
        )}
        <div>
          <div className="label-caps">EMAIL</div>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus={mode === "sign-in"} />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <div className="label-caps">PASSWORD</div>
            {mode === "sign-in" && (
              <a href="/forgot-password" className="text-[11.5px] font-semibold text-acc inline-flex items-center min-h-[24px]">
                Forgot password?
              </a>
            )}
          </div>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
        </div>
        {error && <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>}
        <button
          type="submit"
          disabled={busy || !hydrated}
          aria-busy={busy || !hydrated}
          className="btn-primary py-3 text-[13.5px] font-bold disabled:opacity-60"
        >
          {busy || !hydrated ? "…" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
        <div className="text-[12.5px] text-mut text-center">
          {mode === "sign-up" ? (
            <>Already have an account? <a href="/sign-in">Sign in</a></>
          ) : signupOpen ? (
            <>New here? <a href="/sign-up">Create an account</a></>
          ) : (
            <>Forgot your password? <a href="/forgot-password">Reset it</a></>
          )}
        </div>
      </form>
    </div>
  );
}
