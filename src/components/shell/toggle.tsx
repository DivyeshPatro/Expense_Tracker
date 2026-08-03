// The switch track+thumb used by the Dashboard "Customize" sheet and the
// split-expense toggle. Purely presentational (aria-hidden): the caller wraps
// it in the interactive control that owns role="switch"/aria-checked, so the
// same visual works inside a button, a label, or a row.

export function Toggle({ on }: { on: boolean }) {
  return (
    <span className="w-[42px] h-[25px] rounded-full flex-none relative transition-colors" style={{ background: on ? "var(--acc)" : "var(--line2)" }} aria-hidden>
      <span className="absolute top-[3px] w-[19px] h-[19px] rounded-full bg-white transition-all" style={{ left: on ? "20px" : "3px", boxShadow: "var(--sh)" }} />
    </span>
  );
}
