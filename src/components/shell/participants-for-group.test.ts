// The split picker must offer a group's members, not the whole address book.
//
// Reported after editing a group expense: the picker listed all 94 contacts,
// burying the four people actually in the group. It is not only noise — picking
// an outsider produces a split the group can never settle, because the group
// dashboard only ever reads its own members.

import { describe, expect, it } from "vitest";
import { participantsForGroup } from "./split-editor";

const P = (id: string) => ({ id, name: id });
const ALL = ["ana", "ben", "cara", "dev", "outsider1", "outsider2"].map(P);
const GROUPS = [
  { id: "trip", memberIds: ["ana", "ben", "cara"] },
  { id: "flat", memberIds: ["dev"] },
];
const none: Record<string, boolean> = {};

describe("participantsForGroup", () => {
  it("offers everyone when the expense is personal", () => {
    expect(participantsForGroup(ALL, "", GROUPS, none)).toHaveLength(6);
  });

  it("offers only that group's members once a group is chosen", () => {
    expect(participantsForGroup(ALL, "trip", GROUPS, none).map((p) => p.id)).toEqual(["ana", "ben", "cara"]);
  });

  it("excludes outsiders — the actual bug", () => {
    const ids = participantsForGroup(ALL, "trip", GROUPS, none).map((p) => p.id);
    expect(ids).not.toContain("outsider1");
    expect(ids).not.toContain("outsider2");
    expect(ids).not.toContain("dev"); // a member of a different group
  });

  it("switching group switches the list", () => {
    expect(participantsForGroup(ALL, "flat", GROUPS, none).map((p) => p.id)).toEqual(["dev"]);
  });

  it("keeps someone already on the split even if they are not a member", () => {
    // Otherwise editing an old expense would hide a participant who is still
    // being charged — invisible but owing.
    const parts = { outsider1: true };
    const ids = participantsForGroup(ALL, "trip", GROUPS, parts).map((p) => p.id);
    expect(ids).toEqual(["ana", "ben", "cara", "outsider1"]);
  });

  it("ignores de-selected outsiders", () => {
    const parts = { outsider1: false };
    expect(participantsForGroup(ALL, "trip", GROUPS, parts).map((p) => p.id)).toEqual(["ana", "ben", "cara"]);
  });

  it("falls back to everyone when the group id is unknown", () => {
    // Better to offer too many than an empty picker the user cannot escape.
    expect(participantsForGroup(ALL, "gone", GROUPS, none)).toHaveLength(6);
  });

  it("returns an empty list for a group with no members, rather than everyone", () => {
    expect(participantsForGroup(ALL, "empty", [{ id: "empty", memberIds: [] }], none)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const copy = [...ALL];
    participantsForGroup(ALL, "trip", GROUPS, none);
    expect(ALL).toEqual(copy);
  });
});
