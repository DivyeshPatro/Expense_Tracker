"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="print:hidden px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer hover:bg-accsoft"
    >
      🖨 Print / Save as PDF
    </button>
  );
}
