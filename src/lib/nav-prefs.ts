// Navigation customization (v2.0). Users shape the app's navigation around their
// own workflow — which modules show, in what order, which are pinned, and how
// many sit in the bottom bar before the rest fold into "More". Stored per device
// (localStorage), exactly like the dashboard widget customization.
//
// This module is the pure core: the item catalogue, the defaults, the safeguards
// (Dashboard and Settings can never be hidden), and the functions that turn a
// preference object into the concrete visible/overflow split. No React, no
// storage — those live in the hook that wraps this.

export type NavTier = "daily" | "weekly" | "rare";

export interface NavItem {
  id: string; // the route href, e.g. "/dashboard"
  label: string;
  icon: string; // NavGlyph key
  /** How often a person actually needs this module (#202). */
  tier: NavTier;
}

/**
 * The full module catalogue, in the default order — and the app's SINGLE source
 * of navigation truth (issue #201).
 *
 * app-shell.tsx used to keep a second, parallel catalogue with its own labels,
 * so four of twelve routes had two different names depending on where you
 * looked: the tab bar said "Khata" while the header above it said "Lending",
 * and likewise Home/Dashboard, Spends/Transactions, Insights/Analytics. The
 * header now derives its title from this list, so the two cannot drift again.
 *
 * `tier` (issue #202) is how often a person actually needs the module. It
 * drives the default bottom-bar order and what the desktop sidebar groups
 * under a divider — it does not hide anything.
 */
export const NAV_ITEMS: NavItem[] = [
  // daily — the five things a person opens the app to do
  { id: "/dashboard", icon: "home", label: "Dashboard", tier: "daily" },
  { id: "/transactions", icon: "txns", label: "Spending", tier: "daily" },
  // #207: People answers "what does this person owe me, in total?" — the
  // question Lending and Shared each answered half of. Both still exist below
  // for their specialist views (loan reports, groups, settlement history);
  // this is just the first place you look.
  { id: "/people", icon: "shared", label: "People", tier: "daily" },
  { id: "/cards", icon: "cards", label: "Cards", tier: "daily" },
  { id: "/bills", icon: "bills", label: "Bills", tier: "daily" },
  // weekly — checked, not lived in
  { id: "/lending", icon: "lending", label: "Lending", tier: "weekly" },
  { id: "/shared", icon: "shared", label: "Shared", tier: "weekly" },
  { id: "/budgets", icon: "budgets", label: "Budgets", tier: "weekly" },
  { id: "/accounts", icon: "accounts", label: "Accounts", tier: "weekly" },
  { id: "/analytics", icon: "analytics", label: "Insights", tier: "weekly" },
  // rare — errands and admin
  { id: "/import", icon: "import", label: "Import", tier: "rare" },
  { id: "/activity", icon: "activity", label: "Activity", tier: "rare" },
  { id: "/settings", icon: "settings", label: "Settings", tier: "rare" },
];

export const TIER_LABEL: Record<NavTier, string> = { daily: "Daily", weekly: "Weekly", rare: "Occasional" };

const ITEM_BY_ID = new Map(NAV_ITEMS.map((i) => [i.id, i]));

/** Core navigation that can never be hidden (smart safeguards). Quick Add (the
 *  FAB) is protected too, but it isn't a nav item — it's handled separately. */
export const PROTECTED = new Set(["/dashboard", "/settings"]);

export const MIN_TABS = 3;
export const MAX_TABS = 8;
export const DEFAULT_MAX_TABS = 6;

export interface NavPrefs {
  order: string[]; // ids in display order
  hidden: string[]; // ids the user has hidden (protected ids are ignored here)
  pinned: string[]; // ids the user pinned — always kept in the visible bar
  maxTabs: number; // how many slots the bottom bar shows before "More"
}

export const DEFAULT_PREFS: NavPrefs = {
  order: NAV_ITEMS.map((i) => i.id),
  // Nothing hidden by default — every module stays reachable (desktop sidebar
  // unchanged; the mobile bar just overflows into "More"). Users hide what they
  // don't use from Settings → Navigation.
  hidden: [],
  pinned: [],
  maxTabs: DEFAULT_MAX_TABS,
};

/** Merge a stored (possibly partial or stale) prefs blob onto the defaults, and
 *  sanitise it: drop unknown ids, re-append any brand-new modules at the end,
 *  never let a protected id sit in `hidden`, clamp maxTabs. */
export function normalizePrefs(raw: Partial<NavPrefs> | null | undefined): NavPrefs {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of raw?.order ?? DEFAULT_PREFS.order) {
    if (ITEM_BY_ID.has(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const it of NAV_ITEMS) if (!seen.has(it.id)) order.push(it.id); // new modules appear
  const hidden = (raw?.hidden ?? DEFAULT_PREFS.hidden).filter((id) => ITEM_BY_ID.has(id) && !PROTECTED.has(id));
  const pinned = (raw?.pinned ?? DEFAULT_PREFS.pinned).filter((id) => ITEM_BY_ID.has(id));
  const maxTabs = Math.min(MAX_TABS, Math.max(MIN_TABS, Math.round(raw?.maxTabs ?? DEFAULT_MAX_TABS)));
  return { order, hidden: [...new Set(hidden)], pinned: [...new Set(pinned)], maxTabs };
}

/** The items a user keeps in the navigation (not hidden; protected always kept),
 *  in display order. Pinned items float to the front so they're never pushed
 *  into "More"; Dashboard (home) always stays the very first tab. Protected
 *  items keep their natural position — Settings shouldn't jump to the front. */
export function shownItems(prefs: NavPrefs): NavItem[] {
  const p = normalizePrefs(prefs);
  const hidden = new Set(p.hidden);
  const pinned = new Set(p.pinned);
  const kept = p.order.filter((id) => PROTECTED.has(id) || !hidden.has(id));
  const floated = [...kept.filter((id) => pinned.has(id)), ...kept.filter((id) => !pinned.has(id))];
  const ordered = floated.includes("/dashboard") ? ["/dashboard", ...floated.filter((id) => id !== "/dashboard")] : floated;
  return ordered.map((id) => ITEM_BY_ID.get(id)!);
}

/** The user's hidden modules, in order — reachable only from "More". */
function hiddenItems(prefs: NavPrefs): NavItem[] {
  const p = normalizePrefs(prefs);
  const hidden = new Set(p.hidden);
  return p.order.filter((id) => hidden.has(id) && !PROTECTED.has(id)).map((id) => ITEM_BY_ID.get(id)!);
}

/**
 * Split navigation into the bottom bar and the "More" sheet. The bar shows the
 * first `maxTabs` kept items; anything beyond that AND every hidden module fold
 * into More (a hidden module is "still there, just under More" — the spec). When
 * a More button is needed it takes the last bar slot.
 */
export function bottomNav(prefs: NavPrefs): { visible: NavItem[]; more: NavItem[] } {
  const kept = shownItems(prefs);
  const hidden = hiddenItems(prefs);
  const max = normalizePrefs(prefs).maxTabs;
  const needsMore = kept.length > max || hidden.length > 0;
  if (!needsMore) return { visible: kept, more: [] };
  const slots = max - 1; // reserve the last slot for the More button
  return { visible: kept.slice(0, slots), more: [...kept.slice(slots), ...hidden] };
}

/** The desktop sidebar shows every kept item in order (it can scroll, so no
 *  overflow). Hidden modules stay out of the sidebar but remain reachable via
 *  the ⌘K command palette and Settings → Navigation. */
export function sidebarItems(prefs: NavPrefs): NavItem[] {
  return shownItems(prefs);
}

/** Move an item up or down in the order (Settings → Navigation reorder). */
export function reorder(order: string[], id: string, dir: -1 | 1): string[] {
  const idx = order.indexOf(id);
  if (idx < 0) return order;
  const to = idx + dir;
  if (to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[idx], next[to]] = [next[to], next[idx]];
  return next;
}
