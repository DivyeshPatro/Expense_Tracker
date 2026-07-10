import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client"],
  experimental: {
    // import preview/commit round-trip full row sets (up to ~15MB source files)
    serverActions: { bodySizeLimit: "20mb" },
  },
};

export default nextConfig;
