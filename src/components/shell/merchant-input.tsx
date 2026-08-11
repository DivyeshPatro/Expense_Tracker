"use client";

// Merchant field with recall. Typing a merchant you've used before fills in the
// category and account you used last time, so the common case ("Swiggy, ₹420")
// is two fields and Save.
//
// The recall itself is not new — expense.create already reads MerchantRule to
// auto-categorise, and upserts that rule whenever a category is chosen
// explicitly. What was missing was the merchant ever being typed: the field
// lived inside collapsed "More details", so the self-improving loop rarely got
// a chance to run. This surfaces it, and shows what it inferred rather than
// silently applying it.
//
// A native <datalist> rather than a custom dropdown: it renders as the
// platform's own suggestion UI, sits above the on-screen keyboard because the
// browser owns it, and is keyboard- and screen-reader-operable for free.

import { useEffect, useRef, useState } from "react";
import { merchantSuggestionsAction } from "@/app/actions";
import type { MerchantSuggestion } from "@/server/services/transactions";

export function MerchantInput({
  value,
  onChange,
  onRecognized,
  placeholder = "e.g. Swiggy",
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called when the typed merchant matches one used before. */
  onRecognized: (s: MerchantSuggestion) => void;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<MerchantSuggestion[]>([]);
  const [recognized, setRecognized] = useState<string | null>(null);
  const listId = useRef(`merchants-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    let alive = true;
    // On open, not in the layout: the layout runs on every navigation and this
    // is only ever needed once a form is actually in front of someone.
    merchantSuggestionsAction()
      .then((s) => {
        if (alive) setSuggestions(s);
      })
      .catch(() => {
        // Autocomplete is an accelerant, not a dependency — a failed fetch
        // leaves a perfectly ordinary text field.
      });
    return () => {
      alive = false;
    };
  }, []);

  function apply(next: string) {
    onChange(next);
    const hit = suggestions.find((s) => s.merchant.toLowerCase().trim() === next.toLowerCase().trim());
    if (hit) {
      onRecognized(hit);
      setRecognized(hit.merchant);
    } else {
      setRecognized(null);
    }
  }

  return (
    <>
      <input
        className="field"
        value={value}
        onChange={(e) => apply(e.target.value)}
        list={listId}
        placeholder={placeholder}
        // Merchant names are proper nouns; the browser's own autofill has
        // nothing useful here and only competes with the datalist.
        autoComplete="off"
        enterKeyHint="done"
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.merchant} value={s.merchant} />
        ))}
      </datalist>
      {/* Say what was inferred. Silently changing a category the user can't see
          is how an expense ends up filed somewhere they never chose. */}
      {recognized && (
        <div role="status" aria-live="polite" className="text-[11.5px] text-mut2 mt-1">
          Filled category and account from your last {recognized} expense.
        </div>
      )}
    </>
  );
}
