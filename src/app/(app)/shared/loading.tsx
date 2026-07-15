// Shown instantly while the Shared RSC payload streams in.
export default function SharedLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-3.5">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="skeleton h-[80px] flex-[1_1_160px] rounded-[14px]" />
        ))}
      </div>
      <div className="skeleton h-[220px] rounded-[14px]" />
    </div>
  );
}
