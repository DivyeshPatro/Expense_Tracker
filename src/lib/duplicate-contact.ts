// v2.1 — duplicate-person prevention.
//
// Why this exists: a contact imported from a Monito khata was classified
// "lending-only" and hidden from the split picker. The owner went looking for
// "Blake", could not find him, and created a second "Blake". Both then
// accumulated real debt — part of it on one row, part on the other — for one
// human, and only one of the two was in the group.
//
// Two independent guards came out of that:
//   1. the split picker no longer hides anyone (see layout.tsx / modals.tsx), so
//      the dead end that forced the duplicate is gone;
//   2. this module, which notices when a name being typed already exists and
//      offers that person instead.
//
// This NEVER merges, blocks, or rewrites anything. It surfaces candidates and
// hands back their IDs; the human decides. Matching on a name is a heuristic
// for a *suggestion* only — identity everywhere else in the app is the
// participant ID, because two different people genuinely can share a name.

export interface ContactLike {
  id: string;
  name: string;
}

export type DuplicateKind = "exact" | "similar";

export interface DuplicateMatch {
  id: string;
  name: string;
  kind: DuplicateKind;
}

/**
 * Casefold for comparison: strip diacritics, drop anything that isn't a letter
 * or digit, collapse whitespace. "Blake", "blake ", "BALDEV" and "Bal-dev"
 * all land on the same key, which is the class of near-miss that produces
 * accidental duplicates in practice.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance, iterative with a single rolling row. Names are short,
 *  so this is cheap even across a few hundred contacts. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** One edit for short names, two for longer ones — tight enough that "Casey"
 *  and "Kasey" match while "Ravi" and "Ram" do not. */
function similarityBudget(len: number): number {
  if (len <= 4) return 0;
  if (len <= 8) return 1;
  return 2;
}

/**
 * Existing contacts that the given name probably already refers to, best match
 * first (exact before similar, then shorter edit distance).
 *
 * `excludeId` skips a contact being renamed to itself. A blank name matches
 * nothing — there is nothing to warn about until the user has typed.
 */
export function findDuplicateContacts(name: string, contacts: ContactLike[], excludeId?: string): DuplicateMatch[] {
  const needle = normalizeName(name);
  if (!needle) return [];

  const scored: (DuplicateMatch & { distance: number })[] = [];
  for (const c of contacts) {
    if (c.id === excludeId) continue;
    const hay = normalizeName(c.name);
    if (!hay) continue;
    if (hay === needle) {
      scored.push({ id: c.id, name: c.name, kind: "exact", distance: 0 });
      continue;
    }
    // A first-name entry standing in for a fuller record ("Blake" vs
    // "Blake Sahu") is the other common way one person becomes two.
    const prefix = hay.startsWith(`${needle} `) || needle.startsWith(`${hay} `);
    const distance = editDistance(needle, hay);
    if (prefix || distance <= similarityBudget(Math.min(needle.length, hay.length))) {
      scored.push({ id: c.id, name: c.name, kind: "similar", distance: prefix ? 0.5 : distance });
    }
  }

  return scored
    .sort((a, b) => (a.kind === b.kind ? a.distance - b.distance : a.kind === "exact" ? -1 : 1))
    .map(({ id, name: n, kind }) => ({ id, name: n, kind }));
}
