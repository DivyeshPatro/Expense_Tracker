// Shown instantly while the Cards RSC payload streams in.
export default function CardsLoading() {
  return (
    <div className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(290px,1fr))]">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="skeleton rounded-[16px] aspect-[1.586] min-h-[190px]" />
      ))}
    </div>
  );
}
