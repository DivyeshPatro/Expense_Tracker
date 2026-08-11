# Ledgerly — Production Readiness Review (Final)

**Date:** 2026-08-11 · **Version:** 1.3.0 (`ledgerly-app`)
**Environment:** local `next dev`, Docker Postgres `ledgerly-pg`, seeded user `arjun@ledgerly.app`
**Browsers:** Chrome desktop @1536×674; Pixel 8 (412px) and iPhone 15 (393px) widths via sized windows
**Method:** black-box interaction. Source consulted only to attribute two observed behaviours
(security headers, rate-limit config); noted inline.

---

## 1. Verdict

**This build is blocked from release by one defect class: the app's own arithmetic does not
reconcile.** Two independent instances were found, on the two screens a user checks most often.

Everything else — and there is a lot of it — is fixable in a normal sprint. The engineering
underneath is genuinely good: double-submit guarded, output escaped, security headers better than
most commercial finance products, an audit log that records card reveals, and a rate limiter on the
most sensitive operation in the product that works without any external dependency. This is not a
weak application. It is a strong application with a small number of defects that happen to sit
exactly where trust is formed.

Two things must be true before launch: **the numbers must agree with each other**, and **the app
must stop storing CVVs**.

---

## 2. Blocking defects

### BUG-01 — Three different "last 30 days" expense totals · Critical · P0

| Screen | Figure | Label | Count |
|---|---|---|---|
| `/dashboard` | **₹77,719** | EXPENSE · LAST 30 DAYS | 17 transactions |
| `/transactions` → Expenses | **₹81,459** | OUT | 17 txns |
| `/analytics` | **₹52,487.34** | Categories · LAST 30 DAYS TOTAL | — |

The ₹3,740 gap recurs, sign-reversed, in balances: `/dashboard` ₹2,30,870 vs `/transactions`
₹2,27,130. Exact and repeatable, so this is a definitional split, not rounding.

**Reproduce:** sign in as Arjun → default "Last 30 Days" → read the EXPENSE card → go to
`/transactions`, click **Expenses** → go to `/analytics`.

**Hypothesis (unverified):** three definitions of "expense" — gross outflow, own-share-after-splits,
and categorised-only. `₹81,459 − ₹52,487.34 = ₹28,971.66` of uncategorised spend absent from
Insights; the 56% savings rate inherits that gap.

**Fix:** define `grossOutflow`, `ownShareOutflow`, `categorisedOutflow` once in a shared money
module; every screen calls one by name. Relabel in the UI — "You spent" / "Your share" /
"Categorised spending" — with a tooltip wherever a figure excludes something. Regression-test that
the figures agree when there are no splits and no uncategorised rows, **and** that they differ by
the documented amount when there are.

### BUG-02 — Budgets summary does not add up · Critical · P0

`/budgets` header: **SPENT ₹8,779 · BUDGETED ₹22,500 · Left to spend ₹13,871.**
`22,500 − 8,779 = 13,721`. The screen is out by **₹150** — precisely the amount Shopping is over by
(`₹3,150 of ₹3,000 · Over by ₹150`).

"Left to spend" sums per-category remainders while flooring overspent categories at zero; SPENT and
BUDGETED are true totals. Both are defensible; showing all three together is not, because the user
can do the subtraction.

**Fix:** pick one model. If overspend shouldn't eat other budgets, label it "Left in categories
under limit" and show the overspend separately. Same shared-primitive discipline as BUG-01 — this is
the same bug wearing different clothes, which is the real signal here.

### BUG-03 — CVV is stored and retrievable · Critical · P0 (security)

Adding a card and re-authenticating reveals **full PAN, expiry, cardholder name and CVV** in
plaintext with per-field Copy buttons. Verified end-to-end with test PAN `4111 1111 1111 1111`,
CVV `123` — the CVV came back exactly as entered.

Storing the card verification value after authorisation is prohibited by PCI DSS for everyone, and
the reasoning holds for self-hosted software: PAN + expiry + name + CVV is a complete
card-not-present fraud kit. `CARD_ENCRYPTION_KEY` lives in the same `.env` as the database URL, so a
single server compromise yields both ciphertext and key. The benefit purchased with that risk is
saving the user from typing three digits.

**Fix:** stop persisting CVV. Keep PAN/expiry/name (defensible for a personal vault) and prompt for
the CVV at use time. One change that makes a stolen database non-transactable. Also move
`CARD_ENCRYPTION_KEY` out of the same secret store as `DATABASE_URL`.

*The rest of this feature is well built* — 30-second auto-hide with countdown, password re-auth with
correct `autocomplete="current-password"`, per-field copy, and reveals written to the audit log.

---

## 3. High severity

### BUG-04 — Sign-in brute-force protection fails open · High · P1

Twelve consecutive failed sign-ins: twelve `401`s, no `429`, no lockout, flat ~320–370ms responses.
`.env.example` documents `UPSTASH_REDIS_REST_*`; the working `.env` sets neither, and the limiter
silently no-ops.

**The decisive detail:** the **card reveal endpoint is correctly rate-limited** — six wrong
passwords produced *"Too many incorrect attempts — wait a few minutes before trying again"* — **with
no Upstash configured**. A working local limiter already exists in this codebase. Sign-in simply
doesn't use it.

That reframes this from "environment issue" to a one-line-of-reasoning fix: apply the mechanism you
already wrote for the most sensitive operation to the front door. Add a startup warning when
distributed rate limiting is unavailable, and gate it in `docs/release-checklist.md`.

### BUG-05 — `npm run dev` connects to production Supabase by default · High · P1

`.env` points `DATABASE_URL`/`DIRECT_URL` at the production pooler. `db:seed`/`db:migrate`/`db:reset`
route through `scripts/db-local.mjs`, which forces local and refuses otherwise — an excellent guard.
`npm run dev` bypasses it entirely.

This review began that way: the first dashboard loaded showed real personal transactions, and
testing was halted until the server was restarted with variables pinned by hand. The mitigation is
"remember two exports every session", which is not a control.

**Fix:** `.env.local` pinned to Docker — Next.js loads it at higher precedence than `.env`
automatically, so local becomes the default and production becomes deliberate. Gitignore it, document
it, and consider refusing to boot against a non-local DB without `LEDGERLY_ALLOW_REMOTE_DB=1`.

### BUG-06 — Card detail hero renders 1526×1390px · High · P2

The card graphic on `/cards/[cardId]` measures **1526×1390** (aspect 1.10; a real card is 1.586).
Page height is 1390px and the card occupies all of it. **Show details, Edit, Archive, Delete and
Activity are all below the fold**, behind a scroll past a giant blue rectangle.

**Fix:** cap the visual at ~380–420px wide at 1.586 aspect; place actions beside it on desktop.

### BUG-07 — Auth pages have no labels, no autocomplete, no live regions · High · P1

On `/sign-in`, `document.querySelectorAll('label')` returns **zero elements**. Both inputs lack
`<label>`, `id`, `aria-label`, `aria-labelledby` and `autocomplete`. No `role="alert"` anywhere.

1. Screen readers announce two unlabelled fields — WCAG 1.3.1 (A), 4.1.2 (A).
2. "Invalid email or password" is never announced — WCAG 4.1.3 (AA).
3. Password managers misbehave; Chrome autofill overwrote a typed password mid-test and produced a
   submit that appeared to do nothing — WCAG 1.3.5 (AA).

The landing page advertises "Accessibility (WCAG AA)". **Fix this or drop the claim.**

Notably the **Add card dialog gets this right** — every field has a proper `aria-label`, and the
password prompt uses `autocomplete="current-password"`. The team knows how; the auth routes were
missed.

### BUG-08 — Validation errors are never announced, app-wide · High · P1

Confirmed on three surfaces — sign-in, Add expense, Add card. Errors render visually and sit in no
live region (`[role=alert],[aria-live]` returns empty each time). Blind users get silence on every
failed submit in the product.

**Fix:** one shared `<FormError role="alert">` component; replace all three call sites.

---

## 4. Medium severity

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| BUG-09 | **No onboarding.** New account = wall of ₹0, one auto-created Cash Wallet, and "Needs your attention → All caught up" when nothing has ever happened | Tested with a fresh sign-up | 3-step first run: accounts → opening balances → first transaction/import |
| BUG-10 | **Empty "Recent transactions" card** for new users — heading + "All →" link only; `innerHTML` is 146 chars with no child | Verified in DOM | Empty state with a primary action |
| BUG-11 | **No `<form>` in the Add card dialog**, so **Enter never submits**. Verified: focus a field, press Enter, nothing happens | Ironic against EPIC 16 "Fast Input Flows" | Wrap in `<form onSubmit>` |
| BUG-12 | Close (`✕`) and `Cancel` are `type="submit"`. Inert today only because there's no form — a latent bug that activates the moment BUG-11 is fixed, making **Enter discard the form** | `buttons: ["✕\|type=submit", …, "Cancel\|type=submit"]` | Set `type="button"` |
| BUG-13 | **Every page is `<title>Ledgerly</title>`** — tabs, history and bookmarks indistinguishable; no SPA navigation announcement | All 13 routes | Per-route `metadata.title` |
| BUG-14 | Validation error clipped by the sticky footer in Add expense | Submit with empty amount | Pad the scroll container; scroll error into view |
| BUG-15 | Monthly spending chart opens scrolled to five **₹0 months** (Sep–Jan) while Mar–Aug data sits off-screen | `/analytics` default view | Default to most recent month with data |
| BUG-16 | Filtered views show meaningless carry-forward/balance — Expenses filter reports `Carry forward −₹7,09,866`, `Balance −₹7,91,325` against a real balance of ₹2,29,636 | `/transactions` + Expenses | Hide or relabel "Total in view" |
| BUG-17 | **Sign-up leaks account existence** (`422 User already exists`) while sign-in is correctly generic. With BUG-04, enumerable at speed | API probe | Generic response + differentiated email |
| BUG-18 | **Targets below WCAG 2.5.8 (AA, 24×24)** — "All →" 29×17, period chips 36×24/37×24/39×24, "⎋" 9×20, skip link 1×1. On mobile, `/dashboard` "All" 14×17 and "Customize dashboard" 140×17 | Measured desktop + 412px | Pad hit areas without changing visual size |
| BUG-19 | Card row link on `/cards` has **no accessible name** — announced as bare "link" | `read_page` | Add `aria-label` |
| BUG-20 | **`⌘K` shown on Windows**, where the working shortcut is Ctrl+K. Wrong for most of a self-hosting audience | Verified: Ctrl+K opens the palette | Platform-detect the glyph |
| BUG-21 | Minor mobile overflow — `/import` and `/transactions` have elements extending ~20–25px past the viewport, clipped rather than scrollable | 412px measurement | Constrain widths |
| BUG-22 | First card silently becomes **DEFAULT** without the checkbox being ticked | Observed on save | Say so, or ask |

---

## 5. Low severity

| ID | Finding |
|---|---|
| BUG-23 | "₹0 across **1 accounts**" — unpluralised |
| BUG-24 | Display name accepts empty, whitespace-only, 500 chars and 50 emoji. No trim, no cap |
| BUG-25 | Sign-in password field carries `minLength=8`, blocking legacy shorter passwords behind a native tooltip. Belongs on sign-up only |
| BUG-26 | Amount is `type="number"` with spinners — meaningless for currency, permits `e`/`+`/`-`, mutates on scroll-wheel |
| BUG-27 | Sign-in error insertion pushes the submit button down, shifting the click target after a failed attempt |
| BUG-28 | `/lending` stacks **four** separate empty states on one screen. One would do |
| BUG-29 | Action placement is inconsistent — Bills puts Edit/Delete inline right; Budgets stacks them below each row |
| BUG-30 | Bills styles **Delete identically to Edit**, adjacent. The inline "Delete this bill? / Keep" confirm mitigates it, but the affordance invites the misclick |

---

## 6. Password policy · High · P1

| Password | Result |
|---|---|
| `12345678` | **Accepted** |
| `password` | **Accepted** |
| `short12` (7) | Rejected — `PASSWORD_TOO_SHORT` |

Minimum length 8 is the only rule. No blocklist, no meter, no feedback. On an app holding a full
financial record and a card vault, too permissive.

**Fix:** zxcvbn-style meter, block the top ~10k common passwords, raise the floor to 10–12. Do not
add character-class rules — they measurably produce worse passwords than length plus a blocklist.

---

## 7. Verified strengths

1. **Double-submit guarded** — three rapid clicks on Add expense created exactly one transaction.
2. **Output escaping correct** — `<img src=x onerror=alert(1)>` as a display name renders as text.
3. **Security headers** — CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS 2y, nosniff,
   `Referrer-Policy`, `Permissions-Policy` denying camera/mic/geolocation. Confirmed in
   `src/middleware.ts` after the CSP correctly blocked a test iframe.
4. **Card reveal is rate-limited without external dependencies** — the most sensitive operation is
   the best protected.
5. **Audit log records card reveals** — `👁 Revealed card details · QA TEST CARD ···· 1111`.
   Genuinely good security hygiene.
6. **Sign-in doesn't leak account existence.**
7. **Dashboard a11y fundamentals** — correct landmarks, one `h1`, sensible `h2` hierarchy, skip
   link, `lang="en"`, no missing `alt`, no nameless controls.
8. **Keyboard focus visible** — real Tab produces a `:focus-visible` ring. *(An earlier programmatic
   `.focus()` measurement suggested otherwise and was wrong — recorded because `HANDOFF.md` is right
   that runtime claims must be measured.)*
9. **No horizontal scroll on any of 13 routes** at 412px or 393px. The responsive foundation is sound.
10. **Writes propagate exactly** — a ₹1,234 expense moved the dashboard 17→18 txns, ₹77,719→₹78,953,
    balance ₹2,30,870→₹2,29,636.
11. **People and Shared agree exactly** — Karan ₹12,638.33, Rohan ₹7,818.33, Priya ₹225 on both.
12. **Command palette** (Ctrl+K) — context-aware first action, natural-language hint
    *"or ask 'swiggy in march'"*.
13. **Import wizard** — 4 steps, three source formats, and the right reassurance up front:
    *"Nothing is written to your ledger until you review and confirm at the end."*
14. **Bills** — clear "Next up", colour+text due badges, inline delete confirmation with a "Keep" escape.
15. **Cards empty state** is excellent, which is what makes BUG-10 an inconsistency rather than a gap.
16. **Settings** — 7 well-described groups, sync status surfaced. EPIC 17's claim holds up.
17. **Deep-linkable search** — `/transactions?q=…` restores state.
18. **`scripts/db-local.mjs`** is exemplary defensive tooling.

---

## 8. Feature validation

| Feature | Verdict | Reasoning |
|---|---|---|
| Expense tracking | ✅ Essential | The core. Fast entry, correct propagation |
| Accounts | ✅ Essential | Totals reconcile with dashboard; per-account deltas are useful |
| Bills | ✅ Essential | Best-executed module in the product |
| Budgets | ✅ Essential | Blocked on BUG-02 |
| Shared expenses | ✅ Essential | Rich, correct, and the clearest India-specific differentiator |
| Import | ✅ Essential | The adoption unlock — nobody starts from zero |
| Activity log | ✅ Essential | Rare in personal finance; strong trust signal |
| Command palette | 🟡 Nice to have | Excellent for power users, undiscoverable for everyone else |
| Insights | 🟡 Nice to have | Currently reports a third expense number. Prove it's opened before investing |
| Cards vault | 🟡 Nice to have — **redesign** | Genuinely useful; must stop storing CVV (BUG-03) |
| **People** | 🔴 Questionable | Duplicates Shared's balance list exactly. Three nav entries — People, Lending, Shared — for one mental model ("who owes whom") |
| Colour picker on cards | 🔴 Unnecessary | 8 swatches on a form already fighting for vertical space |
| "Customize dashboard" | 🔴 Unnecessary | A 140×17 target for a preference most users set never |

**On People/Lending/Shared:** `HANDOFF.md` already asks *"Does People replace how you think about
Lending and Shared?"* Testing as a first-time user: three sidebar entries covering overlapping
concepts is the single biggest navigational confusion in the app. People and Shared showed identical
balances. Recommend collapsing to **People** (per-person truth) with Lending and Shared as views
within it.

---

## 9. Missing features

| Feature | Problem solved | Impact | Complexity | Priority |
|---|---|---|---|---|
| Onboarding / first-run | New users see a wall of zeros | Adoption | Medium | **Critical** |
| Undo on destructive actions | Delete is permanent; only inline confirms exist | Trust | Low | **High** |
| Recurring transaction auto-entry | Rent/EMI/salary re-entered monthly by hand | Retention | Medium | High |
| Search/filter by amount range and date range | Only free-text search today | Productivity | Low | High |
| Bulk edit / bulk categorise | Post-import cleanup is row-by-row; ₹28,971 sits uncategorised in the seed alone | Productivity | Medium | High |
| Receipt attachment | Schema hints at it; no UI found | Completeness | Medium | Medium |
| Multi-currency | "Rupee-native" is a positioning choice, but blocks anyone with a foreign transaction | Reach | High | Low |
| 2FA | Finance app with password-only auth | Security | Medium | Medium |
| Session management / active devices | No way to see or revoke sessions | Security | Low | Medium |
| Scheduled/automatic backups | Backup is manual; self-hosters forget | Data safety | Low | High |

---

## 10. Persona findings

**First-time user** — Worst experience in the product. No onboarding, an empty card, and "All caught
up" before doing anything. Would likely leave before entering a second transaction.

**Experienced user** — Best experience. Ctrl+K, deep-linkable search, fast entry, dense dashboard.
This is who the app is currently built for, and it serves them well.

**Non-technical user** — Held back by vocabulary, not layout: "Carry forward", "NET · THIS VIEW",
"unassigned history". And they are the most likely to notice that three screens disagree — and the
least likely to guess it's a definitional difference rather than an error.

**Mobile-only user** — Structurally fine: no horizontal scroll on any route at either width. Not
verified: real touch, orientation change, safe areas, on-screen keyboard behaviour. Several targets
(14×17, 29×17) will be hard to hit accurately.

**Elderly user** — Small targets and low-contrast secondary text are the barriers. Dark-first theme
with muted greys on near-black is the hardest combination for ageing eyes; the Appearance setting
offering light mode is the mitigation.

**Accessibility-focused user** — Can navigate the dashboard well and cannot use the sign-in page.
They fail at the front door, then find a well-structured app behind it, then get silence on every
validation error. Fixing BUG-07 and BUG-08 changes this persona's experience more than any other
work in this document.

---

## 11. Competitive position

**Better than most:** the audit log, the security headers, one schema for spending + lending +
splitting + cards + bills + budgets, no subscription, Khatabook import, and a settlement model built
for how bills actually get split in India. Splitwise doesn't track your accounts; Walnut and Money
Manager don't do group settlement well; none of them are self-hostable.

**Worse:** no onboarding (every competitor has one), no automatic bank/SMS transaction capture —
which is the single feature Indian users expect most, and its absence means manual entry forever —
no receipt OCR, no multi-currency, and no mobile app store presence.

**Would users switch?** Someone already running a Splitwise-plus-spreadsheet combination, who cares
about data ownership, yes — once the numbers agree. A mainstream user comparing against an app that
reads their bank SMS automatically, no. Self-hosting is the moat and the ceiling simultaneously.

---

## 12. Scores

Now based on 13/13 routes on desktop and 13/13 measured at mobile widths.

| Category | Score | Basis |
|---|---|---|
| UI | 7/10 | Coherent and well-spaced; card hero, clipped error, chart default |
| UX | 6/10 | Strong for returning users; nothing teaches a new one |
| Functionality | 4/10 | Everything works except the arithmetic, twice |
| Accessibility | 5/10 | Dashboard and card dialog strong; auth pages fail A; errors never announced |
| Mobile (layout) | 7/10 | No horizontal scroll anywhere; small targets, minor clipping |
| Desktop | 7/10 | Comfortable and fast |
| Feature set | 8/10 | Broad, coherent, genuinely differentiated |
| Ease of use | 5/10 | Fast once learned |
| Security | 6/10 | Headers/audit/reveal-limiting excellent; CVV storage and open sign-in limiter pull it down |
| **Performance** | **Not scored** | No profiling done. Dev-mode route compilation dominated timings |

**No composite score is given.** Performance is unmeasured, and averaging categories of unequal
weight would repeat the mistake of the interim draft, where an overall figure was published while two
categories were unscored.

---

## 13. Priorities

**Before production — non-negotiable**

1. BUG-01 · reconcile expense totals (2–3 days)
2. BUG-02 · reconcile budget totals — same shared primitives (0.5 day)
3. BUG-03 · stop storing CVV (0.5 day)
4. BUG-04 · apply the existing local rate limiter to sign-in (0.5 day)
5. BUG-05 · `.env.local` pinned to Docker (1 hour)
6. BUG-07 + BUG-08 · labels, autocomplete, live regions (0.5 day)
7. Password floor + blocklist (0.5 day)
8. BUG-13 · per-route page titles (1 hour)

**Before public launch**

9. BUG-09 · onboarding and empty states
10. BUG-06 · card detail layout
11. BUG-11/12 · form semantics
12. BUG-18 · target sizes

**Can wait:** People/Lending/Shared consolidation (needs the friction log), Insights investment,
recurring auto-entry, 2FA, receipts.

---

## 14. Untested

- **Performance profiling** — dev mode only; no production build measured
- **Edge browser**
- **Offline PWA behaviour and sync conflict resolution**
- **Backup/restore round-trip; import with malformed or hostile files**
- **Real touch, orientation change, safe areas, on-screen keyboard** (measured widths, not devices)
- **Transaction edit/delete** (create tested; edit and delete not)
- **Session expiry, browser back/forward mid-flow**
- **Screen reader testing with an actual screen reader** — structural inspection only

---

## 15. Note on process

`HANDOFF.md` freezes development pending a week's friction log. That log is the right instinct and it
will not surface any of the eight blocking items above. A log written by the author records where
*the author* hesitates. It cannot record a first run, a screen reader, a password manager, a Windows
keyboard hint, or the fact that ₹22,500 − ₹8,779 is displayed as ₹13,871.

Run the friction log **and** fix the list. They answer different questions.

---

*Screenshots were captured during testing but could not be exported — the browser bridge returns
images to the reviewer, not to disk. Every finding above is reproducible from the steps given; a
Playwright evidence script (`scripts/e2e-review-evidence.mjs`) reproducing each numbered bug into
`e2e-output/` can be written on request.*
