// Ledgerly landing page (v2.0). Anonymous first impression — a zero-JS server
// component: native <details> for the FAQ, lazy <img> for screenshots, all
// styling from the app's own design tokens so it's theme-aware for free.
// Logged-in users never reach it (page.tsx redirects them to /dashboard).

import Link from "next/link";
import { BrandMark } from "@/components/shell/brand-mark";

const GITHUB = "https://github.com/DivyeshPatro/Expense_Tracker";
const VERSION = "2.0";

const FEATURES: { icon: string; title: string; desc: string }[] = [
  { icon: "wallet", title: "Expense tracking", desc: "Every rupee in, out, or moved — categorised, searchable, and reconciled across accounts." },
  { icon: "hand", title: "Lending — Khatabook style", desc: "A running ledger per contact: You Gave / You Got, running balance, and shareable statements." },
  { icon: "users", title: "Shared expenses", desc: "Group-first splitting with smart settlement suggestions — only the payments you actually need." },
  { icon: "card", title: "Credit card vault", desc: "Save cards once, reveal behind your password, and a 60-second checkout helper. Details stay encrypted." },
  { icon: "bill", title: "Bills", desc: "Recurring bills with due-date reminders, so nothing quietly slips past its deadline." },
  { icon: "gauge", title: "Budgets", desc: "Monthly limits per category with live progress and over-limit alerts." },
  { icon: "chart", title: "Analytics", desc: "Spending by category, top merchants, and trends — every chart follows your selected period." },
  { icon: "import", title: "Import center", desc: "Bring history in from spreadsheets and Khatabook, with duplicate detection built in." },
  { icon: "activity", title: "Audit log", desc: "A plain-English trail of every change to your money, scoped per module." },
  { icon: "offline", title: "Offline-ready PWA", desc: "Install it, use it on the metro with no signal — changes sync when you're back online." },
  { icon: "server", title: "Self-hosted", desc: "Run it on your own server. One codebase, your database, your rules." },
];

const WHY: { title: string; desc: string }[] = [
  { title: "Your data stays yours", desc: "Self-hosted on infrastructure you control — no third party sits between you and your finances." },
  { title: "No ads, no subscriptions", desc: "It's your instance. There's nothing to upsell and no one monetising your spending." },
  { title: "Works offline", desc: "An offline-first PWA: record on the spot, sync later. The network is optional, not required." },
  { title: "Built for India", desc: "Rupee-native, IST-correct, with a Khatabook-style lending ledger and UPI settlements." },
  { title: "One system, not five apps", desc: "Spending, lending, splitting, cards, bills and budgets share one schema — no juggling." },
  { title: "A modern mobile experience", desc: "Keyboard-aware forms, bottom sheets, a one-handed layout — it feels native on a phone." },
];

const SCREENS: { src: string; label: string }[] = [
  { src: "/screens/dashboard.webp", label: "Dashboard" },
  { src: "/screens/spending.webp", label: "Spending" },
  { src: "/screens/lending.webp", label: "Lending" },
  { src: "/screens/shared.webp", label: "Shared" },
  { src: "/screens/cards.webp", label: "Cards" },
  { src: "/screens/analytics.webp", label: "Analytics" },
];

const TRUST = ["Self-hosted", "Source-available", "Privacy-first", "Offline PWA", "Accessibility (WCAG AA)", "End-to-end tested"];
const TECH = ["Next.js", "PostgreSQL", "Prisma", "Better Auth"];
const ROADMAP = [
  { title: "OCR receipts", desc: "Snap a receipt, get the expense." },
  { title: "AI insights", desc: "Plain-language answers about your money." },
  { title: "OkCredit import", desc: "Bring another khata across." },
  { title: "Bank statement import", desc: "Reconcile straight from statements." },
];
const FAQ: { q: string; a: string }[] = [
  { q: "Can I self-host it?", a: "Yes — that's the point. Ledgerly runs on Next.js with a PostgreSQL database you own. Clone the repo, set your environment variables, and deploy." },
  { q: "Is my data private?", a: "Your instance, your database. Nothing is sent to a third party, and card details are encrypted at rest and only revealed behind your password." },
  { q: "Does it work offline?", a: "It's an installable PWA. You can record expenses and lending entries with no connection; they sync automatically when you're back online." },
  { q: "Can I import from Khatabook?", a: "Yes. The Import Center reads Khatabook exports into the lending ledger, with duplicate detection so you don't double-count." },
  { q: "Does it support shared expenses?", a: "Fully — group-first splitting, per-group dashboards, and smart settlement suggestions that minimise the number of payments." },
  { q: "Can I export my data?", a: "Any time. Export the full ledger as CSV or JSON, and generate Excel statements for a contact or a group." },
];

export function Landing() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <SiteHeader />
      <main>
        <Hero />
        <Features />
        <Screenshots />
        <Why />
        <Trust />
        <Roadmap />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 no-underline text-ink" aria-label="Ledgerly home">
          <BrandMark size={26} />
          <span className="font-extrabold tracking-tight text-[15px]">Ledgerly</span>
        </Link>
        <nav className="hidden md:flex items-center gap-6 ml-4 text-[13px] font-semibold text-mut" aria-label="Primary">
          <a href="#features" className="no-underline hover:text-ink">Features</a>
          <a href="#why" className="no-underline hover:text-ink">Why Ledgerly</a>
          <a href="#faq" className="no-underline hover:text-ink">FAQ</a>
        </nav>
        <div className="flex-1" />
        <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="hidden sm:inline-flex items-center gap-1.5 text-[13px] font-semibold text-mut no-underline hover:text-ink px-2">
          <GhIcon /> GitHub
        </a>
        <Link href="/sign-up" className="inline-flex items-center h-9 px-4 rounded-[10px] bg-acc text-white text-[13px] font-bold no-underline hover:brightness-110 transition">
              Get started
            </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* soft accent wash behind the hero */}
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(120% 80% at 80% -10%, color-mix(in oklab, var(--acc) 16%, transparent), transparent 60%)" }} />
      <div className="relative mx-auto max-w-6xl px-4 pt-14 pb-10 md:pt-20 md:pb-16 grid md:grid-cols-2 gap-10 items-center">
        <div className="flex flex-col items-start">
          <span className="inline-flex items-center gap-2 text-[12px] font-bold text-acc bg-accsoft rounded-full px-3 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-acc" /> Self-hosted personal finance
          </span>
          <h1 className="mt-4 text-[34px] leading-[1.08] md:text-[52px] md:leading-[1.05] font-extrabold tracking-[-0.03em] text-balance">
            All your money,<br />one honest ledger.
          </h1>
          <p className="mt-4 text-[15px] md:text-[17px] text-mut max-w-[46ch] leading-relaxed">
            Track spending, lending, shared expenses, cards, bills and budgets in a single offline-first app you run yourself — rupee-native and built for how India actually splits the bill.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/sign-up" className="inline-flex items-center h-11 px-5 rounded-[12px] bg-acc text-white text-[14px] font-bold no-underline hover:brightness-110 transition shadow-[var(--shLg)]">
              Get started
            </Link>
            <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 h-11 px-5 rounded-[12px] border border-line2 bg-card text-[14px] font-bold text-ink no-underline hover:border-acc transition">
              <GhIcon /> View on GitHub
            </a>
          </div>
          <p className="mt-4 text-[12.5px] text-mut2">No account on our servers — because there are no servers of ours. Your data, your machine.</p>
        </div>
        <PhoneFrame src="/screens/dashboard.webp" label="Ledgerly dashboard" priority />
      </div>
    </section>
  );
}

/** A lightweight phone frame around a screenshot. `priority` marks the hero
 *  image as eager (it's the LCP); everything else lazy-loads. */
function PhoneFrame({ src, label, priority }: { src: string; label: string; priority?: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div className="rounded-[30px] border-[6px] border-[color:var(--ink)]/10 bg-card p-1.5 shadow-[var(--shLg)]" style={{ background: "var(--side)" }}>
        {/* Pre-optimised WebP served statically; a plain <img> keeps the landing
            page zero-JS (no next/image runtime) while still lazy-loading. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={label}
          width={620}
          height={1240}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          className="w-full h-auto rounded-[24px] block border border-line"
        />
      </div>
    </div>
  );
}

function Features() {
  return (
    <section id="features" aria-labelledby="features-h" className="mx-auto max-w-6xl px-4 py-14 md:py-20">
      <SectionHead id="features-h" eyebrow="Everything, in one place" title="One system instead of five apps" />
      <div className="mt-9 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-[16px] border border-line bg-card p-5 flex flex-col gap-2.5" style={{ boxShadow: "var(--sh)" }}>
            <span className="w-10 h-10 rounded-[11px] grid place-items-center bg-accsoft text-acc"><Icon id={f.icon} /></span>
            <h3 className="text-[15px] font-bold tracking-tight m-0">{f.title}</h3>
            <p className="text-[13px] text-mut leading-relaxed m-0">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Screenshots() {
  return (
    <section aria-labelledby="screens-h" className="py-14 md:py-20" style={{ background: "var(--side)" }}>
      <div className="mx-auto max-w-6xl px-4">
        <SectionHead id="screens-h" eyebrow="See it" title="Designed mobile-first, top to bottom" center />
        <div className="mt-10 grid grid-cols-2 md:grid-cols-3 gap-5 md:gap-7">
          {SCREENS.map((s) => (
            <figure key={s.label} className="m-0 flex flex-col items-center gap-3">
              <PhoneFrame src={s.src} label={`${s.label} screen`} />
              <figcaption className="text-[12.5px] font-semibold text-mut">{s.label}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function Why() {
  return (
    <section id="why" aria-labelledby="why-h" className="mx-auto max-w-6xl px-4 py-14 md:py-20">
      <SectionHead id="why-h" eyebrow="Why Ledgerly" title="Finance software that works for you, not on you" />
      <div className="mt-9 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {WHY.map((w) => (
          <div key={w.title} className="rounded-[16px] border border-line bg-card p-5">
            <div className="flex items-center gap-2 mb-1.5">
              <CheckIcon />
              <h3 className="text-[14.5px] font-bold tracking-tight m-0">{w.title}</h3>
            </div>
            <p className="text-[13px] text-mut leading-relaxed m-0 pl-7">{w.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section aria-labelledby="trust-h" className="py-14 md:py-16" style={{ background: "var(--side)" }}>
      <div className="mx-auto max-w-6xl px-4 text-center">
        <SectionHead id="trust-h" eyebrow="Built to be trusted" title="Serious about your privacy and your data" center />
        <ul className="mt-8 flex flex-wrap justify-center gap-2.5 list-none p-0">
          {TRUST.map((t) => (
            <li key={t} className="inline-flex items-center gap-2 rounded-full border border-line2 bg-card px-3.5 py-2 text-[12.5px] font-semibold">
              <CheckIcon small /> {t}
            </li>
          ))}
        </ul>
        <div className="mt-10">
          <p className="text-[12px] font-bold uppercase tracking-wide text-mut2">Built with</p>
          <div className="mt-3 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[13.5px] font-semibold text-mut">
            {TECH.map((t) => <span key={t}>{t}</span>)}
          </div>
        </div>
      </div>
    </section>
  );
}

function Roadmap() {
  return (
    <section aria-labelledby="roadmap-h" className="mx-auto max-w-6xl px-4 py-14 md:py-20">
      <SectionHead id="roadmap-h" eyebrow="Coming next" title="On the roadmap" />
      <div className="mt-9 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {ROADMAP.map((r) => (
          <div key={r.title} className="rounded-[16px] border border-dashed border-line2 bg-card p-5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-acc mb-1.5">Planned</div>
            <h3 className="text-[14.5px] font-bold tracking-tight m-0">{r.title}</h3>
            <p className="text-[13px] text-mut leading-relaxed mt-1 m-0">{r.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-h" className="py-14 md:py-20" style={{ background: "var(--side)" }}>
      <div className="mx-auto max-w-3xl px-4">
        <SectionHead id="faq-h" eyebrow="Questions" title="Frequently asked" center />
        <div className="mt-8 flex flex-col gap-2.5">
          {FAQ.map((f) => (
            <details key={f.q} className="group rounded-[14px] border border-line bg-card px-4 py-1 open:shadow-[var(--sh)]">
              <summary className="flex items-center justify-between gap-3 py-3.5 cursor-pointer list-none text-[14px] font-bold marker:hidden">
                {f.q}
                <span aria-hidden className="text-mut2 transition-transform group-open:rotate-45 text-[18px] leading-none">+</span>
              </summary>
              <p className="text-[13.5px] text-mut leading-relaxed pb-4 pt-0.5 m-0">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 md:py-24">
      <div className="rounded-[24px] p-8 md:p-14 text-center relative overflow-hidden" style={{ background: "linear-gradient(150deg, var(--acc), color-mix(in oklab, var(--acc) 60%, #7a3cff))" }}>
        <h2 className="text-[26px] md:text-[38px] font-extrabold tracking-[-0.02em] text-white text-balance m-0">Take your finances back.</h2>
        <p className="mt-3 text-[15px] text-white/85 max-w-[44ch] mx-auto">Self-host Ledgerly in minutes and keep every rupee — and every record — on infrastructure you own.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link href="/sign-up" className="inline-flex items-center h-11 px-6 rounded-[12px] bg-white text-[14px] font-bold no-underline hover:brightness-95 transition" style={{ color: "var(--acc)" }}>
            Get started
          </Link>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 h-11 px-6 rounded-[12px] border border-white/40 text-white text-[14px] font-bold no-underline hover:bg-white/10 transition">
            <GhIcon /> View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  const links = [
    { label: "GitHub", href: GITHUB },
    { label: "Documentation", href: `${GITHUB}#readme` },
    { label: "Changelog", href: `${GITHUB}/blob/ledgerly-app/CHANGELOG.md` },
    { label: "Releases", href: `${GITHUB}/releases` },
    { label: "License", href: `${GITHUB}#license` },
    { label: "Privacy", href: "#why" },
  ];
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-10 flex flex-col md:flex-row md:items-center gap-6 md:gap-8">
        <div className="flex items-center gap-2">
          <BrandMark size={24} />
          <span className="font-extrabold tracking-tight text-[14px]">Ledgerly</span>
          <span className="text-[12px] text-mut2 ml-2">v{VERSION}</span>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] font-semibold text-mut" aria-label="Footer">
          {links.map((l) => (
            <a key={l.label} href={l.href} target={l.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className="no-underline hover:text-ink">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="md:ml-auto text-[12px] text-mut2">Self-hosted · offline-first · built for India</div>
      </div>
    </footer>
  );
}

// ─────────── small presentational helpers ───────────

function SectionHead({ id, eyebrow, title, center }: { id: string; eyebrow: string; title: string; center?: boolean }) {
  return (
    <div className={center ? "text-center max-w-2xl mx-auto" : "max-w-2xl"}>
      <div className="text-[12px] font-bold uppercase tracking-[0.08em] text-acc">{eyebrow}</div>
      <h2 id={id} className="mt-2 text-[24px] md:text-[34px] font-extrabold tracking-[-0.02em] text-balance m-0">{title}</h2>
    </div>
  );
}

function CheckIcon({ small }: { small?: boolean }) {
  const s = small ? 14 : 18;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="flex-none">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function GhIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="flex-none">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.72c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

/** Compact line-icon set for the feature cards — one path per feature key. */
function Icon({ id }: { id: string }) {
  const paths: Record<string, React.ReactNode> = {
    wallet: <><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10h18M16 14h2" /></>,
    hand: <><path d="M8 7h11M8 7l3-3M8 7l3 3M16 17H5M16 17l-3-3M16 17l-3 3" /></>,
    users: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M2 20a6 6 0 0 1 12 0M15 15a5 5 0 0 1 6 5" /></>,
    card: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 10h18" /></>,
    bill: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" /></>,
    gauge: <><circle cx="12" cy="12" r="9" /><path d="M12 12V4M12 12l5 3" /></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    import: <><path d="M12 3v12M8 11l4 4 4-4M4 21h16" /></>,
    activity: <><path d="M22 12h-4l-3 8L9 4l-3 8H2" /></>,
    offline: <><path d="M5 12.55a11 11 0 0 1 14 0M8.5 15.85a6 6 0 0 1 7 0M12 20h.01M2 8.82a15 15 0 0 1 20 0" /></>,
    server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  };
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[id]}
    </svg>
  );
}
