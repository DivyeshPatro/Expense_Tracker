// Clean line icons for navigation (keys match lib/nav-prefs NAV_ITEMS). Kept in
// its own tiny module so the Settings → Navigation editor can reuse it without
// pulling in the whole app-shell.

export function NavGlyph({ id }: { id: string }) {
  const p: Record<string, React.ReactNode> = {
    home: <path d="M3 11l9-8 9 8M5 10v10h14V10" />,
    txns: <path d="M4 6h16M4 12h16M4 18h10" />,
    lending: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M17 5a3 3 0 0 1 0 6" /></>,
    accounts: <path d="M4 10h16M4 10l8-6 8 6M6 10v9M18 10v9M4 19h16" />,
    cards: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></>,
    budgets: <><circle cx="12" cy="12" r="9" /><path d="M12 12V4M12 12l5 3" /></>,
    bills: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
    shared: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M2 20a6 6 0 0 1 12 0M15 15a5 5 0 0 1 6 5" /></>,
    activity: <path d="M22 12h-4l-3 8L9 4l-3 8H2" />,
    import: <path d="M12 3v12M8 11l4 4 4-4M4 21h16" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M3 12h2.5M18.5 12H21M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
    analytics: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
    more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  };
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[id]}
    </svg>
  );
}
