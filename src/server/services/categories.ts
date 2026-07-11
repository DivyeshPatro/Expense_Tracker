// Custom categories (PRD §4.3: "Users can create custom categories") — per-user
// rows seeded from the default set at signup, so renames/additions never
// collide between users (Architecture doc §4).

import type { TxType } from "@prisma/client";
import { prisma } from "../db";

export async function listCategories(userId: string) {
  return prisma.category.findMany({ where: { userId }, orderBy: { name: "asc" } });
}

const KIND_ICON: Record<TxType, string> = { EXPENSE: "📦", INCOME: "💼", TRANSFER: "⇄" };

export async function createCategory(userId: string, name: string, kind: "EXPENSE" | "INCOME") {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Category name is required");
  const existing = await prisma.category.findUnique({ where: { userId_name_kind: { userId, name: trimmed, kind } } });
  if (existing) return existing;
  return prisma.category.create({ data: { userId, name: trimmed, kind, icon: KIND_ICON[kind] } });
}
