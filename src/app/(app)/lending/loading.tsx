// Shown instantly while the Lending RSC payload streams in.
export default function LendingLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="skeleton h-4 w-[280px] rounded" />
        <div className="flex gap-2">
          <div className="skeleton h-9 w-[104px] rounded-lg" />
          <div className="skeleton h-9 w-[100px] rounded-lg" />
        </div>
      </div>
      <div className="md:hidden skeleton h-9 w-full rounded-[9px]" />
      <div className="flex flex-wrap gap-3.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-[76px] flex-[1_1_160px] rounded-[14px]" />
        ))}
      </div>
      <div className="flex flex-wrap gap-3.5 items-start">
        <div className="skeleton h-[260px] flex-[1_1_320px] rounded-[14px]" />
        <div className="skeleton h-[260px] flex-[1.3_1_320px] rounded-[14px]" />
      </div>
    </div>
  );
}
