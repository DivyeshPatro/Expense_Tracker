// Notification inbox: budget threshold crossings (budgets.ts) and recurring
// materializations (recurring.ts) already write rows here — this just reads
// them back for the bell in the top bar.

import { prisma } from "../db";

export interface NotificationView {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export async function listNotifications(userId: string, limit = 20): Promise<NotificationView[]> {
  const rows = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    payload: r.payload as Record<string, unknown>,
    readAt: r.readAt,
    createdAt: r.createdAt,
  }));
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}
