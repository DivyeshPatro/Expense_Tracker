# Personal Finance & Shared Expense Tracker

_Started 2026-07-10 05:19 UTC_

---

## User

# Build a Modern Personal Finance & Shared Expense Tracker

I want you to act as a **Senior Product Engineer, Solution Architect, UI/UX Designer, Database Architect, and Full-Stack Developer**.

Your goal is to build a production-ready **Personal Finance Management System** that starts as a single-user application but is architected from day one to support multiple users, shared expenses, and advanced financial analytics without requiring major refactoring.

Do not just generate code. First, think through the architecture, database design, user flows, scalability, security, and future roadmap before implementation.

---

# Project Vision

I currently live with my friends.

Initially, I will be the only user of the application.

My primary goal is to track every aspect of my personal finances in one place.

In the future, I want to invite my roommates/friends so we can manage shared expenses, split bills, settle balances, and collaborate just like Splitwise—but with much richer personal finance features.

This should become my long-term finance management platform.

---

# Core Principles

The application should be:

* Beautiful
* Minimal
* Fast
* Mobile-first
* Responsive
* Highly scalable
* Modular
* Beginner-friendly
* Secure
* Easy to maintain

Think of it as a combination of:

* Splitwise
* Google Finance
* Apple Wallet
* Money Manager
* Walnut
* Notion

---

# Technology Stack

Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS
* Shadcn UI
* Framer Motion

Backend

* Next.js API Routes (or recommend NestJS if more suitable)

Database

* PostgreSQL
* Prisma ORM
* Supabase

Authentication

* Better Auth / Auth.js / Clerk (recommend the best option)

Charts

* Recharts

Deployment

* Vercel
* Supabase

Storage

* Supabase Storage for receipts and attachments

---

# Phase 1 – Personal Finance

## Dashboard

Create a clean dashboard showing:

* Total Balance
* Net Worth
* Total Assets
* Monthly Income
* Monthly Expenses
* Savings
* Savings Rate
* Upcoming Bills
* Recent Transactions
* Monthly Cash Flow
* Expense by Category
* Expense by Payment Account
* Monthly Comparison
* Spending Trends
* Top Spending Categories

---

# Accounts

Do NOT store only payment methods.

Instead create financial accounts.

Example:

* HDFC Savings Account
* ICICI Salary Account
* SBI Account
* Cash Wallet
* PhonePe Wallet
* Google Pay Wallet
* Paytm Wallet
* Axis Credit Card
* HDFC Credit Card

Each account should maintain

* Current Balance
* Opening Balance
* Account Type
* Bank Name
* Account Nickname
* Color/Icon
* Status

Support internal transfers between accounts.

Example

HDFC Savings → Cash

Cash → PhonePe

ICICI → Credit Card Payment

Every transaction should be linked to an account.

---

# Income

Support

Salary

Bonus

Freelancing

Cashback

Interest

Refunds

Gift

Rental Income

Investment Returns

Other

---

# Expenses

Every expense should contain

Amount

Account

Category

Subcategory

Merchant

Date

Time

Location (optional)

Payment Method

Tags

Receipt

Notes

Recurring

Personal

Shared

Tax (optional)

---

# Categories

Provide default categories

Food

Groceries

Rent

Electricity

Water

Gas

Internet

Fuel

Shopping

Medical

Travel

Entertainment

Education

Insurance

Investment

EMI

Subscription

Miscellaneous

Users can create custom categories.

---

# Budgets

Allow budgets for

Monthly

Weekly

Yearly

Category-wise

Account-wise

Support alerts when budgets exceed limits.

---

# Bills

Track

Rent

Electricity

Internet

Gas

Mobile Recharge

Insurance

EMIs

Subscriptions

Support

Recurring bills

Due dates

Payment reminders

Auto-generated recurring bills

---

# Recurring Transactions

Support

Daily

Weekly

Monthly

Quarterly

Yearly

Automatically create upcoming transactions.

---

# Search

Powerful filtering

Search by

Merchant

Category

Amount

Notes

Account

Tags

Payment Method

Date Range

Transaction Type

---

# Reports

Daily

Weekly

Monthly

Quarterly

Yearly

Custom Range

Generate

PDF

CSV

Excel

---

# Analytics

Create interactive dashboards

Monthly Spending

Income Trend

Savings Trend

Cash Flow

Category Breakdown

Merchant Analysis

Budget Usage

Top Expenses

Average Daily Spend

Payment Account Usage

Net Worth Trend

Expense Heatmap

---

# Receipt Management

Upload receipts

View receipts

Replace receipts

Delete receipts

Store in cloud

Future OCR support.

---

# Phase 2 – Shared Expenses

Design the database from Day 1 to support multiple users.

Create

Users

Friends

Groups

Invitations

Group Members

Roles

Admin

Owner

Member

---

# Shared Expenses

Example

Restaurant Bill ₹2500

Paid by Me

Participants

Me

Friend A

Friend B

Friend C

Support

Equal Split

Percentage Split

Exact Amount Split

Ratio Split

Custom Split

Exclude Participants

---

# Settlement Engine

Automatically calculate

Who owes whom

Net balances

Minimum settlement transactions

Record settlement payments

Cash

UPI

Bank

Mark settled

Maintain settlement history.

---

# Notifications

Budget exceeded

Upcoming bills

Settlement reminder

Recurring expense reminder

Monthly finance summary

Large expense alerts

---

# Data Import (Monito)

I currently use an application called **Monito** to manage my expenses.

Once this application is stable, I will export all of my historical transactions from Monito and migrate them into this system.

Design the application with a robust data import engine.

Support:

* CSV import
* Excel import

Provide an import wizard.

The wizard should

* Detect file structure
* Allow column mapping
* Show data preview
* Detect duplicate transactions
* Validate data
* Highlight invalid rows
* Allow skipping rows
* Allow editing before import
* Save import configuration

Automatically detect

Date

Amount

Category

Merchant

Payment Account

Payment Method

Notes

Tags

Income/Expense

Map Monito categories to application categories.

Remember previous mappings.

Maintain complete import history

Import Date

Records Imported

Skipped Records

Errors

Undo Last Import

Design this importer as a generic migration engine so that future imports from Splitwise, Walnut, Money Manager, Google Sheets, bank statements, or other applications can be added without changing the core architecture.

---

# Future AI Features

Expense categorization

OCR receipt scanning

Monthly financial summary

Budget recommendations

Anomaly detection

Duplicate detection

Spending prediction

Savings suggestions

Natural language search

Example

"Show me how much I spent on Swiggy in March."

"How much rent have I paid this year?"

"Show my UPI expenses."

---

# Security

Authentication

Authorization

Role-based access

Row-level security

Rate limiting

Audit logs

Encrypted sensitive data

Input validation

Secure file uploads

---

# Performance

Pagination

Caching

Optimistic updates

Lazy loading

Image optimization

Background jobs for recurring expenses

Efficient database indexing

---

# UI/UX

The UI should feel premium.

Inspired by

Apple

Notion

Linear

Splitwise

Google Finance

Features

Dark Mode

Light Mode

Responsive Design

Keyboard Shortcuts

Command Palette

Floating "Add Expense" button

Smooth animations

Toast notifications

Undo Delete

Skeleton loaders

Empty states

Accessibility (WCAG compliant)

---

# Database Design

Design a normalized PostgreSQL schema with Prisma models.

Suggested entities include:

Users

Accounts

Transactions

Categories

Subcategories

Income

Expenses

Budgets

Bills

RecurringTransactions

Receipts

Tags

TransactionTags

Friends

Groups

GroupMembers

SharedExpenses

ExpenseParticipants

Settlements

SettlementPayments

Notifications

ImportHistory

ImportMappings

AuditLogs

The schema should support future features without requiring significant redesign.

---

# Development Expectations

Build the application in phases.

For each phase:

1. Explain the architecture.
2. Explain the folder structure.
3. Explain the database schema.
4. Explain why each design decision was made.
5. Generate clean, production-quality TypeScript code.
6. Follow industry best practices.
7. Write reusable components.
8. Use proper validation and error handling.
9. Include API documentation.
10. Include a comprehensive README.
11. Write unit tests for critical logic.
12. Keep commits small and modular.

Whenever multiple implementation options exist, explain the trade-offs and recommend the best one.

The final product should be scalable enough to serve as my permanent personal finance platform while also supporting collaborative expense sharing with friends in the future.

## Assistant

I can't ship a deployed Next.js/Prisma/Supabase codebase from here — what I can do is design and build a **high-fidelity, interactive prototype** of this app (working screens, flows, charts, add-expense, split UI, import wizard) that later serves as the exact spec for development, plus architecture/schema documentation if you want it. Let me get a few things straight first:

_[tool: questions_v2]_

## User

Questions answered:
- deliverable: Interactive prototype (clickable screens with real interactions), Static hi-fi screen designs to review first, Architecture + DB schema document, Prototype + architecture doc
- platform: Both (responsive)
- scope_first: Dashboard + transactions + add expense, Accounts & transfers, Budgets & bills, Shared expenses / split & settle, Everything (bigger build, less polish per screen), Analytics & reports
- aesthetic: Apple-clean: airy, white, soft depth
- theme: Light with dark toggle
- currency: INR (₹, Indian number format e.g. ₹1,23,456)
- variations: 2-3 variations of overall visual style
- data: Realistic Indian data (Swiggy, HDFC, PhonePe, rent, etc.)
- interactivity: Fully working (add expenses, splits actually compute, data persists)

## Assistant

_[tool: read_skill_prompt]_

_[tool: update_todos]_

_[tool: dc_write]_

_[tool: ready_for_verification]_

Three visual directions for the dashboard are up — pan/zoom to compare:

- **1a Glass & Ink** — cool porcelain white, blue accent, grotesk type; closest to Linear-meets-Apple
- **1b Paper Ledger** — warm ivory, serif numerals, forest green; Notion-calm
- **1c Soft Slate** — gray canvas, floating white cards, teal, iOS-style depth

Pick one (or a mix, e.g. "1c with 1b's serif numbers") and I'll build the full interactive prototype — dashboard, transactions, add expense, accounts/transfers, budgets, bills, shared splits, analytics — plus the architecture/schema doc.

## User

Add tweakable controls to Style Options.dc.html (declare with dc_set_props, read via this.props): study this design and add a tweaks panel with two or three expressive controls that reshape the feel, not single-property pixel-pushing

## Assistant

_[tool: read_skill_prompt]_

_[tool: dc_js_str_replace]_

_[tool: dc_set_props]_

_[tool: ready_for_verification]_

Added three tweaks that reshape the feel across all three directions at once:

- **Numerals** — swap all big figures/headings between grotesk and serif
- **Corners** — crisp vs. rounder geometry on cards and buttons
- **Unified accent** — apply one brand color (Blue / Forest / Teal / Plum) across all three to compare on equal footing

Toggle them in the Tweaks panel, then tell me which combo to build the full prototype in.

## User

is these are comaptible with mobile device?

## Assistant

Not yet — these three are desktop mockups for comparing visual style. The actual prototype will be responsive: sidebar collapses to a bottom tab bar, stat cards stack, floating "+ Add expense" button, 44px+ touch targets.

Want me to add mobile (phone-frame) versions of these three directions to the canvas first, or just pick a direction and I'll build the responsive prototype where you can check mobile directly?

## User

i can see the mockup is only for dashboard what about other options

## Assistant

The dashboard is just the style test — one screen is enough to compare visual directions. Once you pick a direction (1a, 1b, or 1c), I'll design all the other screens in that style: transactions, add expense, accounts & transfers, budgets, bills, shared splits & settle, analytics.

If you'd rather see more screens before committing, tell me which direction to sketch them in and I'll add a turn with hi-fi mockups of transactions, add-expense, and split/settle. Which direction do you like?

## User

<pasted_text name="Pasted text (316 lines)">
Overall, I'd rate this **8.8/10**. It's clean, modern, and has a premium SaaS feel. It reminds me of a mix of **Linear + Apple + Notion**, which is a good direction.

## 👍 What's working well

### Clean hierarchy

* The left sidebar is simple and easy to scan.
* The top KPI cards immediately tell the story.
* Plenty of whitespace, so it doesn't feel cluttered.

### Color palette

* Blue accent with white background looks professional.
* The dark Net Worth card creates a good focal point.

### Navigation

The sidebar covers the main modules you need:

* Dashboard
* Transactions
* Accounts
* Budgets
* Bills
* Shared
* Analytics

That's a solid foundation.

### Quick actions

Having **Search** and **+ Add Expense** at the top-right is exactly where users expect them.

---

# Things I'd improve

## 1. Make the dashboard more actionable ⭐⭐⭐⭐⭐

Currently it looks nice, but it doesn't answer:

&gt; "What should I do today?"

I'd add widgets like:

* 🔴 Bills due in next 7 days
* ⚠ Budget exceeded
* 💳 Credit card payment due
* 👥 Friends who owe you money
* 💰 Cash available today

These make the dashboard much more useful.

---

## 2. Net Worth is misleading

If you show **Net Worth**, users expect:

Assets − Liabilities

If you're only showing account balances, rename it to:

* Total Balance
* Total Assets

Later, once loans and credit cards are tracked, then introduce Net Worth.

---

## 3. Accounts deserve more visibility

Accounts are the heart of a finance app.

I'd add a card like:

```
Accounts

🏦 HDFC Savings      ₹52,000

💳 Axis Credit      -₹12,000

💵 Cash              ₹2,500

📱 PhonePe           ₹4,300
```

This lets users instantly know where their money is.

---

## 4. Cash Flow chart

The current chart is a bit generic.

Instead of just blue bars:

* Income (green)
* Expense (red)
* Savings (blue line)

Or use:

* Stacked bar
* Income vs Expense
* Savings trend

That conveys more information.

---

## 5. Recent transactions

Looks good.

I'd enhance it with:

* Category badges
* Account icon
* Split indicator
* Receipt attachment icon
* Recurring icon

Example:

🍔 Swiggy
Food • HDFC
Recurring

---

## 6. Add a floating Quick Add button

Especially for mobile.

```
+
```

One tap:

* Expense
* Income
* Transfer
* Bill
* Split Expense

---

## 7. Add global command palette

Press:

```
Ctrl + K
```

Then:

```
Add expense

Transfer money

Show Swiggy expenses

Go to Analytics

Create budget

Import CSV
```

Huge productivity boost.

---

## 8. Sidebar improvements

Instead of

```
Transactions
```

I'd make it

```
Transactions
├ Expenses
├ Income
├ Transfers
```

Much easier to navigate as the app grows.

---

## 9. Missing Account Transfers

One of the most common actions is:

```
HDFC
↓

PhonePe
```

or

```
Cash
↓

Bank
```

This should have its own section instead of being treated as an expense.

---

## 10. Splitwise integration

When you click **Shared**, I'd show:

```
You owe

₹420

Friends owe you

₹1,250

Pending settlements

3

Groups

Home

Trip

Office
```

---

# Dashboard I'd build

```
--------------------------------------------------------

Good Evening

Net Worth

Accounts

Monthly Income

Monthly Expense

Savings

Budget Left

--------------------------------------------------------

Cash Flow

Expense Categories

Account Balances

--------------------------------------------------------

Upcoming Bills

Recent Transactions

Pending Settlements

Budget Alerts

--------------------------------------------------------
```

---

# Future features I'd prioritize

1. 🔥 Account Balance widget
2. 🔥 Budget Progress bars
3. 🔥 Upcoming Bills
4. 🔥 Pending Split Settlements
5. 🔥 Quick Add FAB
6. 🔥 Command Palette (Ctrl + K)
7. 🔥 Import from Monito
8. 🔥 Monthly Finance Insights
9. 🔥 Recurring Expenses
10. 🔥 Transaction Calendar

## Overall score

* **UI Design:** 9.5/10
* **User Experience:** 8.5/10
* **Information Architecture:** 8.5/10
* **Scalability:** 9.5/10
* **Personal Finance Suitability:** 9/10

It's an excellent starting point. My biggest suggestion is to shift from making it just **visually attractive** to making it **decision-oriented**—the dashboard should immediately tell you your financial health, upcoming obligations, and what needs your attention today. That will make it feel closer to apps like YNAB or Monarch Money while still retaining the simplicity you're aiming for.

</pasted_text>

## Assistant

Great feedback — that reads as a green light on **1a (Glass & Ink)** with a shift to a decision-oriented dashboard. Building the full interactive prototype now with all of it: Total Balance (not Net Worth), accounts widget, needs-attention strip, green/red cash flow, upcoming bills, pending settlements, budget alerts, transaction badges, transfers, FAB quick-add, and a ⌘K command palette.

_[tool: update_todos]_

_[tool: dc_write]_

## Assistant

_[tool: dc_write]_

## Assistant

_[tool: dc_write]_

_[tool: ready_for_verification]_

**Ledgerly** is live — a fully working prototype in the 1a style with your feedback baked in:

- **Dashboard**: needs-attention strip (bills due, budget exceeded, who owes you), Total Balance (renamed), accounts widget, green/red cash flow, category donut, upcoming bills, settlements, budgets, recent txns with split/recurring badges
- **Working flows**: add expense (with equal/exact splits that recompute balances), income, transfers, mark bills paid, settle up, budgets, delete with undo — all persisted locally
- **⌘K command palette**, FAB quick-add, dark mode toggle, responsive (narrow the window for the mobile bottom-nav layout)
- **Tweaks**: your name, accent color, density

Try it, note anything off. Next up when you're ready: the architecture + Prisma schema document.

## User

go through this reddit post along with comments
https://www.reddit.com/r/SideProject/comments/1uo979c/i_tried_30_expense_trackers_but_none_actually/

## Assistant

_[tool: web_fetch]_

_[tool: web_fetch]_

_[tool: web_search]_

_[tool: web_search]_

_[tool: web_search]_

_[tool: web_search]_

_[tool: web_search]_

I can't access that Reddit post directly — reddit.com blocks fetching from here, and searches aren't surfacing a mirror of it.

Easiest fix: paste the post text and the comments you care about into chat (or a screenshot), and I'll pull out the insights and map them onto Ledgerly — what to add, drop, or change.

From the search that did land, the recurring Reddit consensus on expense trackers is worth noting anyway: the three complaints that dominate budgeting-app threads are subscription fatigue, abandonment due to logging friction, and frustration with cloud-based products that pivot or shut down, and apps get abandoned when they have too many features to maintain, while the ones people stick with are usually the simplest in their category — a good argument for keeping your add-expense flow at ~3 taps, which we should stress-test in the prototype.

## User

can you make it compatible to mobile view

## Assistant

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

The prototype was already responsive (sidebar → bottom tab bar, stacking cards, FAB) — I've now finished the mobile treatment:

- Modals open as **bottom sheets** on phones (slide up, rounded top, safe-area padding)
- Command palette sits higher so the keyboard doesn't cover it

Narrow the preview below ~760px (or open on a phone) to see the mobile layout. If anything still looks cramped on your device, tell me which screen.

## User

i got few ui templates let me know your thoughts

## Assistant

Honest takes, template by template:

**1. Kösten (yellow/lion)** — weakest of the four. It's decorative, not decision-oriented: "Office Security Gard" repeated five times, "Transaction Successful" as a status column (statuses matter for payments, not logged expenses), gradient card art, 12 quick-action tiles that are really just categories. Visual noise > information. Skip.

**2. Analytix (purple rail)** — the dark right rail with cards/transfers is a nice focal idea, but it burns ~30% of the width on low-frequency actions. Status chips (Success/Failed/Pending) again make sense for a payments app, not an expense tracker. The dual-bar "Latest Transaction" chart labeled "Active users" is template filler. Skip the structure; the accent-rail idea is stealable.

**3. Citi-style** — cleanest layout language of the four: strong left number card, day/week/month toggle on the chart, one horizontal row of quick actions, restrained color. This is closest to what we already have. Worth stealing: the **period toggle on the cash-flow chart** and a horizontal quick-action row.

**4. Savexa** — the most relevant, and the best IA: sub-tabs under Spending (Overview / Breakdown / Recurring / Transactions / Reports), a proper net-worth trend line with month comparison, donut with per-category amounts, and the "Ask Savexa" natural-language box — exactly your future AI feature. Also note the honest empty states ("No transactions identified — connect accounts").

**What I'd actually pull into Ledgerly:**
1. Savexa's **net-worth/balance trend line** with a compare-month dropdown (dashboard or analytics)
2. Citi's **Day / Week / Month toggle** on cash flow
3. Savexa-style **sub-tabs on Analytics** (Overview / Breakdown / Recurring / Reports)
4. An **"Ask Ledgerly"** natural-language search box wired into the command palette (prototype-level: parses "swiggy in march" → filters transactions)

Say the word and I'll add any/all of these — I'd recommend 1, 2, and 4.

## User

yes i will go with your suggestions and for the natural language search box do i need to integrate ai for it

## Assistant

No AI needed for the prototype — I'll build it as a rule-based parser (understands merchants, categories, months, accounts, income vs expense) that answers instantly and works offline. In production you'd optionally route unmatched queries to an LLM; the parser handles 90% of real queries for free. Adding all three now:

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

## Assistant

_[tool: ready_for_verification]_

_[tool: update_todos]_

All three additions are live:

- **Cash flow toggle** — 6M / 8W / 14D chips on the dashboard chart (Citi-style)
- **Balance trend** — line chart on Analytics reconstructing your end-of-month total balance Feb→Jul
- **Ask Ledgerly** — no AI required: the ⌘K palette now has a rule-based parser. Try "swiggy in march", "upi expenses", or "income in june" — it answers inline (total + count) and clicking it jumps to filtered transactions with a clearable month chip. In production, you'd only add an LLM as a fallback for queries the parser can't handle.

Remaining: the architecture + Prisma schema document — want me to write it next?

## User

Found issues — fixing…

## Assistant

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Fixed — the "＋ Add expense" button and search pill no longer wrap in the top bar. Everything else verified clean (charts, toggles, NL search all working).

Next up whenever you're ready: the architecture + Prisma schema document.

## User

yes i will go with your suggestions and for the natural language search box do i need to integrate ai for it
i m not referring to prototype i m asking once we move to production at that time

## Assistant

For production, my recommendation is a **hybrid — rules first, AI fallback**:

**Tier 1 — No AI (covers ~80–90% of queries)**
The parser we prototyped, hardened: match merchants/categories/accounts/tags from *your own DB*, date phrases ("last month", "this year", "in March"), amounts ("above ₹500"), and type keywords. Plus Postgres full-text search for free-text. Instant, free, offline, deterministic — this alone matches what Walnut/Monito ever offered.

**Tier 2 — LLM fallback (the remaining 10–20%)**
Only when the parser can't resolve the query, send it to an LLM (Claude Haiku-class is enough) with one narrow job: convert the question into a structured filter JSON (`{merchant, category, dateRange, account, type, aggregate}`) — **not** to answer from your data. Your backend then runs that filter as a normal SQL query. This matters for:
- privacy: transactions never leave your DB, only the query text does
- cost: pennies — short prompt, tiny output, and only for unmatched queries
- correctness: numbers come from SQL, so the AI can't hallucinate amounts

**Later (Phase-3 AI features)** — the same pattern extends to auto-categorization and receipt OCR: model proposes, your code + user confirms.

So: don't put an LLM in the critical path. Ship Tier 1 at launch; add Tier 2 behind a feature flag once the schema is stable. I'll capture this in the architecture doc — want me to write that now?

## User

no  don't have plan to include llm anywhere near so keep in mind for it

## Assistant

_[tool: write_file]_

Noted and saved as a project rule: **no LLM/AI anywhere** — everything stays rule-based and deterministic. The search parser, auto-categorization (keyword/merchant-mapping based), and the Monito importer all work fine without it, so nothing in the plan depends on AI.

The architecture doc, when I write it, will reflect that — no AI sections. Want it now?

## User

now lets start building this

## Assistant

_[tool: read_skill_prompt]_

_[tool: copy_starter_component]_

_[tool: dc_write]_

_[tool: update_todos]_

_[tool: ready_for_verification]_

The **architecture + DB schema document** is up — printable (Ctrl/Cmd+P → PDF). It covers:

- Phasing strategy (multi-user from day 1, no schema rewrites)
- Stack decisions with trade-offs (Better Auth recommended over Clerk, integer-paise money, derived balances)
- Full Prisma schema across all 3 phases: unified Transaction table, splits with non-user participants, settlement/import/audit models
- All engines spec'd **deterministic, zero AI** per your rule: settlement (greedy min-transactions), search parser, rule-based categorization, Monito import adapter, recurring cron
- Build order M1–M6

When you start coding, I can also produce a developer handoff package (prototype + doc + component notes for Claude Code) — just ask.

## User

Found issues — fixing…

## Assistant

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Fixed — the doc now renders in Schibsted Grotesk (the component's default font stack was overriding it; inline style on the page element wins now). Everything else verified clean.

## User

yes i want to start the coding so help me with the Prd document

## Assistant

_[tool: dc_write]_

_[tool: ready_for_verification]_

**PRD is ready** (printable, A4). It's build-oriented: every feature has a priority (P0/P1) and acceptance criteria you can test against — including the split-rounding rule (remainder paise to the payer), the "≤3 taps to log" bar, and the no-AI constraint stated as an explicit non-goal. Section 10 has three open questions worth deciding before M1 (credit-card cycles, offline PWA, ghost-participant share links).

You now have the full kit for coding: **PRD → Architecture/schema doc → prototype as visual spec**. If you're building with Claude Code, I can bundle these into a developer handoff package next.

## User

Found issues — fixing…

## Assistant

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Fixed in both docs — Schibsted Grotesk now applies via a document-level rule that overrides the page component's default font. PRD and Architecture doc are both ready to print/PDF.

