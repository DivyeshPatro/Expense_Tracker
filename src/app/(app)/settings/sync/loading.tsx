// Shown instantly while the Sync Center RSC payload streams in.
export default function SyncCenterLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="skeleton h-[90px] rounded-[14px]" />
      <div className="card p-6 flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-[42px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}
