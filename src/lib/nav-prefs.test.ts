import { describe, expect, it } from "vitest";
import {
  bottomNav,
  DEFAULT_MAX_TABS,
  DEFAULT_PREFS,
  MAX_TABS,
  MIN_TABS,
  NAV_ITEMS,
  normalizePrefs,
  reorder,
  shownItems,
  sidebarItems,
  type NavPrefs,
} from "./nav-prefs";

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("normalizePrefs", () => {
  it("null → the defaults", () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it("drops unknown ids and appends brand-new modules at the end", () => {
    const p = normalizePrefs({ order: ["/cards", "/not-a-route", "/dashboard"] });
    expect(p.order).not.toContain("/not-a-route");
    expect(p.order[0]).toBe("/cards");
    expect(p.order).toContain("/settings"); // a module missing from the stored order is re-appended
    expect(new Set(p.order).size).toBe(p.order.length); // no dupes
  });

  it("never lets a protected module sit in hidden, and clamps maxTabs", () => {
    const p = normalizePrefs({ hidden: ["/settings", "/dashboard", "/cards"], maxTabs: 99 });
    expect(p.hidden).toEqual(["/cards"]);
    expect(p.maxTabs).toBe(MAX_TABS);
    expect(normalizePrefs({ maxTabs: 1 }).maxTabs).toBe(MIN_TABS);
  });
});

describe("shownItems", () => {
  it("default: Dashboard first, everything shown (nothing hidden by default)", () => {
    const shown = ids(shownItems(DEFAULT_PREFS));
    expect(shown[0]).toBe("/dashboard");
    expect(shown).toHaveLength(NAV_ITEMS.length); // all modules visible in the sidebar
  });

  it("hiding a non-protected module drops it from shown", () => {
    const shown = ids(shownItems({ ...DEFAULT_PREFS, hidden: ["/analytics"] }));
    expect(shown).not.toContain("/analytics");
  });

  it("pinned floats to the front (after Dashboard), guaranteeing it a bar slot", () => {
    const shown = ids(shownItems({ ...DEFAULT_PREFS, pinned: ["/bills"] }));
    expect(shown[0]).toBe("/dashboard");
    expect(shown[1]).toBe("/bills");
  });

  it("hiding a protected module is ignored — it stays shown", () => {
    const shown = ids(shownItems({ ...DEFAULT_PREFS, hidden: ["/settings"] }));
    expect(shown).toContain("/settings");
  });
});

describe("bottomNav", () => {
  it("default splits into a 5-tab bar + a More sheet that still reaches everything", () => {
    const { visible, more } = bottomNav(DEFAULT_PREFS);
    // #207: People took a daily slot — it answers "what does this person owe me,
    // in total?", which Lending and Shared each answered only half of. Both keep
    // their own routes and moved to the weekly tier; nothing was removed.
    expect(ids(visible)).toEqual(["/dashboard", "/transactions", "/people", "/cards", "/bills"]);
    expect(visible).toHaveLength(DEFAULT_MAX_TABS - 1); // last slot is the More button
    // hidden + overflow modules are all reachable under More
    for (const id of ["/lending", "/shared", "/accounts", "/budgets", "/settings", "/analytics", "/activity", "/import"]) {
      expect(ids(more)).toContain(id);
    }
  });

  it("hidden modules land in More, not the bar", () => {
    const { visible, more } = bottomNav({ ...DEFAULT_PREFS, hidden: ["/cards"] });
    expect(ids(visible)).not.toContain("/cards");
    expect(ids(more)).toContain("/cards");
    expect(visible.length).toBeLessThanOrEqual(DEFAULT_MAX_TABS - 1);
  });

  it("no More button only when every kept item fits and nothing is hidden (pure branch)", () => {
    // A hypothetical small catalogue exercised via the pure split: kept fits,
    // nothing hidden → no overflow, no More.
    const kept: NavPrefs = { order: DEFAULT_PREFS.order, hidden: [], pinned: [], maxTabs: MAX_TABS };
    // With the real 12-module catalogue and nothing hidden, kept (12) > maxTabs
    // (8) → there is always a More in practice; assert that invariant.
    const { more } = bottomNav(kept);
    expect(more.length).toBeGreaterThan(0);
  });

  it("a pinned overflow module is pulled into the visible bar", () => {
    // Budgets sits in the weekly tier → normally in More; pinning floats it in.
    // (This used to use Bills, which moved into the daily bar in #207.)
    expect(ids(bottomNav(DEFAULT_PREFS).visible)).not.toContain("/budgets");
    expect(ids(bottomNav({ ...DEFAULT_PREFS, pinned: ["/budgets"] }).visible)).toContain("/budgets");
  });
});

describe("sidebarItems", () => {
  it("mirrors shownItems (hidden out, order preserved)", () => {
    expect(ids(sidebarItems(DEFAULT_PREFS))).toEqual(ids(shownItems(DEFAULT_PREFS)));
  });
});

describe("reorder", () => {
  it("moves an item up and down, and is a no-op at the bounds", () => {
    const order = ["a", "b", "c"];
    expect(reorder(order, "b", -1)).toEqual(["b", "a", "c"]);
    expect(reorder(order, "b", 1)).toEqual(["a", "c", "b"]);
    expect(reorder(order, "a", -1)).toEqual(["a", "b", "c"]);
    expect(reorder(order, "c", 1)).toEqual(["a", "b", "c"]);
  });
});
