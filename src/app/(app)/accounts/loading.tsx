// Shown instantly while the Accounts RSC payload streams in.
export default function AccountsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-3.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-[110px] flex-[1_1_220px] rounded-[14px]" />
        ))}
      </div>
      <div className="skeleton h-[180px] rounded-[14px]" />
    </div>
  );
}
