// One shared empty-state shape for the whole app (originated in Lending
// Phase 1.5, promoted app-wide in Phase 2.5's consistency sweep) — every
// empty screen should say something specific and actionable, never just
// render nothing. role="status" so screen readers announce the state.

export function EmptyState({
  icon,
  title,
  detail,
  compact,
}: {
  icon: string;
  title: string;
  detail?: string;
  compact?: boolean;
}) {
  return (
    <div className={`text-center ${compact ? "py-6" : "py-10"} px-4`} role="status">
      <div className="text-[26px] mb-1.5" aria-hidden="true">{icon}</div>
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      {detail && <div className="text-[12px] text-mut2 mt-1">{detail}</div>}
    </div>
  );
}
