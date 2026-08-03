import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// The landing page is the only crawlable, publicly meaningful URL.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE}/`, lastModified: new Date(), changeFrequency: "monthly", priority: 1 }];
}
