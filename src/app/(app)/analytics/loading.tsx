// Shown instantly while the Analytics RSC payload streams in.
export default function AnalyticsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-3.5">
        <div className="skeleton h-[76px] flex-[1_1_160px] rounded-[14px]" />
        <div className="skeleton h-[76px] flex-[1_1_160px] rounded-[14px]" />
        <div className="skeleton h-[76px] flex-[1_1_160px] rounded-[14px]" />
      </div>
      <div className="skeleton h-9 w-full md:hidden rounded-[9px]" />
      <div className="flex flex-wrap gap-3.5">
        <div className="skeleton h-[220px] flex-[1.4_1_320px] rounded-[14px]" />
        <div className="skeleton h-[220px] flex-[1.4_1_320px] rounded-[14px] hidden md:block" />
        <div className="skeleton h-[220px] flex-[1_1_280px] rounded-[14px] hidden md:block" />
        <div className="skeleton h-[220px] flex-[1_1_240px] rounded-[14px] hidden md:block" />
      </div>
    </div>
  );
}
