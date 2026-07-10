import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";
import { onboardUser } from "./services/onboarding";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
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
