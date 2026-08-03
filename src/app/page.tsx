import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { Landing } from "./landing";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const TITLE = "Ledgerly — Self-hosted personal finance & shared expenses";
const DESCRIPTION =
  "Track spending, lending, shared expenses, credit cards, bills and budgets in one offline-first app you host yourself. Rupee-native, privacy-first, built for India.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Ledgerly",
  keywords: ["personal finance", "expense tracker", "shared expenses", "split expenses", "khatabook", "self-hosted", "PWA", "budgets", "India", "UPI"],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Ledgerly",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Ledgerly — all your money, one honest ledger" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Ledgerly",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web, Android, iOS (PWA)",
  description: DESCRIPTION,
  offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
  featureList: [
    "Expense tracking",
    "Khatabook-style lending",
    "Shared expenses with smart settlements",
    "Encrypted credit card vault",
    "Bills and budgets",
    "Analytics",
    "Import center",
    "Audit log",
    "Offline-ready PWA",
    "Self-hosted",
  ],
};

export default async function Home() {
  const session = await getSession();
  // Signed-in users go straight to the app — behaviour unchanged.
  if (session) redirect("/dashboard");

  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      <Landing />
    </>
  );
}
