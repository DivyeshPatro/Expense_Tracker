// Shown instantly while the Analytics RSC payload streams in.
export default function AnalyticsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="skeleton h-6 w-40" />
      <div className="skeleton h-[220px] rounded-[14px]" />
      <div className="flex flex-wrap gap-3.5">
        <div className="skeleton h-[240px] flex-[1.2_1_300px] rounded-[14px]" />
        <div className="skeleton h-[240px] flex-[1_1_260px] rounded-[14px]" />
      </div>
    </div>
  );
}
