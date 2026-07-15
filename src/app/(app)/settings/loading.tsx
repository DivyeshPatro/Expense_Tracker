// Shown instantly while the Settings RSC payload streams in.
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-4 max-w-[640px]">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="skeleton h-[120px] rounded-[14px]" />
      ))}
    </div>
  );
}
