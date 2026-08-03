// The Ledgerly brand mark — one source of truth for the logo.
//
// The mark is an "L" (Ledgerly) whose spine and baseline frame three ascending
// bars: a ledger that grows. It's currency-neutral (works beyond ₹), reads at
// 16px, and is drawn on a 100×100 grid so it scales cleanly to any size.
//
// Both the in-app <BrandMark> React component and the PWA icon rasteriser build
// from these same primitives, so the logo in the header and the icon on the
// home screen can never drift apart.

export const BRAND = {
  /** Accent gradient stops — the tile background. */
  from: "#3b73ff",
  to: "#1b3fd1",
  /** The glyph, on the tile. */
  fg: "#ffffff",
  /** Page/manifest colours. */
  themeColor: "#2a63f6",
  backgroundColor: "#f6f7f9",
} as const;

/**
 * The glyph alone (the white "L + rising ledger"), as SVG markup on a 100×100
 * grid. No tile, no colour baked in — the caller sets `fill`. Kept as pure
 * geometry so it can sit on a gradient tile (icon) or paint in currentColor
 * (a monochrome inline lockup).
 */
export function brandGlyphPaths(fill: string): string {
  return [
    // L spine
    `<rect x="24" y="23" width="13" height="54" rx="6.5" fill="${fill}"/>`,
    // L baseline
    `<rect x="24" y="64" width="55" height="13" rx="6.5" fill="${fill}"/>`,
    // three ascending bars resting on the baseline — the ledger that grows
    `<rect x="43" y="50" width="9" height="14" rx="4.5" fill="${fill}"/>`,
    `<rect x="56" y="41" width="9" height="23" rx="4.5" fill="${fill}"/>`,
    `<rect x="69" y="31" width="9" height="33" rx="4.5" fill="${fill}"/>`,
  ].join("");
}

interface MarkOptions {
  /** Rendered pixel size (width = height). */
  size?: number;
  /** Corner radius as a fraction of size. iOS/Android mask their own corners,
   *  so maskable icons pass 0 (square, full-bleed) and let the OS clip. */
  radius?: number;
  /** Full-bleed padding as a fraction of size — the maskable "safe area". */
  padding?: number;
  /** Unique suffix so multiple inline marks don't share a gradient id. */
  id?: string;
}

/** The full mark: gradient tile + glyph, as a standalone `<svg>` string. */
export function brandMarkSvg({ size = 512, radius = 0.22, padding = 0, id = "bm" }: MarkOptions = {}): string {
  const gid = `grad-${id}`;
  const r = Math.round(size * radius);
  // Glyph sits on a 100-grid; padding shrinks and centres it inside the tile.
  const inset = size * padding;
  const glyphSize = size - inset * 2;
  const scale = glyphSize / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${BRAND.from}"/><stop offset="1" stop-color="${BRAND.to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${size}" height="${size}" rx="${r}" fill="url(#${gid})"/>` +
    // soft top-right highlight so the tile reads as a physical app icon
    `<rect width="${size}" height="${size}" rx="${r}" fill="url(#hl-${id})"/>` +
    `<defs><radialGradient id="hl-${id}" cx="0.82" cy="-0.1" r="0.9">` +
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0"/>` +
    `</radialGradient></defs>` +
    `<g transform="translate(${inset} ${inset}) scale(${scale})">${brandGlyphPaths(BRAND.fg)}</g>` +
    `</svg>`;
}
