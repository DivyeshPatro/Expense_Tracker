import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Only the public landing is meant for crawlers; every app route is behind auth
// and has nothing useful (or safe) to index.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/dashboard", "/transactions", "/lending", "/shared", "/cards", "/budgets", "/bills", "/accounts", "/analytics", "/activity", "/import", "/settings", "/api/"] },
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
