// Transactional email — currently just password reset. Resend's free tier
// (100/day) is plenty for a personal app; RESEND_FROM must be an address on
// a domain verified in the Resend dashboard, or their shared onboarding
// domain (onboarding@resend.dev) for testing before a domain is verified.

import { Resend } from "resend";

let client: Resend | null = null;
function getClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const resend = getClient();
  if (!resend) {
    // Not configured yet — don't crash the reset flow, and don't leak
    // "email isn't set up" to the client (see requestPasswordReset's own
    // enumeration-safe copy). Loud enough for the operator to notice in logs.
    console.error("[email] RESEND_API_KEY not set — password reset email not sent. Reset URL:", resetUrl);
    return;
  }
  const from = process.env.RESEND_FROM || "Ledgerly <onboarding@resend.dev>";
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Reset your Ledgerly password",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <p>Someone requested a password reset for your Ledgerly account.</p>
        <p><a href="${resetUrl}" style="display:inline-block;padding:10px 18px;background:#2a63f6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Reset password</a></p>
        <p style="color:#888;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
    text: `Reset your Ledgerly password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
  });
  if (error) {
    console.error("[email] Resend send failed", error);
    throw new Error("Could not send the reset email — try again in a moment.");
  }
}
