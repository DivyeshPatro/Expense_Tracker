import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";
import { onboardUser } from "./services/onboarding";
import { sendPasswordResetEmail } from "./email";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
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
