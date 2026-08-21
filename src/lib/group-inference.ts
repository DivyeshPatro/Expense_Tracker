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
  /** Nobody picked shares a group — an ordinary personal split. */
  | { kind: "none" }
  /** Exactly one group contains all of them — safe to apply. */
  | { kind: "one"; groupId: string; groupName: string }
  /** Several groups contain all of them — never guess; the caller must ask. */
  | { kind: "ambiguous"; candidates: GroupLike[] }
  /**
   * A group holds most of the people picked but not all of them (P0-3).
   *
   * This used to be indistinguishable from "none", so the form quietly filed
   * the expense as personal — the same silent conversion that lost four of
   * five expenses on one trip, except triggered by one extra head at dinner
   * rather than a collapsed Advanced section. It is reported separately now so
   * the caller can ask, because guessing either way is wrong: the group is a
   * real possibility and so is a genuinely personal split.
   */
  | { kind: "conflict"; candidates: GroupLike[]; outsiderIds: string[] };

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

  if (candidates.length === 1) return { kind: "one", groupId: candidates[0].id, groupName: candidates[0].name };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };

  // No group holds everyone. Before calling it personal, look for a group that
  // holds MOST of them: two or more of the people picked, with at least one
  // left outside. That shape — a group outing with a guest — is the one worth
  // stopping for. A single friend who happens to belong to some group is not:
  // asking there would interrupt every ordinary two-person split.
  const near = groups.filter((g) => {
    const roster = new Set(g.memberIds);
    const inside = selected.filter((id) => roster.has(id));
    return inside.length >= 2 && inside.length < selected.length;
  });
  if (near.length === 0) return { kind: "none" };

  // Outsiders relative to the best-covering candidate: the people who would
  // have to be removed (or added to the group) for this to be its expense.
  const best = near.reduce((a, b) => {
    const cover = (g: GroupLike) => selected.filter((id) => new Set(g.memberIds).has(id)).length;
    return cover(b) > cover(a) ? b : a;
  });
  const bestRoster = new Set(best.memberIds);
  return { kind: "conflict", candidates: near, outsiderIds: selected.filter((id) => !bestRoster.has(id)) };
}

/**
 * Whether the form must stop and make the user choose before saving.
 *
 * True when the people picked imply several groups, or imply one group they
 * do not all belong to, AND the user hasn't said which. Choosing "Personal
 * (not in a group)" is itself an explicit answer, so `groupChosen` covers it —
 * this never blocks someone who has actually decided, and never silently falls
 * back to Personal for someone who hasn't (the failure mode that lost the four
 * expenses).
 */
export function needsExplicitGroupChoice(inference: GroupInference, groupChosen: boolean): boolean {
  return (inference.kind === "ambiguous" || inference.kind === "conflict") && !groupChosen;
}
