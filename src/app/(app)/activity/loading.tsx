// Shown instantly while the Activity RSC payload streams in.
export default function ActivityLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="skeleton h-9 w-[320px] max-w-full rounded-[9px]" />
      <div className="skeleton h-4 w-16" />
      <div className="skeleton h-[260px] rounded-[14px]" />
      <div className="skeleton h-4 w-20" />
      <div className="skeleton h-[180px] rounded-[14px]" />
    </div>
  );
}
