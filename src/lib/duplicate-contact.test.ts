// v2.1 regression suite for duplicate-person prevention.
//
// Production produced two "Blake" participant rows for one human, holding
// two separate portions of the same person's debt. These tests pin the warning
// that now fires before a second record can be created by accident — and pin
// the equally important rule that the app never treats a shared name as
// evidence two records ARE the same person.

import { describe, expect, it } from "vitest";
import { findDuplicateContacts, normalizeName } from "./duplicate-contact";

const CONTACTS = [
  { id: "p-blake-imported", name: "Blake" },
  { id: "p-alex", name: "Alex" },
  { id: "p-casey", name: "Casey" },
  { id: "p-devon", name: "Devon" },
  { id: "p-riley", name: "Riley Fernandes" },
];

describe("normalizeName", () => {
  it("folds case, padding and punctuation to one key", () => {
    expect(normalizeName("Blake")).toBe("blake");
    expect(normalizeName("  BLAKE  ")).toBe("blake");
    expect(normalizeName("Bla-ke")).toBe("bla ke");
  });

  it("strips diacritics", () => {
    expect(normalizeName("Renée")).toBe("renee");
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeName("Deepak   Ranjan")).toBe("deepak ranjan");
  });

  it("returns empty for a blank name", () => {
    expect(normalizeName("   ")).toBe("");
  });
});

describe("findDuplicateContacts", () => {
  it("catches the exact production case — typing 'Blake' when Blake exists", () => {
    const m = findDuplicateContacts("Blake", CONTACTS);
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ id: "p-blake-imported", name: "Blake", kind: "exact" });
  });

  it("catches it regardless of case or stray whitespace", () => {
    expect(findDuplicateContacts("  blake ", CONTACTS)[0]?.kind).toBe("exact");
    expect(findDuplicateContacts("BLAKE", CONTACTS)[0]?.kind).toBe("exact");
  });

  it("returns the existing contact's ID so the caller can link instead of create", () => {
    // This is the whole point: the warning hands back an identity, not a name.
    expect(findDuplicateContacts("blake", CONTACTS)[0].id).toBe("p-blake-imported");
  });

  it("flags a near-miss spelling", () => {
    const m = findDuplicateContacts("Kasey", CONTACTS);
    expect(m[0]).toMatchObject({ id: "p-casey", kind: "similar" });
  });

  it("flags a first name standing in for a fuller existing record", () => {
    const m = findDuplicateContacts("Riley", CONTACTS);
    expect(m[0]?.id).toBe("p-riley");
  });

  it("does not flag genuinely different people", () => {
    expect(findDuplicateContacts("Morgan", CONTACTS)).toEqual([]);
    expect(findDuplicateContacts("Jordan", CONTACTS)).toEqual([]);
  });

  it("does not flag short names that merely rhyme", () => {
    const short = [{ id: "a", name: "Ravi" }];
    expect(findDuplicateContacts("Ram", short)).toEqual([]);
  });

  it("warns but never merges — the existing contact is returned untouched", () => {
    const before = structuredClone(CONTACTS);
    findDuplicateContacts("Blake", CONTACTS);
    expect(CONTACTS).toEqual(before);
  });

  it("returns nothing for a blank name so the field is quiet until typed in", () => {
    expect(findDuplicateContacts("", CONTACTS)).toEqual([]);
    expect(findDuplicateContacts("   ", CONTACTS)).toEqual([]);
  });

  it("skips the contact being renamed to itself", () => {
    expect(findDuplicateContacts("Blake", CONTACTS, "p-blake-imported")).toEqual([]);
  });

  it("orders exact matches ahead of similar ones", () => {
    const contacts = [{ id: "near", name: "Blakee" }, { id: "exact", name: "Blake" }];
    expect(findDuplicateContacts("Blake", contacts).map((m) => m.id)).toEqual(["exact", "near"]);
  });

  it("surfaces BOTH records once a duplicate already exists", () => {
    // The production state today: warning a third attempt about both Blakes.
    const withDuplicate = [...CONTACTS, { id: "p-blake-in-app", name: "Blake" }];
    const m = findDuplicateContacts("Blake", withDuplicate);
    expect(m.map((x) => x.id).sort()).toEqual(["p-blake-imported", "p-blake-in-app"]);
    expect(m.every((x) => x.kind === "exact")).toBe(true);
  });
});
