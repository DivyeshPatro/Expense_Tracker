// One shared empty-state shape for the whole app (originated in Lending
// Phase 1.5, promoted app-wide in Phase 2.5's consistency sweep) — every
// empty screen should say something specific and actionable, never just
// render nothing. role="status" so screen readers announce the state.

export function EmptyState({
  icon,
  title,
  detail,
  compact,
  action,
}: {
  icon: string;
  title: string;
  detail?: string;
  compact?: boolean;
  /** An optional call-to-action (usually a button) that teaches the next step. */
  action?: React.ReactNode;
}) {
  return (
    // EPIC 14 (#189, #191): the icon used to render at 26px against a 13px
    // title — decoration twice the size of the information, which made a bare
    // 💳 or 📄 the largest element on Cards and Import. The title now leads and
    // the glyph is a quiet mark above it.
    <div className={`text-center ${compact ? "py-6" : "py-10"} px-4`} role="status">
      <div className="w-9 h-9 rounded-full grid place-items-center mx-auto mb-2.5 text-[15px] bg-accsoft" aria-hidden="true">
        {icon}
      </div>
      <div className="text-[17px] font-bold text-ink tracking-[-.01em]" style={{ textWrap: "balance" }}>{title}</div>
      {detail && <div className="text-[12.5px] text-mut mt-1.5 max-w-[42ch] mx-auto">{detail}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
