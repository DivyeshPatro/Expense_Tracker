import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { cookies, headers } from "next/headers";
import { SwRegister } from "@/components/shell/sw-register";
import { ThemeSync } from "@/components/shell/theme-sync";
import { DEFAULT_MODE, DEFAULT_SKIN, isMode, isSkin, MODE_COOKIE, SKIN_COOKIE } from "@/lib/theme";
import "./globals.css";

// Runs before first paint: for System mode the server can't know the OS
// preference, so this resolves data-theme from matchMedia synchronously. For an
// explicit light/dark choice the server already painted it; this just re-affirms.
const THEME_BOOTSTRAP = `(function(){try{var c=document.cookie,el=document.documentElement,
m=(c.match(/ledgerly-theme=([^;]+)/)||[])[1]||'system',s=(c.match(/ledgerly-skin=([^;]+)/)||[])[1]||'indigo';
el.dataset.theme=(m==='light'||m==='dark')?m:(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
el.dataset.mode=m;el.dataset.skin=s;}catch(e){}})();`;

const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-schibsted",
});

export const metadata: Metadata = {
  title: "Ledgerly",
  description: "Personal finance & shared expense tracker",
  applicationName: "Ledgerly",
  manifest: "/manifest.webmanifest",
  // Home-screen install on iOS: standalone chrome + a real touch icon. Android
  // pulls its icons from the manifest.
  appleWebApp: { capable: true, title: "Ledgerly", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Let content flow under the notch / home indicator so the app's own
  // env(safe-area-inset-*) padding (nav, sheets) reads as native in standalone.
  viewportFit: "cover",
  // The live browser/status-bar chrome tracks the app ground in each theme, so
  // the toolbar reads as part of the app rather than a separate bar.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Mode + skin read server-side so SSR paints the right theme with no flash.
  // For System the concrete ground is resolved client-side (THEME_BOOTSTRAP);
  // the server default keeps SSR deterministic until then.
  const jar = await cookies();
  const modeRaw = jar.get(MODE_COOKIE)?.value;
  const mode = isMode(modeRaw) ? modeRaw : DEFAULT_MODE;
  const skin = isSkin(jar.get(SKIN_COOKIE)?.value) ? jar.get(SKIN_COOKIE)!.value : DEFAULT_SKIN;
  const serverTheme = mode === "dark" ? "dark" : "light";
  // The strict CSP is nonce-only (see middleware.ts); the bootstrap needs it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      data-theme={serverTheme}
      data-mode={mode}
      data-skin={skin}
      className={schibsted.variable}
      suppressHydrationWarning
    >
      <body>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
        <ThemeSync />
        <SwRegister />
      </body>
    </html>
  );
}
