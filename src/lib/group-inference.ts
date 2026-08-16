// v2.1 — split ↔ group coupling.
//
// The bug this exists to prevent: "Split with friends" and "Group" were two
// independent controls, and Group lived collapsed inside Advanced defaulting to
// Personal. Splitting an expense among a group's members therefore saved it
// with groupId = null, and the group dashboard — which filters on groupId —
// could never see it. Four of five expenses on one real trip went missing that
// way — the overwhelming majority of that group's spend.
//
// The coupling is deliberately asymmetric about certainty:
//   group  -> members   is a fact (the roster is known), so it just applies.
//   members -> group    is a guess, so it only applies when it is unambiguous,
//                       and otherwise ASKS rather than picking for the user.
//
// Everything here keys on participant IDs. Display names are never compared —
// two different people can legitimately share a name, and one real person once
// existed twice under the same name in production.

export interface GroupLike {
  id: string;
  name: string;
  memberIds: string[];
}

export type GroupInference =
  /** No group contains all the selected people — a personal split. */
  | { kind: "none" }
  /** Exactly one group contains all of them — safe to apply. */
  | { kind: "one"; groupId: string; groupName: string }
  /** Several groups contain all of them — never guess; the caller must ask. */
  | { kind: "ambiguous"; candidates: GroupLike[] };

/**
 * Which group, if any, a set of split participants implies.
 *
 * A group is a candidate when EVERY selected participant is a member of it.
 * Extra members in the group are fine — splitting dinner between two of your
 * four flatmates is still a flat expense. The reverse is not: one person who
 * isn't in the group means it isn't that group's expense.
 *
 * An empty selection infers nothing (a split needs at least one other person).
 */
export function inferGroupForMembers(selectedParticipantIds: string[], groups: GroupLike[]): GroupInference {
  const selected = [...new Set(selectedParticipantIds)];
  if (selected.length === 0) return { kind: "none" };

  const candidates = groups.filter((g) => {
    const roster = new Set(g.memberIds);
    return selected.every((id) => roster.has(id));
  });

  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", groupId: candidates[0].id, groupName: candidates[0].name };
  return { kind: "ambiguous", candidates };
}

/**
 * Whether the form must stop and make the user choose before saving.
 *
 * True only when the people picked imply several groups AND the user hasn't
 * said which. Choosing "Personal (not in a group)" is itself an explicit
 * answer, so `groupChosen` covers it — this never blocks someone who has
 * actually decided, and never silently falls back to Personal for someone who
 * hasn't (which is the failure mode that lost the four expenses).
 */
export function needsExplicitGroupChoice(inference: GroupInference, groupChosen: boolean): boolean {
  return inference.kind === "ambiguous" && !groupChosen;
}
