// #204: Settings was nine sections stacked into 3.39 screens of scroll with 37
// sub-44px targets and no search — everything at once, nothing findable.
//
// It is now a grouped index: seven rows, each a 44px-tall link into its own
// sub-page. Server component, no JS. The rows below are the whole first screen.

import Link from "next/link";

export interface SettingsGroup {
  href: string;
  label: string;
  detail: string;
  icon: React.ReactNode;
  /** Optional live status shown on the right, e.g. "Synced". */
  status?: React.ReactNode;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const Icon = ({ d }: { d: string }) => (
  <svg width="19" height="19" viewBox="0 0 24 24" {...stroke} aria-hidden>
    <path d={d} />
  </svg>
);

export const SETTINGS_ICONS = {
  general: <Icon d="M12 3v2.5M12 18.5V21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M3 12h2.5M18.5 12H21M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />,
  appearance: <Icon d="M12 3a9 9 0 1 0 9 9c0-1-3 1-5-1s0-5-1-6-2-2-3-2z" />,
  dashboard: <Icon d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" />,
  navigation: <Icon d="M4 6h16M4 12h10M4 18h7" />,
  security: <Icon d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />,
  backup: <Icon d="M12 3v12M8 11l4 4 4-4M4 21h16" />,
  developer: <Icon d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" />,
};

export function SettingsIndex({ groups }: { groups: SettingsGroup[] }) {
  return (
    <nav className="flex flex-col gap-1 rounded-[14px] border border-line bg-card overflow-hidden" aria-label="Settings sections">
      {groups.map((g, i) => (
        <Link
          key={g.href}
          href={g.href}
          className={`flex items-center gap-3 px-4 min-h-[56px] no-underline text-ink hover:bg-accsoft focus-visible:outline-2 focus-visible:outline-acc ${
            i > 0 ? "border-t border-line" : ""
          }`}
        >
          <span className="w-9 h-9 rounded-[10px] grid place-items-center bg-accsoft text-acc flex-none">{g.icon}</span>
          <span className="flex-1 min-w-0">
            <span className="block text-[13.5px] font-bold">{g.label}</span>
            <span className="block text-[11.5px] text-mut truncate">{g.detail}</span>
          </span>
          {g.status && <span className="text-[11.5px] font-semibold text-mut2 flex-none">{g.status}</span>}
          <span aria-hidden className="text-mut2 text-[13px] flex-none">›</span>
        </Link>
      ))}
    </nav>
  );
}

/** Shared chrome for every settings sub-page: back link + title. */
export function SettingsSubPage({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 max-w-[640px]" style={{ animation: "rise .25s ease" }}>
      <div className="flex items-center gap-2.5">
        <Link
          href="/settings"
          aria-label="Back to Settings"
          className="w-11 h-11 rounded-[11px] grid place-items-center text-mut cursor-pointer bg-card border border-line2 hover:bg-accsoft flex-none no-underline"
        >
          ←
        </Link>
        <div>
          <h1 className="text-[21px] font-extrabold tracking-[-.02em] m-0">{title}</h1>
          {detail && <p className="text-[12.5px] text-mut mt-0.5 mb-0">{detail}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}
