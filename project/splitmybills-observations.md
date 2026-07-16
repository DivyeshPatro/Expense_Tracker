# splitmybills.in — competitive observations for Ledgerly

Reviewed 2026-07-16 by logging into a live account and driving every screen at
1280×900 and 390×844: Dashboard, Groups (+ Create Group), Insights,
Subscriptions & Bills, Restaurant Bill wizard (steps 1–2), QR Payment,
Notifications, Profile. Screenshots in `e2e-output/smb/` (gitignored).

The product is a **split-first** tracker (groups are the core object, personal
ledger is secondary) — the inverse of Ledgerly's ledger-first design. That
framing difference explains most of what's below.

---

## Worth borrowing

### 1. Task-shaped entry cards on the dashboard
The dashboard's mid-section is three full-width tinted cards, each naming a
*job* rather than a screen: "Split Restaurant Bill — Veg / Non-Veg or per-item
split, no accounts needed", "Subscriptions & Bills — track Netflix, Gym, Loan
EMIs & renewals in one place", "Generate QR Code for Payment — enter amount,
share to receive via UPI". Each has an icon tile, one-line value proposition,
and a chevron. This is a genuinely good pattern for surfacing *flows* (vs.
Ledgerly's dashboard which surfaces *data*). If Ledgerly ever adds
onboarding/empty-state guidance, this card grammar (icon tile + job title +
one-line benefit + arrow) is the shape to copy.

### 2. Spending summary as three time horizons
The "SPENDING" hero stacks ₹ this month / ₹ this week / ₹ today in one card,
with font size encoding recency-relevance. Ledgerly's period-picker approach is
more powerful but requires interaction; the three-horizon stack answers "am I
overspending *right now*?" with zero taps. Could work as the mobile Expense
card's layout (month primary, week/today as small sub-lines) without adding
any queries — the data is already in `periodRows`.

### 3. "No accounts needed — just labels" for ad-hoc splits
The Restaurant Bill wizard's step 2 lets you add participants as plain text
names (2–20 people), explicitly not requiring sign-ups. Ledgerly's participants
are already label-like (friends don't need accounts), but the *copy* here —
"No accounts needed — just labels" — removes sign-up anxiety at exactly the
right moment. Worth stealing the reassurance line placement (inline in the
form, not in marketing).

### 4. Quick Count vs. By Name toggle
Same step 2 offers "By Name" / "Quick Count" modes — if you don't care who's
who, just say "6 people" and skip data entry. A nice effort-escape-hatch for
equal splits. Ledgerly's split editor always requires selecting named
participants; a "just divide by N" fast path could serve the restaurant
use-case where the point is the math, not the ledger.

### 5. Veg / Non-Veg / Common item tagging
Per-item colored dot tags (green/red/blue) with per-person exclusion — a
distinctly Indian-market feature that makes item-level splitting culturally
precise (vegetarians don't pay for the chicken). Ledgerly has no item-level
splitting at all; if it ever gets receipt-level itemization, this three-tag
model is the proven shape for the market.

### 6. UPI-native settlement (QR generator)
"Generate QR Code for Payment — enter amount, share to receive via UPI" turns
settlement from bookkeeping into an actual money movement. It's a thin feature
(amount + note → UPI QR image) with outsized perceived value. Ledgerly records
settlements but doesn't help execute them; a UPI deep-link/QR on the Settle-up
sheet (`upi://pay?pa=<vpa>&am=<amount>&tn=<note>`) would be a small, dependency-
free addition that closes the loop. Profile stores a UPI ID field for this.

### 7. Group creation asks "who is this for?" first
Create Group leads with audience (Just me / Couple / With others) before name,
then type chips (Trip / Flat-House / Family / Office / Other) — each with an
emoji, selected state clearly outlined. Structuring creation around intent
instead of a blank name field is good form design, and the categories double
as analytics dimensions later.

### 8. Stepper wizard with completed-state ticks
The 4-step bill wizard (Items → People → Split → Results) shows a numbered
progress rail where completed steps become ✓ chips. Ledgerly's import wizard
has steps but this treatment (number → tick, connecting line fills) reads
better at a glance.

---

## Where Ledgerly is already ahead (anti-patterns to not import)

### 1. Paywalled analytics
Insights is a full-page "Upgrade to Pro" wall on the free tier — the nav item
exists only to sell. Ledgerly's Analytics is a real feature. Nothing to copy;
worth noting the free tier limits (4 expenses/day, 3 groups, 5 members) as the
monetization lever they chose.

### 2. Receipt scanning is Pro-gated at the exact moment of need
Camera/Gallery buttons sit in step 1 with PRO badges — the flow teases the
feature then blocks it, forcing manual item entry ("add each item one by one").
Gating the *best* path of your marquee flow is a conversion tactic that costs
UX trust.

### 3. Six-item mobile bottom nav, no add action in it
Bottom bar: Home · Groups · Insights · Bill Split · Alerts · Profile — six
items squeezed in, none of which is "add an expense". There's no FAB and no
center action; adding an expense requires entering a group first (split-first
model). Ledgerly's 5-slot bar with a raised center Quick Add is a stronger
mobile pattern. Also: Insights (a paywall) and Profile (settings) occupy prime
tab real estate while Notifications gets a tab of its own — priorities that
mostly serve upsell, not the user's daily loop.

### 4. No personal ledger view
There's no flat "all my transactions" list — everything lives inside groups.
Searching expenses exists on Dashboard/Groups but there's no browsable,
filterable history like Ledgerly's Transactions page, no periods beyond
This month/All, no account balances at all. The two "Select Time Period"
toggles (This month / All) are the entire time model.

### 5. Toast overlaps the page title
The "Welcome!" success toast renders directly over the "Dashboard" heading
(top-center) rather than in a reserved position. Minor, but Ledgerly's
bottom-center toast placement avoids exactly this.

### 6. Dead-end 404 styling
Guessing a wrong URL lands on a bare 404 with a "Go to Dashboard" button —
fine, but the sidebar/nav chrome disappears entirely, which is disorienting
inside a logged-in app. Ledgerly keeps chrome on unknown routes.

---

## Neutral notes (context, not action items)

- Stack appearance: Tailwind utility classes visible in DOM, Next.js-style
  routing (`/groups/new`, `/restaurant-bill/new`), localStorage-based session
  (cookies alone didn't carry auth to a second browser context — mirrors
  Supabase-style client auth).
- Auth: Google OAuth primary (large filled button), email+password secondary
  (ghost button reveals inline form). Login page sells trust badges: "No
  credit card · Free forever · Made in India".
- Branding: lime-green ₹ logo, green primary buttons, blue secondary/CTA
  buttons — two competing accent hues (green nav/brand vs. blue actions),
  where Ledgerly uses one accent consistently.
- Dark mode toggle present in the top bar (moon icon), same convention as
  Ledgerly.
- Referral program (code + "Share on WhatsApp") built into Profile — WhatsApp
  as the primary share channel is the right call for the market and would also
  suit Ledgerly's invite-friend flow if it ever needs a share mechanism.

## Suggested Ledgerly follow-ups (smallest first)

1. **UPI deep-link/QR on Settle up** — closes the settlement loop; no new deps
   (QR can be a data-URI SVG or a `upi://` link on mobile).
2. **Three-horizon spending line** (month/week/today) inside the mobile
   Expense card — data already loaded, pure layout.
3. **"Just divide by N" quick split mode** in the split editor — an equal-split
   escape hatch that skips participant selection.
4. **Item-level restaurant split** (with Veg/Non-Veg/Common tags) — the only
   big feature here Ledgerly genuinely lacks; would be its own phase and should
   wait until the audit phases are done.
