"use client";

// Profile: display name, email (read-only — see below), and password change.
//
// Password change goes through better-auth's /change-password, which requires
// the current password. That's deliberately independent of the forgot-password
// flow: that one needs an email to arrive, and email delivery here is optional
// (no RESEND_API_KEY ⇒ the send is a logged no-op), so without this a signed-in
// user on an instance with no mail configured could never change their password
// at all.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { ErrorNote, Field } from "@/components/shell/form-primitives";
import { useUI } from "@/components/shell/ui-context";

const MIN_PASSWORD = 8;

export function Profile({ name, email }: { name: string; email: string }) {
  return (
    <div className="flex flex-col gap-5">
      <DisplayName current={name} />
      <EmailField email={email} />
      <ChangePassword />
    </div>
  );
}

function DisplayName({ current }: { current: string }) {
  const { showToast } = useUI();
  const router = useRouter();
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== current && name.trim().length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    const res = await authClient.updateUser({ name: name.trim() });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Couldn't update your name");
      return;
    }
    showToast("Name updated");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <Field label="DISPLAY NAME">
        <div className="flex gap-2 items-center flex-wrap">
          <input
            className="field !w-auto min-w-[220px] flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Display name"
            maxLength={60}
          />
          <button disabled={!dirty || busy} onClick={save} className="btn-primary disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </Field>
      <div className="text-[11.5px] text-mut2">Shown in the sidebar and on anything you share.</div>
      <ErrorNote error={error} />
    </div>
  );
}

function EmailField({ email }: { email: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Field label="EMAIL ADDRESS">
        <input className="field" value={email} readOnly disabled aria-label="Email address" />
      </Field>
      {/* Honest about the reason rather than hiding the field: changing the
          address is the account-recovery path, so doing it without a
          verification step would let anyone with your session take the account
          over — and password-reset mail is optional on this deployment, so a
          change could go through with no email sent at all. */}
      <div className="text-[11.5px] text-mut2">
        Your email is how you sign in and how a password reset reaches you, so it can&apos;t be changed here yet —
        doing that safely needs a verification step we haven&apos;t built. Get in touch if you need it changed.
      </div>
    </div>
  );
}

function ChangePassword() {
  const { showToast } = useUI();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setOpen(false);
  }

  async function save() {
    setError(null);
    if (next.length < MIN_PASSWORD) {
      setError(`Your new password needs at least ${MIN_PASSWORD} characters`);
      return;
    }
    if (next !== confirm) {
      setError("The two new passwords don't match");
      return;
    }
    if (next === current) {
      setError("Your new password is the same as your current one");
      return;
    }
    setBusy(true);
    const res = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: signOutOthers,
    });
    setBusy(false);
    if (res.error) {
      // better-auth returns "Invalid password" for a wrong current password —
      // reworded, since at this point the only password in question is theirs.
      setError(
        res.error.status === 400
          ? "That current password isn't right"
          : res.error.message ?? "Couldn't change your password"
      );
      return;
    }
    showToast(signOutOthers ? "Password changed — other devices signed out" : "Password changed");
    reset();
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <div className="label-caps">PASSWORD</div>
        <button
          onClick={() => setOpen(true)}
          className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer hover:bg-accsoft self-start"
        >
          Change password
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="label-caps">CHANGE PASSWORD</div>
      <Field label="CURRENT PASSWORD">
        <input
          type="password"
          className="field"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          aria-label="Current password"
          autoFocus
        />
      </Field>
      <Field label="NEW PASSWORD">
        <input
          type="password"
          className="field"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          aria-label="New password"
          placeholder={`At least ${MIN_PASSWORD} characters`}
        />
      </Field>
      <Field label="CONFIRM NEW PASSWORD">
        <input
          type="password"
          className="field"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          aria-label="Confirm new password"
        />
      </Field>

      <label className="flex items-start gap-2 text-[12px] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={signOutOthers}
          onChange={(e) => setSignOutOthers(e.target.checked)}
          className="cursor-pointer mt-0.5"
        />
        <span>
          Sign out my other devices
          {/* Matters here specifically: this app queues offline changes per
              device, so a signed-out phone holds its queue until it signs in
              again rather than losing it. */}
          <span className="block text-[11px] text-mut2">
            Recommended. A device with unsynced offline changes will keep them, but has to sign in again before they
            sync.
          </span>
        </span>
      </label>

      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button disabled={busy || !current || !next || !confirm} onClick={save} className="btn-primary disabled:opacity-50">
          {busy ? "Changing…" : "Change password"}
        </button>
        <button onClick={reset} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  );
}
