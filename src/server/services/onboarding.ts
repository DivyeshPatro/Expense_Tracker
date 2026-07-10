import { DEFAULT_CATEGORIES, MERCHANT_DICTIONARY } from "@/lib/categories";
import { prisma } from "../db";

/**
 * Runs once per new user (Better Auth create hook): seed the default category
 * set (per-user rows — Architecture doc §4.4), the merchant→category dictionary
 * for rule-based auto-categorization, and a starter Cash account.
 */
export async function onboardUser(userId: string) {
  await prisma.category.createMany({
    data: DEFAULT_CATEGORIES.map((c) => ({
      userId,
      name: c.name,
      kind: c.kind,
      icon: c.icon,
      color: c.color,
    })),
    skipDuplicates: true,
  });

  const categories = await prisma.category.findMany({ where: { userId, kind: "EXPENSE" } });
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  const rules = Object.entries(MERCHANT_DICTIONARY)
    .filter(([, cat]) => byName.has(cat))
    .map(([merchant, cat]) => ({ userId, merchant, categoryId: byName.get(cat)! }));
  await prisma.merchantRule.createMany({ data: rules, skipDuplicates: true });

  const existing = await prisma.account.count({ where: { userId } });
  if (existing === 0) {
    await prisma.account.create({
      data: { userId, name: "Cash Wallet", type: "CASH", icon: "💵", color: "#149356" },
    });
  }
}
