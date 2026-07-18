// Collaboration Architecture RFC §15 — exit criteria for the authorization
// foundation (migration steps 1-3). Exercises assertCanRead/assertCanWrite
// and the five updated service functions directly against the real
// database — no UI surfaces any of this yet (step 4), so there's nothing to
// drive through Playwright. Positive paths prove a member with the right
// role can act; negative paths prove the cross-tenant leakage risk named in
// rfc §10 doesn't exist.
// Run: npx tsx scripts/e2e-collab-foundation.ts
import { randomUUID } from "node:crypto";
import { prisma } from "../src/server/db";
import { NotAuthorizedError, resolveGroupRole } from "../src/server/services/authorization";
import { listGroupCategories } from "../src/server/services/categories";
import {
  addExpense,
  applyBalances,
  getTransactionDetail,
  softDeleteTransaction,
  updateExpense,
} from "../src/server/services/transactions";
import { addGroupMember, changeGroupMemberRole, createGroup, deleteGroup, leaveGroup, removeGroupMember, renameGroup } from "../src/server/services/groups";
import { acceptInvitation, createInvitation } from "../src/server/services/invitations";

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function expectAuthDenied(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(label, false, "expected NotAuthorizedError, nothing was thrown");
  } catch (e) {
    ok(label, e instanceof NotAuthorizedError, e instanceof NotAuthorizedError ? "" : `wrong error: ${e}`);
  }
}

async function main() {
  const suffix = randomUUID().slice(0, 8);

  // ── fixtures: three real users, two groups ──
  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const bob = await prisma.user.create({ data: { name: "Bob", email: `bob-${suffix}@test.local`, emailVerified: true } });
  const carol = await prisma.user.create({ data: { name: "Carol", email: `carol-${suffix}@test.local`, emailVerified: true } });
  const aliceAccount = await prisma.account.findFirstOrThrow({ where: { userId: alice.id } });
  const aliceCategory = await prisma.category.findFirstOrThrow({ where: { userId: alice.id, kind: "EXPENSE" } });

  await createGroup(alice.id, `TestFlat-${suffix}`, []);
  const flat = await prisma.group.findFirstOrThrow({ where: { name: `TestFlat-${suffix}`, createdById: alice.id } });
  const otherGroupOwner = carol.id;
  await createGroup(otherGroupOwner, `OtherGroup-${suffix}`, []);
  const otherGroup = await prisma.group.findFirstOrThrow({ where: { name: `OtherGroup-${suffix}`, createdById: otherGroupOwner } });

  // Bob joins TestFlat via the real invitation flow (exercises §9's atomic grant)
  const bobParticipant = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "Bob" } });
  const { token } = await createInvitation(alice.id, bobParticipant.id, flat.id, "MEMBER");
  await acceptInvitation(token, bob.id);

  const bobRoleAfterAccept = await resolveGroupRole(prisma, flat.id, bob.id);
  ok("accepting a group invitation grants membership atomically (§9)", bobRoleAfterAccept === "MEMBER", `role=${bobRoleAfterAccept}`);

  // Alice's group transaction (filed under her own namespace, §1)
  const aliceTxId = await addExpense(alice.id, {
    amount: 50000,
    accountId: aliceAccount.id,
    categoryId: aliceCategory.id,
    merchant: `GroupRent-${suffix}`,
    date: new Date().toISOString().slice(0, 10),
    groupId: flat.id,
  });

  // ═══════════════════════ positive paths ═══════════════════════

  ok(
    "a MEMBER can create a new transaction tagged with the group (positive)",
    !!(await addExpense(bob.id, {
      amount: 1000,
      accountId: null,
      categoryId: null,
      merchant: `BobOwn-${suffix}`,
      date: new Date().toISOString().slice(0, 10),
      groupId: flat.id,
    }))
  );
  const bobTx = await prisma.transaction.findFirstOrThrow({ where: { merchant: `BobOwn-${suffix}` } });

  await updateExpense(bob.id, aliceTxId, {
    amount: 55000,
    accountId: aliceAccount.id, // unchanged — not a write-account attempt
    categoryId: aliceCategory.id,
    merchant: `GroupRent-${suffix}-edited`,
    date: new Date().toISOString().slice(0, 10),
  });
  const afterBobEdit = await prisma.transaction.findUniqueOrThrow({ where: { id: aliceTxId } });
  ok(
    "a MEMBER can edit every field but accountId of another member's group transaction (positive)",
    afterBobEdit.merchant === `GroupRent-${suffix}-edited` && Number(afterBobEdit.amount) === 55000
  );

  await expectAuthDenied("a plain MEMBER cannot delete a transaction created by someone else (negative, pre-promotion)", () =>
    softDeleteTransaction(bob.id, aliceTxId)
  );

  await changeGroupMemberRole(alice.id, flat.id, bobParticipant.id, "ADMIN");
  const bobRoleAfterPromote = await resolveGroupRole(prisma, flat.id, bob.id);
  ok("an OWNER can change a member's role (positive)", bobRoleAfterPromote === "ADMIN", `role=${bobRoleAfterPromote}`);

  await softDeleteTransaction(bob.id, aliceTxId);
  const afterAdminDelete = await prisma.transaction.findUniqueOrThrow({ where: { id: aliceTxId } });
  ok("an ADMIN can delete a transaction created by a different member (positive)", afterAdminDelete.deletedAt !== null);

  await softDeleteTransaction(bob.id, bobTx.id);
  const bobOwnDeleted = await prisma.transaction.findUniqueOrThrow({ where: { id: bobTx.id } });
  ok("a MEMBER can always delete their own transaction (positive, owner fast-path)", bobOwnDeleted.deletedAt !== null);

  await renameGroup(alice.id, flat.id, `TestFlat-${suffix}-renamed`);
  const renamed = await prisma.group.findUniqueOrThrow({ where: { id: flat.id } });
  ok("an OWNER can rename the group (positive)", renamed.name === `TestFlat-${suffix}-renamed`);

  // ═══════════════════════ negative paths ═══════════════════════

  const carolReadResult = await getTransactionDetail(carol.id, aliceTxId);
  ok(
    "a non-member (Carol) reading a transaction she has no access to gets exactly the same null a nonexistent row would (never confirms existence)",
    carolReadResult === null
  );

  // accountId lock (rfc §1/§15): a fresh Alice-owned group transaction, since
  // the earlier one is already soft-deleted by this point
  const secondAliceTxId = await addExpense(alice.id, {
    amount: 20000,
    accountId: aliceAccount.id,
    categoryId: aliceCategory.id,
    merchant: `GroupGroceries-${suffix}`,
    date: new Date().toISOString().slice(0, 10),
    groupId: flat.id,
  });

  await expectAuthDenied("Carol, a member of a DIFFERENT group, still cannot touch TestFlat's transaction", () =>
    updateExpense(carol.id, secondAliceTxId, {
      amount: 1,
      accountId: aliceAccount.id,
      categoryId: null,
      merchant: "hijacked",
      date: new Date().toISOString().slice(0, 10),
    })
  );
  ok(
    "Carol's membership in OtherGroup is real (sanity check the negative test above isn't vacuous)",
    (await resolveGroupRole(prisma, otherGroup.id, carol.id)) === "OWNER"
  );

  const scratchAccount = await prisma.account.create({ data: { userId: alice.id, name: `Scratch-${suffix}`, type: "BANK", balance: 0, openingBalance: 0 } });
  await expectAuthDenied(
    "a MEMBER/ADMIN cannot change accountId on a transaction they don't own, even bundled with otherwise-valid fields",
    () =>
      updateExpense(bob.id, secondAliceTxId, {
        amount: 21000, // a legitimate change, bundled with the disallowed one
        accountId: scratchAccount.id, // the disallowed change
        categoryId: aliceCategory.id,
        merchant: `GroupGroceries-${suffix}-attempted`,
        date: new Date().toISOString().slice(0, 10),
      })
  );
  const untouched = await prisma.transaction.findUniqueOrThrow({ where: { id: secondAliceTxId } });
  ok(
    "the whole write rejected — amount did NOT partially apply alongside the blocked accountId change",
    Number(untouched.amount) === 20000 && untouched.merchant === `GroupGroceries-${suffix}`
  );

  // demote Bob back to MEMBER first — he's still ADMIN from the earlier
  // delete test, and these checks are specifically about the MEMBER tier
  await changeGroupMemberRole(alice.id, flat.id, bobParticipant.id, "MEMBER");
  const carolParticipant = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "Carol", linkedUserId: carol.id } });
  await expectAuthDenied("a MEMBER cannot add another member to the group", () => addGroupMember(bob.id, flat.id, carolParticipant.id));
  await expectAuthDenied("a MEMBER cannot remove another member from the group", () => removeGroupMember(bob.id, flat.id, bobParticipant.id));
  await expectAuthDenied("a MEMBER cannot rename the group", () => renameGroup(bob.id, flat.id, "hijacked name"));
  await expectAuthDenied("a MEMBER cannot delete the group", () => deleteGroup(bob.id, flat.id));

  await changeGroupMemberRole(alice.id, flat.id, bobParticipant.id, "ADMIN");
  await expectAuthDenied("an ADMIN cannot delete the group (OWNER-only)", () => deleteGroup(bob.id, flat.id));

  // a second, still-alive Bob-owned transaction — bobTx above is already
  // soft-deleted, so §3.1's "own-row access survives leaving" needs a fresh one
  const bobSecondTxId = await addExpense(bob.id, {
    amount: 500,
    accountId: null,
    categoryId: null,
    merchant: `BobOwnStillHere-${suffix}`,
    date: new Date().toISOString().slice(0, 10),
    groupId: flat.id,
  });

  await leaveGroup(bob.id, flat.id);
  const bobRoleAfterLeave = await resolveGroupRole(prisma, flat.id, bob.id);
  ok("leaving a group removes membership immediately", bobRoleAfterLeave === null);

  await expectAuthDenied("a departed member loses access to OTHER members' transactions on their very next request", () =>
    updateExpense(bob.id, secondAliceTxId, {
      amount: 1,
      accountId: aliceAccount.id,
      categoryId: null,
      merchant: "should be denied",
      date: new Date().toISOString().slice(0, 10),
    })
  );

  const bobOwnAfterLeaving = await getTransactionDetail(bob.id, bobSecondTxId);
  ok(
    "a departed member RETAINS access to transactions where they are the owner (§3.1 — leaving revokes group-derived access only)",
    bobOwnAfterLeaving !== null && bobOwnAfterLeaving.merchant === `BobOwnStillHere-${suffix}`
  );

  // unlinked ghost participant with a role can never authorize anyone
  const ghostParticipant = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "Ghost" } });
  await prisma.groupMember.create({ data: { groupId: flat.id, participantId: ghostParticipant.id, role: "ADMIN" } });
  const strangerRole = await resolveGroupRole(prisma, flat.id, randomUUID());
  ok("an unlinked (ghost) participant's role never authorizes a random user id", strangerRole === null);

  // ═══════════════════════ read-path scoping ═══════════════════════

  // group-expenses-sprint: categories are now group-OWNED rows
  // (Category.groupId), seeded by createGroup() itself — no longer derived
  // from "what's been used in the group's transactions" (that heuristic is
  // gone; superseded, not just narrowed further).
  const groupCats = await listGroupCategories(alice.id, flat.id);
  ok(
    "listGroupCategories returns the group's OWN category rows (createGroup's default seed), never a member's personal categories",
    groupCats.length === 9 && groupCats.every((c) => c.groupId === flat.id) && !groupCats.some((c) => c.id === aliceCategory.id),
    `${groupCats.length} rows`
  );
  const alicePrivateCategoryCount = await prisma.category.count({ where: { userId: alice.id } });
  ok(
    "the group-scoped category list is narrower than the owner's full private list",
    groupCats.length < alicePrivateCategoryCount,
    `${groupCats.length} of ${alicePrivateCategoryCount}`
  );

  // re-add Bob to read the account-genericization case as a non-owner
  await addGroupMember(alice.id, flat.id, bobParticipant.id);
  const nonOwnerRead = await getTransactionDetail(bob.id, secondAliceTxId);
  ok(
    "a non-owner reading a group transaction never sees the real account name",
    nonOwnerRead !== null && nonOwnerRead.accountName !== aliceAccount.name && !!nonOwnerRead.accountName?.includes("account")
  );
  const ownerRead = await getTransactionDetail(alice.id, secondAliceTxId);
  ok("the owner themself still sees the real account name", ownerRead?.accountName === aliceAccount.name);

  // ═══════════════════════ cleanup ═══════════════════════
  const txIds = [aliceTxId, bobTx.id, secondAliceTxId, bobSecondTxId];
  for (const id of txIds) {
    const t = await prisma.transaction.findUnique({ where: { id } });
    if (t && t.deletedAt === null && t.accountId) await applyBalances(prisma, t, -1);
  }
  await prisma.expenseSplit.deleteMany({ where: { txId: { in: txIds } } });
  await prisma.transaction.deleteMany({ where: { id: { in: txIds } } });
  await prisma.intent.deleteMany({ where: { entityId: { in: txIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: txIds } } });
  await prisma.account.delete({ where: { id: scratchAccount.id } });
  await prisma.groupMember.deleteMany({ where: { groupId: { in: [flat.id, otherGroup.id] } } });
  await prisma.invitation.deleteMany({ where: { participantId: { in: [bobParticipant.id, carolParticipant.id, ghostParticipant.id] } } });
  await prisma.participant.deleteMany({ where: { id: { in: [bobParticipant.id, carolParticipant.id, ghostParticipant.id] } } });
  await prisma.group.deleteMany({ where: { id: { in: [flat.id, otherGroup.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [bob.id, carol.id] } } });
}

main()
  .catch((e) => {
    ok("script error", false, String(e).slice(0, 500));
  })
  .finally(async () => {
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
