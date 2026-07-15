// Shown instantly while the Transactions RSC payload streams in.
export default function TransactionsLoading() {
  return (
    <div className="flex flex-col gap-3">
      <div className="skeleton h-9 w-full max-w-[420px]" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton h-[52px] rounded-[10px]" />
        ))}
      </div>
    </div>
  );
}
