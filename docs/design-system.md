# Ledgerly Design System

The reference for how Ledgerly looks and is built. It documents the tokens,
scale, and shared components that already exist in code so new screens stay
consistent instead of re-deriving values. Everything here is enforced by
`src/app/globals.css` (tokens + utilities) and the primitives under
`src/components/shell/`.

Scope: this is the mobile-first system introduced in the v2.0 sprint. Desktop
shares the same tokens; only layout differs.

---

## 1. Color

Colors are CSS custom properties on `:root`, remapped to Tailwind color
utilities via `@theme inline` (so `bg-card`, `text-mut`, `text-acc`, etc. all
resolve a `var(--…)` at use-time). Defined in `globals.css`.

| Token | Light | Dark | Tailwind | Use |
|---|---|---|---|---|
| `--bg` | `#f6f7f9` | `#0f1115` | `bg-bg` | app ground |
| `--side` | `#fbfcfd` | `#13161b` | `bg-side` | inset panels, chart tiles |
| `--card` | `#ffffff` | `#191d24` | `bg-card` | cards, sheets |
| `--ink` | `#16181d` | `#eceef2` | `text-ink` | primary text |
| `--mut` | `#5c6473` | `#98a0b0` | `text-mut` | secondary text (AA on grounds) |
| `--mut2` | `#636a78` | `#838a99` | `text-mut2` | captions/eyebrows (AA on grounds) |
| `--line` | `rgba(22,24,29,.07)` | `rgba(255,255,255,.07)` | `border-line` | hairlines |
| `--line2` | `rgba(22,24,29,.14)` | `rgba(255,255,255,.15)` | `border-line2` | stronger borders, toggle-off track |
| `--acc` | `#2358e6` | `#4d7ef8` | `*-acc` | brand / primary action |
| `--accSoft` / `--accSoft2` | 10% / 24% acc on card | — | `bg-accsoft` / `bg-accsoft2` | tinted accent fills, active nav pill |
| `--green` | `#0f8249` | `#3fce8e` | `*-green` | positive amounts, income |
| `--red` | `#c23139` | `#f07579` | `*-red` | negative, destructive, overdue |
| `--amber` | `#8f5d00` | `#e0a63d` | `*-amber` | warnings, cash, due-soon |
| `--greenSoft`/`--redSoft`/`--amberSoft` | pale tints | dark tints | `bg-greensoft`… | status-pill backgrounds |
| `--ov` | `rgba(22,24,29,.38)` | `rgba(0,0,0,.55)` | via `var(--ov)` | modal/sheet scrim |

**Accessibility (non-negotiable):** every text/background pair must clear WCAG
AA (4.5:1). The light-mode `--acc/--green/--red/--amber/--mut2` values above were
tuned to pass — do not lighten them. Verified by an axe-core sweep: **0
violations across all 12 screens**. Re-run after any color change.

**Semantic vs accent:** green/red/amber are *state* colors (good / bad / warn),
independent of the brand accent. Don't use the accent to signal state.

**Theming:** two axes on `<html>` — `data-theme` (`light|dark`, what CSS reads)
and `data-skin`. Skins override **only** `--acc` (`violet`, `teal`, `rose`,
`slate`); every `*Soft` mix and `*-acc` utility follows automatically because
they resolve `var(--acc)` at use-time. Grounds are never skinned.

---

## 2. Typography

One family — **Schibsted Grotesk** (`--font-sans`, via `next/font`). No second
face. Weight and size carry hierarchy.

Type ramp actually in use (px, because the app opts out of rem for tight control):

| Role | Size / weight | Notes |
|---|---|---|
| Hero figure | `38px` / 800, `tracking-[-.035em]`, `tabular-nums` | net-standing amount |
| Section value | `15–17px` / 800 | card headline numbers |
| Title | `14–15px` / bold | sheet/card titles |
| Body-bold | `13.5px` / bold | primary rows |
| Body | `13px` | default |
| Caption | `11.5px` / `text-mut2` | subtitles, meta |
| Eyebrow | `10.5px` / 700, uppercase, `tracking-[.09em]`, `text-mut2` | section labels |
| Label-caps | `.label-caps` (11.5px / 700 / `--mut`) | form field labels |

Always use `tabular-nums` for money and any aligned figures.

---

## 3. Spacing, radii, elevation

**Spacing** uses Tailwind's default step scale; the recurring rhythm is
`gap-2 / 2.5 / 3 / 3.5` between siblings and `--pad` (18px) for card interiors.
Lay groups out with flex/grid + `gap`, never per-child margins.

**Radii** — named tokens (go-forward; `globals.css` `@theme`):

| Token | Value | Utility | Use |
|---|---|---|---|
| `--radius-sheet` | 20px | `rounded-sheet` | bottom sheets, hero cards |
| `--radius-card` | 14px | `rounded-card` | standard cards (`.card`) |
| `--radius-control` | 12px | `rounded-control` | primary buttons, sheet actions |
| `--radius-field` | 9px | `rounded-field` | inputs (`.field`) |
| — | `9999px` | `rounded-full` | pills, chips, toggle, FAB |

Prefer these over arbitrary `rounded-[Npx]` in new code.

**Elevation** — two tokens only: `--sh` (resting cards) and `--shLg` (floating:
sheets, popovers, toasts, the FAB). Don't invent one-off shadows.

**Breakpoint** — a single split at `md` = **760px** (`--breakpoint-md`). Below
is the mobile product; at/above is desktop. Mobile-only UI uses `md:hidden`,
desktop-only uses `hidden md:…`.

---

## 4. Motion

Three keyframes (`globals.css`): `rise` (sheets/cards — fade + 8px up), `pop`
(popovers — fade + scale), `fade` (sub-view swaps). Durations .16–.25s, `ease`.
Interactive surfaces use `active:scale-[.95–.99]` for press feedback.

**Reduced motion:** a global `@media (prefers-reduced-motion: reduce)` collapses
animations/transitions to ~0ms. Never gate *functionality* on an animation.

---

## 5. Shared utilities (`globals.css`)

- `.card` — `bg-card` + 14px radius + `--line` border + `--sh`.
- `.field` — full-width input; 9px radius, `--line2` border, accent focus ring.
- `.label-caps` — the standard form label.
- `.btn-primary` — accent-filled button (small); brighten on hover.
- `.skeleton` — pulsing accent-soft placeholder.
- `.no-scrollbar` — hides the scrollbar on horizontal strips (nav, chart rows).

---

## 6. Components (`src/components/shell/`)

Reach for these before hand-rolling.

- **`<BottomSheet>`** (`bottom-sheet.tsx`) — the one sheet: portal, backdrop
  dismiss, focus trap, Escape, initial focus, drag handle, safe-area padding,
  `rise` entrance. Bottom sheet on phones, centred dialog (`maxWidth`) on
  desktop. Backs Quick Add, the Bills action sheet, the Dashboard Customize
  sheet, and the mobile period picker. Props: `onClose`, `label` (aria), `maxWidth?`, `className?`.
- **`<Toggle>`** (`toggle.tsx`) — presentational switch track+thumb
  (`aria-hidden`); the caller owns `role="switch"`/`aria-checked`.
- **`<DateField>`** (`date-field.tsx`) — the only date/month picker. A themed,
  portaled calendar with flip/shift collision handling. Never use native
  `<input type="date"|"month">`.
- **Form primitives** (`form-primitives.tsx`) — `Field`, `AmountInput`
  (numeric `inputMode`), `ErrorNote`, and `SubmitButton` (sticky, flush to the
  modal's scroll body; 48px target). `useSubmit()` handles busy/error/double-tap.
- **Period picker** (`period-picker.tsx`) — global `📅 <period> ▾` trigger →
  `BottomSheet` (mobile) / anchored popover (desktop). Writes URL params only.

### Intentional exceptions (not on `<BottomSheet>`)
- **Transaction modal shell** (`modals.tsx`) — needs a keyboard-aware sticky
  footer (visualViewport) and a scroll body; kept bespoke on purpose.
- **Period-picker desktop popover** — anchored to its trigger with flip/shift,
  not a centred dialog.

### Chips — a pattern, not a component
Two distinct shapes, deliberately not unified:
- **Status pill** — non-interactive, colored by state
  (`bg-{red,amber,green}soft` + matching text): bill due-labels, loan status.
- **Filter/segment chip** — interactive `rounded-full` with active
  (`bg-acc`/white) vs inactive (`bg-accsoft`/`text-acc`): transaction filters,
  card gallery. Min height 32px.

---

## 7. Navigation

- **Mobile bottom nav** (`app-shell.tsx`) — one horizontally-scrollable row of
  every section (`.no-scrollbar`), a center-docked 58px Quick Add FAB raised
  above the bar with a ground ring, an accent active-pill behind the current
  tab's icon, and edge fade "scroll hints" that appear only on the side with
  more items. Tab targets 64×56.
- **Desktop** — a left sidebar (`aside`) listing all destinations. Unchanged by
  the mobile work.

---

## 8. Checklist for a new screen

1. Ground on `bg-bg`; content in `.card` / `bg-card`.
2. Type from the ramp; money in `tabular-nums`.
3. Sheets/dialogs via `<BottomSheet>`; dates via `<DateField>`; forms via the
   primitives (sticky `SubmitButton`).
4. Radii from the named scale; elevation from `--sh`/`--shLg`.
5. Touch targets ≥ 44px.
6. No horizontal overflow at 360 / 390 / 430px.
7. Run axe-core → 0 violations before shipping.
