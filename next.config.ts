import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client"],
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
