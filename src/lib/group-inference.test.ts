// v2.1 regression suite for the split -> group inference.
//
// The production incident these guard: four of five expenses on one trip were
// split among a group's members but saved with groupId = null, so the group
// dashboard showed a small fraction of the real total. The rules below are what stops that
// happening silently again — and, just as importantly, what stops the app
// guessing when it genuinely cannot know.

import { describe, expect, it } from "vitest";
import { inferGroupForMembers, needsExplicitGroupChoice } from "./group-inference";

const LAKESIDE = { id: "g-lake", name: "Lakeside", memberIds: ["p-alex", "p-blake", "p-casey", "p-devon"] };
const FLAT = { id: "g-flat", name: "Flat 402", memberIds: ["p-alex", "p-blake", "karan"] };
const SOLO = { id: "g-solo", name: "Solo", memberIds: ["zara"] };

describe("inferGroupForMembers", () => {
  it("infers the group when every person picked belongs to exactly one", () => {
    const r = inferGroupForMembers(["p-alex", "p-casey", "p-devon"], [LAKESIDE, FLAT]);
    expect(r).toEqual({ kind: "one", groupId: "g-lake", groupName: "Lakeside" });
  });

  it("reproduces the exact production case: all four trip members infer Lakeside", () => {
    // The roster of the real group, in the order the splits were stored.
    const r = inferGroupForMembers(["p-alex", "p-blake", "p-casey", "p-devon"], [LAKESIDE, FLAT]);
    expect(r.kind).toBe("one");
    expect(r.kind === "one" && r.groupId).toBe("g-lake");
  });

  it("still infers when only SOME of a group's members are on the expense", () => {
    // Dinner between two of four flatmates is still a flat expense.
    const r = inferGroupForMembers(["p-casey"], [LAKESIDE]);
    expect(r).toEqual({ kind: "one", groupId: "g-lake", groupName: "Lakeside" });
  });

  it("does not claim the group when one person is outside it", () => {
    // Superseded by P0-3, and deliberately kept rather than deleted: this used
    // to assert { kind: "none" }, which the form read as "personal" and saved
    // silently. The rule it was protecting — never claim a group that does not
    // hold everyone — still holds; what changed is that the caller is now told
    // to decide instead of being given a fallback.
    const r = inferGroupForMembers(["p-alex", "p-casey", "karan"], [LAKESIDE, FLAT]);
    expect(r.kind).not.toBe("one");
    expect(r.kind).toBe("conflict");
    expect(needsExplicitGroupChoice(r, false)).toBe(true);
  });

  it("refuses to guess when several groups contain everyone picked", () => {
    const r = inferGroupForMembers(["p-alex", "p-blake"], [LAKESIDE, FLAT]);
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.candidates.map((c) => c.id).sort()).toEqual(["g-flat", "g-lake"]);
  });

  it("infers nothing from an empty selection", () => {
    expect(inferGroupForMembers([], [LAKESIDE])).toEqual({ kind: "none" });
  });

  it("infers nothing when the user has no groups at all", () => {
    expect(inferGroupForMembers(["p-alex"], [])).toEqual({ kind: "none" });
  });

  it("ignores duplicate ids in the selection", () => {
    const r = inferGroupForMembers(["p-casey", "p-casey"], [LAKESIDE]);
    expect(r).toEqual({ kind: "one", groupId: "g-lake", groupName: "Lakeside" });
  });

  it("matches on participant id, never on display name", () => {
    // Two DIFFERENT people both called "Blake" — only the one whose ID is on
    // the roster may infer the group. This is the production duplicate.
    const groups = [{ id: "g-lake", name: "Lakeside", memberIds: ["p-blake-imported"] }];
    expect(inferGroupForMembers(["p-blake-imported"], groups).kind).toBe("one");
    expect(inferGroupForMembers(["p-blake-in-app"], groups).kind).toBe("none");
  });

  it("keeps groups isolated — a member of neither group infers neither", () => {
    expect(inferGroupForMembers(["zara"], [LAKESIDE, FLAT])).toEqual({ kind: "none" });
    expect(inferGroupForMembers(["zara"], [SOLO]).kind).toBe("one");
  });
});

describe("needsExplicitGroupChoice", () => {
  it("blocks only when ambiguous and unanswered", () => {
    const ambiguous = inferGroupForMembers(["p-alex", "p-blake"], [LAKESIDE, FLAT]);
    expect(needsExplicitGroupChoice(ambiguous, false)).toBe(true);
  });

  it("releases once the user has chosen a group", () => {
    const ambiguous = inferGroupForMembers(["p-alex", "p-blake"], [LAKESIDE, FLAT]);
    expect(needsExplicitGroupChoice(ambiguous, true)).toBe(false);
  });

  it("treats choosing Personal as a real answer, not a fallback", () => {
    // groupChosen is set by picking anything in the select, including the
    // "Personal (not in a group)" option — that is the user deciding.
    const ambiguous = inferGroupForMembers(["p-alex", "p-blake"], [LAKESIDE, FLAT]);
    expect(needsExplicitGroupChoice(ambiguous, true)).toBe(false);
  });

  it("never blocks an unambiguous or empty inference", () => {
    expect(needsExplicitGroupChoice({ kind: "none" }, false)).toBe(false);
    expect(needsExplicitGroupChoice({ kind: "one", groupId: "g", groupName: "G" }, false)).toBe(false);
  });
});

// ── P0-3: an outsider must not silently make it a personal expense ─────────
//
// The failure this guards is the quieter cousin of the four lost expenses:
// four people from a trip plus one friend who isn't on it. No group contains
// everyone, the inference returned "none", and the form filed a ₹2,530 group
// dinner as a personal split that the group dashboard could never show.
describe("a group outing with a guest", () => {
  const GUEST = "p-guest";

  it("reports a conflict rather than falling back to personal", () => {
    const r = inferGroupForMembers(["p-alex", "p-casey", "p-devon", GUEST], [LAKESIDE, FLAT]);
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("unreachable");
    expect(r.candidates.map((c) => c.id)).toEqual(["g-lake"]);
    expect(r.outsiderIds).toEqual([GUEST]);
  });

  it("names every person who would have to be removed or added", () => {
    const r = inferGroupForMembers(["p-alex", "p-casey", GUEST, "zara"], [LAKESIDE]);
    if (r.kind !== "conflict") throw new Error(`expected conflict, got ${r.kind}`);
    expect(r.outsiderIds.sort()).toEqual([GUEST, "zara"].sort());
  });

  it("blocks the save until the user decides", () => {
    const r = inferGroupForMembers(["p-alex", "p-casey", "p-devon", GUEST], [LAKESIDE, FLAT]);
    expect(needsExplicitGroupChoice(r, false)).toBe(true);
    // and releases the moment they do — including by choosing Personal
    expect(needsExplicitGroupChoice(r, true)).toBe(false);
  });

  it("still infers cleanly when the guest is added to the group", () => {
    const widened = { ...LAKESIDE, memberIds: [...LAKESIDE.memberIds, GUEST] };
    const r = inferGroupForMembers(["p-alex", "p-casey", GUEST], [widened, FLAT]);
    expect(r.kind).toBe("one");
  });

  it("does not interrupt an ordinary two-person split", () => {
    // One friend who happens to belong to a group, plus someone who doesn't,
    // is not evidence of a group outing — asking here would fire on most
    // personal splits. It takes two people from the same group to look like one.
    const r = inferGroupForMembers(["p-alex", "p-outsider"], [LAKESIDE, FLAT]);
    expect(r.kind).toBe("none");
    expect(needsExplicitGroupChoice(r, false)).toBe(false);
  });

  it("keeps 'no group context' behaving exactly as before", () => {
    expect(inferGroupForMembers([], [LAKESIDE, FLAT]).kind).toBe("none");
    expect(inferGroupForMembers(["p-nobody", "p-nobody-else"], [LAKESIDE, FLAT]).kind).toBe("none");
    expect(inferGroupForMembers(["p-alex", "p-casey"], []).kind).toBe("none");
  });

  it("prefers the group that covers the most of them", () => {
    // Lakeside holds three of the four; Flat holds two. The people who must
    // change are reported against the better fit.
    const r = inferGroupForMembers(["p-alex", "p-blake", "p-casey", GUEST], [FLAT, LAKESIDE]);
    if (r.kind !== "conflict") throw new Error(`expected conflict, got ${r.kind}`);
    expect(r.outsiderIds).toEqual([GUEST]);
  });
});
