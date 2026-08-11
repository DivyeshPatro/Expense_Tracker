// The concrete preferences. Kept apart from preferences.ts (the mechanism) so
// adding a preference is a data change, not a plumbing change.

import { definePref } from "./preferences";
import { DEFAULT_BASIS_PREF, parseBasisPref, type ExpenseBasisPref } from "./expense-basis";

/**
 * Which expense figure is shown larger. Presentation only — both figures are
 * always rendered, and no arithmetic, budget alert or export depends on it.
 * Cookie-backed because the dashboard and transaction summaries are server
 * components, so the wrong figure would otherwise be large on first paint.
 */
export const basisPref = definePref<ExpenseBasisPref>({
  key: "ledgerly-basis",
  storage: "cookie",
  fallback: DEFAULT_BASIS_PREF,
  parse: (raw) => parseBasisPref(raw),
  serialize: (v) => v,
});

/**
 * The last period the user chose, stored in the same query-string form the URL
 * uses ("" | "p=all" | "p=YYYY-MM" | "from=…&to=…").
 *
 * Validation happens at read time in parsePeriod rather than here: it already
 * rejects malformed months, future months and inverted ranges, and duplicating
 * that would give two places to disagree. This parser only has to guarantee a
 * string, which is why an over-long or junk value is discarded outright.
 */
export const periodPref = definePref<string>({
  key: "ledgerly-period",
  storage: "cookie",
  fallback: "",
  // Cheap sanity bound — a cookie is attached to every request, and nothing
  // legitimate here exceeds "from=YYYY-MM-DD&to=YYYY-MM-DD".
  parse: (raw) => (typeof raw === "string" && raw.length <= 64 ? raw : ""),
  serialize: (v) => v,
});
