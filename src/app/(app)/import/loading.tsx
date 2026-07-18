// Shown instantly while the Import RSC payload streams in.
export default function ImportLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="skeleton h-9 w-[220px] rounded-lg" />
      <div className="card p-[var(--pad)] flex flex-col gap-3">
        <div className="skeleton h-[140px] rounded-[14px]" />
        <div className="skeleton h-9 w-[160px] rounded-lg self-end" />
      </div>
    </div>
  );
}
