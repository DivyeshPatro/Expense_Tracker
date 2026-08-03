"use client";

// Settings → Navigation editor (v2.0). Reorder, show/hide and pin modules, and
// choose how many sit in the bottom bar before the rest fold into "More". Stored
// per device via useNavPrefs; every change updates the live bottom bar and the
// sidebar instantly. Dashboard and Settings are protected — always visible.

import { NavGlyph } from "@/components/shell/nav-glyph";
import { useNavPrefs } from "@/components/shell/use-nav-prefs";
import {
  bottomNav,
  MAX_TABS,
  MIN_TABS,
  NAV_ITEMS,
  PROTECTED,
  reorder,
  type NavPrefs,
} from "@/lib/nav-prefs";

const byId = new Map(NAV_ITEMS.map((i) => [i.id, i]));

export function NavEditor() {
  const { prefs, save, reset, ready } = useNavPrefs();
  if (!ready) return <div className="card p-[var(--pad)] text-[12.5px] text-mut2">Loading…</div>;

  const ordered = prefs.order.map((id) => byId.get(id)!).filter(Boolean);
  const hidden = new Set(prefs.hidden);
  const pinned = new Set(prefs.pinned);
  const { visible, more } = bottomNav(prefs);

  const patch = (p: Partial<NavPrefs>) => save({ ...prefs, ...p });
  const move = (id: string, dir: -1 | 1) => patch({ order: reorder(prefs.order, id, dir) });
  const toggleHidden = (id: string) => patch({ hidden: hidden.has(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id] });
  const togglePinned = (id: string) => patch({ pinned: pinned.has(id) ? prefs.pinned.filter((x) => x !== id) : [...prefs.pinned, id] });

  return (
    <div className="flex flex-col gap-3.5">
      {/* Live preview of the bottom bar */}
      <section className="card p-[var(--pad)]">
        <h2 className="text-[13.5px] font-bold m-0 mb-2">Your bottom bar</h2>
        <div className="flex items-stretch gap-1 rounded-[12px] border border-line2 p-1.5 bg-side">
          {visible.map((n) => (
            <span key={n.id} className="flex-1 flex flex-col items-center gap-1 py-1.5 text-mut2" style={{ color: "var(--acc)" }}>
              <NavGlyph id={n.icon} />
              <span className="text-[9px] font-semibold text-mut2">{n.label}</span>
            </span>
          ))}
          {more.length > 0 && (
            <span className="flex-1 flex flex-col items-center gap-1 py-1.5 text-mut2">
              <NavGlyph id="more" />
              <span className="text-[9px] font-semibold">More</span>
            </span>
          )}
        </div>
        <p className="text-[11.5px] text-mut2 mt-2">Hidden and overflow tabs are always reachable under <b>More</b>. The desktop sidebar follows the same order.</p>
      </section>

      {/* Max visible tabs */}
      <section className="card p-[var(--pad)] flex items-center justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-bold">Tabs in the bottom bar</div>
          <div className="text-[11.5px] text-mut2">The rest move under “More”.</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => patch({ maxTabs: prefs.maxTabs - 1 })}
            disabled={prefs.maxTabs <= MIN_TABS}
            aria-label="Fewer tabs"
            className="w-9 h-9 rounded-lg border border-line2 bg-card text-[18px] grid place-items-center cursor-pointer disabled:opacity-40"
          >
            −
          </button>
          <span className="w-6 text-center text-[15px] font-extrabold tabular-nums" aria-live="polite">{prefs.maxTabs}</span>
          <button
            onClick={() => patch({ maxTabs: prefs.maxTabs + 1 })}
            disabled={prefs.maxTabs >= MAX_TABS}
            aria-label="More tabs"
            className="w-9 h-9 rounded-lg border border-line2 bg-card text-[18px] grid place-items-center cursor-pointer disabled:opacity-40"
          >
            +
          </button>
        </div>
      </section>

      {/* Reorder / show-hide / pin list */}
      <section className="card p-[var(--pad)]">
        <h2 className="text-[13.5px] font-bold m-0 mb-1">Modules</h2>
        <p className="text-[11.5px] text-mut2 mb-2.5">Reorder, hide what you don’t use, and pin your favourites so they’re never behind “More”.</p>
        <ul className="flex flex-col list-none p-0 m-0">
          {ordered.map((n, i) => {
            const locked = PROTECTED.has(n.id);
            const isHidden = !locked && hidden.has(n.id);
            const isPinned = pinned.has(n.id);
            return (
              <li key={n.id} className="flex items-center gap-2 py-2 border-b border-line last:border-b-0">
                <span className="w-8 h-8 rounded-[9px] grid place-items-center flex-none" style={{ background: "var(--accSoft)", color: "var(--acc)", opacity: isHidden ? 0.4 : 1 }}>
                  <NavGlyph id={n.icon} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="text-[13.5px] font-semibold" style={{ opacity: isHidden ? 0.5 : 1 }}>{n.label}</span>
                  {locked && <span className="text-[10.5px] text-mut2 ml-1.5">· always on</span>}
                  {isPinned && !locked && <span className="text-[10px] font-bold text-acc ml-1.5">PINNED</span>}
                </span>
                {/* reorder */}
                <div className="flex flex-none">
                  <button onClick={() => move(n.id, -1)} disabled={i === 0} aria-label={`Move ${n.label} up`} className="w-9 h-9 grid place-items-center rounded-md text-mut2 bg-transparent border-none cursor-pointer hover:bg-accsoft disabled:opacity-30">▲</button>
                  <button onClick={() => move(n.id, 1)} disabled={i === ordered.length - 1} aria-label={`Move ${n.label} down`} className="w-9 h-9 grid place-items-center rounded-md text-mut2 bg-transparent border-none cursor-pointer hover:bg-accsoft disabled:opacity-30">▼</button>
                </div>
                {/* pin */}
                <button
                  onClick={() => togglePinned(n.id)}
                  aria-pressed={isPinned}
                  aria-label={isPinned ? `Unpin ${n.label}` : `Pin ${n.label}`}
                  title={isPinned ? "Unpin" : "Always show (pin)"}
                  className="w-9 h-9 grid place-items-center rounded-md bg-transparent border-none cursor-pointer flex-none text-[15px]"
                  style={{ color: isPinned ? "var(--acc)" : "var(--mut2)" }}
                >
                  {isPinned ? "★" : "☆"}
                </button>
                {/* show / hide */}
                <button
                  onClick={() => !locked && toggleHidden(n.id)}
                  disabled={locked}
                  role="switch"
                  aria-checked={!isHidden}
                  aria-label={`${isHidden ? "Show" : "Hide"} ${n.label}`}
                  className="flex-none w-[42px] h-[24px] rounded-full relative transition-colors disabled:opacity-40 cursor-pointer border-none"
                  style={{ background: !isHidden ? "var(--acc)" : "var(--line2)" }}
                >
                  <span className="absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all" style={{ left: !isHidden ? "21px" : "3px" }} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <button onClick={reset} className="self-start text-[12.5px] font-semibold text-acc bg-transparent border border-line2 rounded-lg px-3.5 py-2 cursor-pointer hover:bg-accsoft">
        Reset to default
      </button>
    </div>
  );
}
