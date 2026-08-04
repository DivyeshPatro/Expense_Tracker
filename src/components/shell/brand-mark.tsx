// Ledgerly logo — the in-app face of the brand mark defined in lib/brand-mark.
//
// <BrandMark> is the gradient app-icon tile (header, sidebar, auth). <BrandMark>
// and the PWA icons share the same geometry, so what's on the home screen and
// what's in the header are the same logo. <BrandLockup> pairs a monochrome glyph
// with the wordmark for headers that want the name too.

import { brandGlyphPaths, brandMarkSvg } from "@/lib/brand-mark";

/** The gradient tile icon. `rounded` picks the corner radius; the header/sidebar
 *  want a soft square, so the default matches the app's control radius feel. */
export function BrandMark({ size = 28, radius = 0.28, className }: { size?: number; radius?: number; className?: string }) {
  // A DETERMINISTIC gradient id, derived from the props, so the SSR markup and
  // the hydrated markup match byte-for-byte. A module-level counter drifts — the
  // long-lived server keeps incrementing it across requests while a fresh client
  // starts at 0 — which surfaced as a hydration mismatch. The gradient itself is
  // identical for every instance (objectBoundingBox units, brand colours only),
  // so if two same-size marks share an id the render is still correct; BrandMark
  // must stay renderable from zero-JS server pages, so useId() isn't an option.
  const id = `${size}-${Math.round(radius * 1000)}`;
  return (
    <span
      className={className}
      style={{ display: "inline-flex", width: size, height: size, lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: brandMarkSvg({ size, radius, id }) }}
    />
  );
}

/** The monochrome glyph alone, painting in currentColor — for lockups and print. */
export function BrandGlyph({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: brandGlyphPaths("currentColor") }}
    />
  );
}

/** Mark + wordmark. Used where the product name belongs beside the logo. */
export function BrandLockup({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <BrandMark size={size} />
      <span className="font-extrabold tracking-tight" style={{ fontSize: size * 0.56 }}>
        Ledgerly
      </span>
    </span>
  );
}
