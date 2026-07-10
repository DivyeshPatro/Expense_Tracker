import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-schibsted",
});

export const metadata: Metadata = {
  title: "Ledgerly",
  description: "Personal finance & shared expense tracker",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // theme cookie read server-side so SSR paints the right theme (no flash)
  const theme = (await cookies()).get("ledgerly-theme")?.value === "dark" ? "dark" : "light";
  return (
    <html lang="en" data-theme={theme} className={schibsted.variable}>
      <body>{children}</body>
    </html>
  );
}
