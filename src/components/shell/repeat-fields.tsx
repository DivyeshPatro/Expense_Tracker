"use client";

// The shape of a schedule — cadence, interval, start and optional end — shared
// by the "Repeat this" block on the create forms and the edit form in Settings,
// so the two places a user describes a recurrence can't drift apart.

import { DateField } from "./date-field";
import { Field } from "./form-primitives";

export const CADENCES = [
  { value: "DAILY", label: "Day" },
  { value: "WEEKLY", label: "Week" },
  { value: "MONTHLY", label: "Month" },
  { value: "QUARTERLY", label: "Quarter" },
  { value: "YEARLY", label: "Year" },
] as const;

export type Cadence = (typeof CADENCES)[number]["value"];

/** "Every month" / "Every 2 weeks" — the plural only appears when it's needed. */
export function cadenceLabel(cadence: Cadence, interval: number): string {
  const unit = CADENCES.find((c) => c.value === cadence)?.label.toLowerCase() ?? "month";
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

export function RepeatFields({
  cadence,
  setCadence,
  interval,
  setInterval,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  startLabel = "STARTS",
  hideStart = false,
}: {
  cadence: Cadence;
  setCadence: (v: Cadence) => void;
  interval: string;
  setInterval: (v: string) => void;
  startDate: string;
  setStartDate: (v: string) => void;
  endDate: string;
  setEndDate: (v: string) => void;
  startLabel?: string;
  /** For the create forms, where the start is derived from the transaction date. */
  hideStart?: boolean;
}) {
  return (
    <div className="flex gap-2.5 flex-wrap items-end">
      <Field label="REPEAT EVERY">
        <div className="flex gap-2">
          <input
            className="field !w-[70px]"
            inputMode="numeric"
            value={interval}
            onChange={(e) => setInterval(e.target.value.replace(/\D/g, ""))}
            aria-label="Repeat interval"
          />
          <select className="field" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} aria-label="Repeat unit">
            {CADENCES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
                {Number(interval) > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </div>
      </Field>
      {!hideStart && (
        <Field label={startLabel}>
          <DateField value={startDate} onChange={setStartDate} />
        </Field>
      )}
      <Field label="ENDS (OPTIONAL)">
        <div className="flex items-center gap-2">
          <DateField value={endDate} onChange={setEndDate} min={startDate} />
          {endDate && (
            <button
              type="button"
              onClick={() => setEndDate("")}
              className="text-[11.5px] font-semibold text-mut2 bg-transparent border-none cursor-pointer hover:text-ink flex-none"
            >
              Clear
            </button>
          )}
        </div>
      </Field>
    </div>
  );
}
