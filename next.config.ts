import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client"],
  // dev-only: newer Next 15.x points added a persistent floating dev-tools
  // badge that sits over the mobile bottom-nav's bottom-left corner and
  // intercepts pointer events there — breaks nothing at runtime (dev-only,
  // never built into production), but makes real elements unclickable
  // underneath it during e2e runs against `next dev`.
  devIndicators: false,
  experimental: {
    // import preview/commit round-trip full row sets (up to ~15MB source files)
    serverActions: { bodySizeLimit: "20mb" },
    // Let the client router serve a just-visited dynamic page from its own
    // cache for 30s instead of refetching the full RSC payload on every tab
    // tap — this is what makes returning to Dashboard/Transactions feel
    // instant. In-app mutations still show fresh data immediately: every
    // action calls revalidatePath and the detail sheet calls router.refresh(),
    // both of which purge this cache. (This is NOT route prefetching — the
    // previously-benchmarked prefetch regression is unaffected.)
    staleTimes: { dynamic: 30 },
  },
};

export default nextConfig;
