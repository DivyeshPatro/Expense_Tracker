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

export async function renameCategory(userId: string, categoryId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Category name is required");
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw new Error("Category not found");
  const collision = await prisma.category.findUnique({
    where: { userId_name_kind: { userId, name: trimmed, kind: category.kind } },
  });
  if (collision && collision.id !== categoryId) throw new Error(`You already have a category named "${trimmed}"`);
  return prisma.category.update({ where: { id: categoryId }, data: { name: trimmed } });
}

/**
 * Flips a category between Expense and Income — for the common "picked the
 * wrong kind when creating it" mistake. Existing transactions keep whatever
 * type they were actually recorded as; only the category's own classification
 * (which tab it lives in, which add-expense/add-income dropdown offers it)
 * changes.
 */
export async function changeCategoryKind(userId: string, categoryId: string, kind: "EXPENSE" | "INCOME") {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw new Error("Category not found");
  if (category.kind === kind) return category;
  const collision = await prisma.category.findUnique({ where: { userId_name_kind: { userId, name: category.name, kind } } });
  if (collision) throw new Error(`You already have a category named "${category.name}" under ${kind === "EXPENSE" ? "Expense" : "Income"}`);
  const icon = category.icon === KIND_ICON[category.kind] ? KIND_ICON[kind] : category.icon;
  return prisma.category.update({ where: { id: categoryId }, data: { kind, icon } });
}

/** Blocks deletion while the category is still referenced, rather than silently orphaning transactions/budgets. */
export async function deleteCategory(userId: string, categoryId: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw new Error("Category not found");
  const [txCount, budgetCount, ruleCount] = await Promise.all([
    prisma.transaction.count({ where: { categoryId, deletedAt: null } }),
    prisma.budget.count({ where: { categoryId } }),
    prisma.merchantRule.count({ where: { categoryId } }),
  ]);
  const inUse = txCount + budgetCount + ruleCount;
  if (inUse > 0) {
    throw new Error(
      `"${category.name}" is used by ${txCount} transaction${txCount === 1 ? "" : "s"}${budgetCount ? `, ${budgetCount} budget${budgetCount === 1 ? "" : "s"}` : ""}${ruleCount ? `, ${ruleCount} merchant rule${ruleCount === 1 ? "" : "s"}` : ""} — reassign those first.`
    );
  }
  await prisma.category.delete({ where: { id: categoryId } });
}
