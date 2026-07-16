import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";
import { onboardUser } from "./services/onboarding";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
  },
  session: {
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
