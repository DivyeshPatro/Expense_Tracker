import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";
import { onboardUser } from "./services/onboarding";
import { sendPasswordResetEmail } from "./email";

/**
 * Registration is CLOSED unless ALLOW_SIGNUP is explicitly set.
 *
 * Ledgerly is a self-hosted single-tenant app: a deployment holds one person's
 * complete financial history, and from Phase 3.1 their stored card details too.
 * Leaving registration open on a public URL means a stranger can create an
 * account inside that deployment — and once the Credit Cards module exists, the
 * operator becomes custodian of whatever card numbers those strangers save.
 *
 * Closed is therefore the safe default. To create the first account, set
 * ALLOW_SIGNUP=true, register, then remove it — see .env.example.
 */
export const signupAllowed = process.env.ALLOW_SIGNUP === "true";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // Enforced by better-auth's own sign-up route, so it holds for direct API
    // calls too — not just the form we render.
    disableSignUp: !signupAllowed,
    // url already points at better-auth's own /reset-password/:token redirect
    // callback (baseURL-relative) — see request-password-reset in
    // better-auth's password routes. We just deliver it.
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail(user.email, url);
    },
  },
  session: {
    // 30 days (offline-sync-spec §19.1, locked): a week-offline phone must
    // not come back to a stranded queue behind an expired session.
    expiresIn: 60 * 60 * 24 * 30,
    // every RSC navigation calls getSession(); without this each one is a
    // Postgres round trip before any page work can start. The signed cookie
    // cache answers those from the request itself for 5 minutes (sign-out
    // clears the cookie, so the staleness window only affects sessions
    // revoked out-of-band — acceptable for a single-user personal app).
    cookieCache: {
      enabled: true,
      maxAge: 300,
    },
  },
  account: {
    modelName: "authAccount", // our domain owns the name "Account" (financial accounts)
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await onboardUser(user.id);
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
