// Shown instantly while the Dashboard RSC payload streams in (route-level
// Suspense fallback). Mirrors the real page's block shapes so nothing jumps
// when the actual content swaps in.
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="skeleton h-6 w-48" />
      <div className="skeleton h-8 w-40 rounded-full md:hidden" />
      <div className="flex flex-wrap gap-3.5">
        <div className="skeleton h-[110px] flex-[1.5_1_250px] rounded-[14px]" />
        <div className="skeleton h-[110px] flex-[1_1_150px] rounded-[14px] hidden md:block" />
        <div className="skeleton h-[110px] flex-[1_1_150px] rounded-[14px] hidden md:block" />
        <div className="skeleton h-[110px] flex-[1_1_150px] rounded-[14px]" />
      </div>
      <div className="hidden md:flex flex-wrap gap-3.5">
        <div className="skeleton h-[220px] flex-[1.6_1_320px] rounded-[14px]" />
        <div className="skeleton h-[220px] flex-[1_1_260px] rounded-[14px]" />
      </div>
      <div className="hidden md:flex flex-wrap gap-3.5">
        <div className="skeleton h-[180px] flex-[1.1_1_280px] rounded-[14px]" />
        <div className="skeleton h-[180px] flex-[1_1_250px] rounded-[14px]" />
        <div className="skeleton h-[180px] flex-[1_1_250px] rounded-[14px]" />
      </div>
      <div className="flex flex-wrap gap-3.5">
        <div className="skeleton h-[220px] flex-[1.6_1_340px] rounded-[14px]" />
        <div className="skeleton h-[220px] flex-[1_1_280px] rounded-[14px] hidden md:block" />
      </div>
    </div>
  );
}
