// Counted nouns, so the app stops saying "1 accounts".
//
// English-only and deliberately so: Ledgerly ships one locale, and a full
// Intl.PluralRules setup would be machinery for a problem that doesn't exist
// yet. If a second language ever lands, this is the single place to change.

/** "1 account" / "3 accounts". Pass `plural` for irregular nouns. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Just the noun, when the number is rendered separately (e.g. in a big stat). */
export function pluralize(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}
