// Source detection + column resolution — both generic over adapters.

import { norm } from "../detect-columns";
import { LENDING_ADAPTERS } from "./adapters";
import type { LendingHeaderAliases, LendingSourceAdapter, ResolvedColumns } from "./types";

/** Confidence at or above this is treated as auto-detected; below it the UI asks. */
export const LENDING_DETECT_THRESHOLD = 0.6;

export interface LendingDetection {
  adapter: LendingSourceAdapter;
  confidence: number;
  /** True when confidence clears the threshold — otherwise offer a manual choice. */
  auto: boolean;
}

/** Best-scoring adapter for these headers, or null if none scores above zero. */
export function detectLendingSource(headers: string[]): LendingDetection | null {
  let best: LendingDetection | null = null;
  for (const adapter of LENDING_ADAPTERS) {
    const confidence = adapter.detect ? adapter.detect(headers) : genericConfidence(headers, adapter.aliases);
    if (confidence > 0 && (!best || confidence > best.confidence)) {
      best = { adapter, confidence, auto: confidence >= LENDING_DETECT_THRESHOLD };
    }
  }
  return best;
}

/** Fallback score for adapters without their own detect(): fraction of required fields present. */
function genericConfidence(headers: string[], aliases: LendingHeaderAliases): number {
  const set = new Set(headers.map(norm));
  const has = (syns?: string[]) => !!syns && syns.some((s) => set.has(s));
  const hasContact = has(aliases.contact);
  const hasDate = has(aliases.date);
  const hasDirection = (has(aliases.gave) && has(aliases.got)) || (has(aliases.amount) && has(aliases.type));
  if (!hasContact || !hasDirection) return 0;
  return hasDate ? 0.9 : 0.7;
}

/** Finds the actual header for one canonical field: exact norm match first, then substring. */
function findHeader(headers: string[], synonyms: string[] | undefined, used: Set<string>): string | undefined {
  if (!synonyms) return undefined;
  for (const h of headers) {
    if (used.has(h)) continue;
    if (synonyms.includes(norm(h))) return h;
  }
  for (const h of headers) {
    if (used.has(h)) continue;
    const n = norm(h);
    if (synonyms.some((s) => n.includes(s))) return h;
  }
  return undefined;
}

/**
 * Resolves an adapter's aliases against actual headers, once per file (so row
 * extraction never re-scans headers — a 10k-row import resolves columns a
 * single time). Returns null when the mandatory columns — a contact, a date,
 * and some direction source — can't be found.
 */
export function resolveColumns(headers: string[], adapter: LendingSourceAdapter): ResolvedColumns | null {
  const used = new Set<string>();
  const take = (field: keyof LendingHeaderAliases): string | undefined => {
    const h = findHeader(headers, adapter.aliases[field], used);
    if (h) used.add(h);
    return h;
  };

  const contact = take("contact");
  const date = take("date");
  const gave = take("gave");
  const got = take("got");
  const amount = take("amount");
  const type = take("type");
  const note = take("note");
  const balance = take("balance");

  if (!contact || !date) return null;
  const hasDirection = (gave && got) || (amount && type) || gave || got;
  if (!hasDirection) return null;

  return { contact, date, gave, got, amount, type, note, balance };
}
