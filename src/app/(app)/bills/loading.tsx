// Shown instantly while the Bills RSC payload streams in.
export default function BillsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="card px-4 py-2 flex flex-col gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-[58px] rounded-[10px]" />
        ))}
      </div>
    </div>
  );
}
