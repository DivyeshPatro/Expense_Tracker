# Ledgerly Offline Sync — Product & Technical Design Specification

**Status:** Draft for review · no code written
**Baseline:** approved cloud-canonical outbox architecture (see `offline-sync-architecture.md` discussion)
**Scope:** everything needed to implement Phases 0–6 without making architectural decisions during coding.

---

## 1. Philosophy and non-negotiables

1. Ledgerly never prevents the user from recording a financial event.
2. The server is the canonical ledger. `applyBalances`, the reverse→apply pattern, the split-sum
   trigger, and the audit log remain the only financial engine, unchanged.
3. The client owns user intent until the server acknowledges it. No intent is ever silently
   dropped: every failure is retried automatically or shown to the human with a path to resolve.
4. No second implementation of balance semantics exists anywhere. Client-side "provisional"
   math is bounded to labeled paise addition (≤ ~30 lines), recomputed on render, never stored.
5. Sync is a first-class, visible, trustworthy feature — quiet when healthy, precise when not.
6. Dependency budget: `idb` (~1.2 kB) or a hand-rolled IndexedDB wrapper, one hand-written
   service worker. Nothing else.

## 2. Vocabulary (user-facing)

Never shown to users: *outbox, intent, queue, replay, idempotency, provisional, conflict resolution*.

| Internal term | User-facing copy |
|---|---|
| pending intent | "Waiting to sync" / "Waiting for internet" (when offline) |
| draining / syncing | "Syncing…" |
| acknowledged | "Synced" |
| needs-attention | "Needs your attention" |
| conflict | "Changed on another device" |
| outbox/queue | "Unsynced changes" |
| snapshot cache | "Offline data" |

## 3. System overview

```
┌─────────────────────────── CLIENT ────────────────────────────┐
│  UI (existing) ── enqueue ──► OUTBOX (IndexedDB)              │
│      ▲                          │  strict FIFO per user       │
│      │ pending badges,          ▼                             │
│      │ provisional deltas     DRAIN LOOP (single-flight)      │
│      │ sync center feed         │ triggers: enqueue-online,   │
│      │                          │ 'online', focus, 30s tick,  │
│  SYNC LOG (ring buffer)         │ SW background sync          │
└──────────────────────────────── │ ─────────────────────────────┘
                                  ▼  cookie auth (unchanged)
┌─────────────────────────── SERVER ────────────────────────────┐
│  Existing server actions (+ optional intentId param)          │
│    └─► zod → service → $transaction:                          │
│          [ Intent row insert  ← idempotency, unique(user,id)  │
│            reverse→apply → audit(+clientTs,deviceId,intentId)]│
│  Phase 2+: POST /api/sync (batched intents, applied in order) │
└──────────────────────────────┬────────────────────────────────┘
                               ▼
                    PostgreSQL (trigger = final arbiter)
```

The read path is unchanged: RSC pages + router cache. After a drain that applied ≥1 intent,
the client calls `router.refresh()` — the existing read model **is** the pull channel.

## 4. Data model

### 4.1 Client (IndexedDB, db name `ledgerly`, versioned)

**`outbox`** (keyPath `intentId`, index `bySeq` on `seq`, index `byStatus`)

| field | type | notes |
|---|---|---|
| intentId | uuid v4 | client-generated; server idempotency key |
| seq | autoincrement | FIFO order |
| userId | string | guards against account switch; outbox never adopted by a different user |
| deviceId | uuid | from `meta` |
| kind | enum | `expense.create` `income.create` `transfer.create` `tx.update` `tx.delete` `settle.create` … one per existing mutating action brought into scope by its phase |
| payload | JSON | exactly the zod input of the corresponding server action |
| entityId | string | client-generated cuid/uuid for creates (Prisma accepts explicit ids — no schema change); existing id for update/delete |
| baseVersion | int? | update/delete only: entity version last seen locally |
| clientTs | ISO string | when the human acted |
| status | enum | `pending` `syncing` `needs-attention` |
| attempts, nextRetryAt, lastError | — | retry bookkeeping; `lastError` is the server error code |

**`syncLog`** — ring buffer, max 200 entries: `{ts, icon, label ("₹420 · Swiggy"), status, detail?}`.
Feeds the Sync Center activity feed. Local-only, never synced.

**`meta`** — `{deviceId, deviceName, userId, lastSyncAt, schemaVersion}`.
`deviceName` derived from UA ("Chrome on Windows", "Safari on iPhone"), user-editable later.

**`snapshot`** (Phase 6 only) — last-known page data per top route for offline reading.

### 4.2 Server (one migration, Phase 0)

```prisma
model Intent {
  id        String   // intentId from client
  userId    String
  deviceId  String
  kind      String
  entityId  String
  status    String   // applied | overridden | failed
  error     String?
  clientTs  DateTime
  appliedAt DateTime @default(now())
  @@id([userId, id])
  @@index([userId, appliedAt])   // retention pruning
}
```

`Transaction` gains `version Int @default(1)`, incremented by every update service.
Audit payloads (JSON) gain `intentId`, `deviceId`, `clientTs` — no audit schema change.

**Retention:** Intent rows are an idempotency ledger, not history (audit is history). Prune
rows older than **30 days** (daily cron, alongside existing bill-rolling). Consequence: an
intent replayed after 30 days cannot be deduplicated → rejected as `STALE_INTENT` (§5).

### 4.3 Idempotency pattern (the core guarantee)

Inside the same `$transaction` as the mutation: insert the Intent row first. Unique violation
⇒ this intent already applied ⇒ return the recorded outcome without touching the ledger.
Client-generated `entityId` is the structural backstop: even if the Intent row were lost, a
double-applied create hits the primary-key constraint.

## 5. Sync protocol and error taxonomy

Phase 1 transport: existing server actions accept optional `{intentId, deviceId, clientTs, baseVersion}`.
Phase 2 adds `POST /api/sync` accepting an ordered intent array (one round trip per drain),
returning per-intent results. Same taxonomy either way:

| Code | Meaning | Client behavior |
|---|---|---|
| `OK` | applied | remove from outbox; log "Synced" |
| `DUPLICATE` | already applied earlier | treat as OK |
| `OK_OVERRIDE` | applied, but overwrote a newer server version (solo LWW, §13) | treat as OK; log "Synced (replaced an edit from {device})" |
| `RETRYABLE` | network, 5xx, 429 | backoff 1s·2ⁿ + jitter, cap 5 min |
| `AUTH_EXPIRED` | session gone | hold entire queue; prompt sign-in; drain after (same user only) |
| `CONFLICT` | baseVersion mismatch on a **shared** record; response carries server version | → needs-attention (conflict card) |
| `INVALID_REF_SOFT` | referenced **category** deleted | server auto-heals: applies with `categoryId=null`; client logs notice "Synced — category was deleted, now uncategorized" with a one-tap re-categorize |
| `INVALID_REF_HARD` | referenced **account / participant / group** gone | → needs-attention (guided fix) |
| `VALIDATION` | zod / trigger rejection | → needs-attention |
| `STALE_INTENT` | older than idempotency window | → needs-attention: "Too old to sync automatically — review and re-add" |

**Poison-pill rule:** `RETRYABLE` intents park as needs-attention after **24 h or 20 attempts**,
whichever first — a permanently-erroring intent must not block the queue forever.

**Ordering rule:** strict FIFO, except a needs-attention intent blocks only later intents that
share its `entityId`; unrelated intents continue draining.

## 6. Transaction status lifecycle

```
 form submit ──► PENDING ──► SYNCING ──► SYNCED (terminal; badge fades out)
                  │  ▲           │
   edit payload ──┘  │           ├─ RETRYABLE ──► PENDING (backoff; copy varies)
   (coalesce in      │           ├─ 24h/20 tries ─► NEEDS ATTENTION
    place)           │           └─ terminal error ► NEEDS ATTENTION
   delete ═ CANCELLED┘                                  │
   (local only, undoable 5s)            edit&requeue ◄──┼──► discard (audited locally)
                                        keep-mine/keep-theirs (conflict card)
```

| State | Icon | Color token | Row copy | Animation | User actions |
|---|---|---|---|---|---|
| Pending (online) | ⏳ | `--mut2` | "Waiting to sync" | none | edit (coalesces), delete (cancels) |
| Pending (offline) | ⏳ | `--mut2` | "Waiting for internet" | none | same |
| Retrying | ⏳ | `--mut2` | "Will retry automatically" | none | same — retrying is not a distinct user-visible state |
| Syncing | ⟳ | `--acc` | "Syncing…" | 0.8s linear rotation | none (sub-second normally) |
| Synced | — | — | no badge; **absence is the signal** | badge fades out 300ms | normal tx actions |
| Needs attention | ⚠ | `--red` / `--redSoft` bg | "Needs your attention" | none — severity stays calm | tap → resolution view |
| Conflict (subtype) | ⚠ | `--amber` / `--amberSoft` | "Changed on another device" | none | tap → conflict card |
| Cancelled | — | — | toast: "Removed — it was never synced" | — | Undo (5s, restores intent) |

Design rule: a synced ledger shows **zero** sync chrome. Persistent ✓ on every row would
teach users to ignore the one badge that matters.

## 7. Surface map — where sync appears

| Surface | Healthy (online, empty queue) | Pending | Needs attention |
|---|---|---|---|
| Transaction list row | nothing | ⏳ before amount | ⚠ + red left-edge accent |
| Transaction detail sheet | nothing | status line: "⏳ Waiting to sync · will happen automatically" | status line + Fix / Discard actions; conflict card if applicable |
| Dashboard | nothing | chip only if **offline**: "Offline — 3 changes will sync automatically" (taps → Sync Center) | red chip: "1 change needs attention" |
| Balance hero & Accounts | nothing | footnote: "includes 2 unsynced changes" (taps → Sync Center); per-account footnote where deltas apply | footnote: "1 change not included — needs attention" |
| Bottom navigation | nothing | **nothing** (routine pending must not train users to ignore badges) | existing red-dot convention on **More** |
| More sheet / Settings row | "Sync — Up to date ✓" | "Sync — 2 waiting" | "Sync — 1 needs attention" + red dot |
| Sync Center | full view (§8) | full view | full view |
| Toasts | none for routine sync | none | on transition into needs-attention while app open: toast "₹900 Group dinner needs your attention" → taps through |

Transient `syncing` never flashes page-level UI; at normal speed it would be sub-second strobing.

## 8. Sync Center (Settings → Sync, route `/settings/sync`)

The trust anchor. Reuses card + list-row visual language; feels like Ledgerly, not a debug panel.

```
┌──────────────────────────────────────────────┐
│  ✓  Everything is synced                     │   ← status hero; one of:
│     Last sync: 2 minutes ago                 │     ✓ green / ⏳ "Waiting for
│                                              │     internet" / ⚠ red
├──────────────────────────────────────────────┤
│  Waiting to sync                        2 ›  │   ← rows hidden when zero
│  Needs attention                        1 ›  │
├──────────────────────────────────────────────┤
│  RECENT ACTIVITY                             │   ← syncLog ring buffer,
│  ✓  Synced           ₹420 · Swiggy     2m    │     newest first, ~20 shown,
│  ✓  Synced           ₹25,000 · Salary  2m    │     "Show more" → 200 cap
│  ⏳  Waiting for internet ₹180 · Uber   1h    │
│  ⚠  Needs attention  ₹900 · Group dinner 3h  │   ← row taps into resolution
│  ✓  Synced (uncategorized) ₹90 · Chai  1d    │   ← soft-heal notice
├──────────────────────────────────────────────┤
│  [ Sync now ]         [ Retry failed ]       │   ← Retry failed hidden if 0
├──────────────────────────────────────────────┤
│  THIS DEVICE                                 │
│  Chrome on Windows · added 3 Jul             │
│  Offline data: 1.2 MB    Background sync: ✓  │   ← per-platform truth (§16)
│  Advanced ›  (export sync log · clear        │
│              offline data)                   │
└──────────────────────────────────────────────┘
```

- **Sync now**: always available even though sync is automatic — it exists for *trust*, not
  necessity. Spins in-button; ends in toast "Up to date ✓" or the relevant error surface.
- **Retry failed**: re-queues all needs-attention items whose error was `RETRYABLE`-parked;
  items with structural errors (conflict, invalid ref) are excluded — they need decisions,
  and the button never pretends otherwise.
- **Activity feed** entries are local (per-device) — labeled "on this device" in the header
  the first time other devices exist. Multi-device unified history is a non-goal for V1
  (the audit log already holds canonical history server-side).

## 9. Dashboard and balances

**Decision: balances include pending, excluded needs-attention, one number only.**

- The user's model is "I spent it." A hero balance that ignores their last three entries
  reads as *wrong*; a labeled inclusive balance reads as *live*. So:
  `displayed = last-synced server balance + Σ(pending intent deltas)`.
- Delta math is pure paise addition: expense −amount on its account; income +; transfer
  −from/+to; split shares from the already-existing client-side `computeSplitInfo` preview.
  Recomputed every render, never persisted, capped in complexity by philosophy rule #4.
- No second "provisional balance" figure — two numbers create the confusion they claim to solve.
  The footnote ("includes 2 unsynced changes") is the entire explanation, and it links to the
  Sync Center for anyone who wants the details.
- **Needs-attention amounts are excluded from all math** and the footnote says so:
  disputed money is never silently counted.
- The "N changes waiting to sync" chip appears **only when offline** (or on needs-attention).
  When online, pending drains in ~1s; flashing banners for sub-second states is noise.

## 10. Settings — Sync section spec

| Row | Content | Behavior / rationale |
|---|---|---|
| Sync status | hero + last-sync (relative time) | entry point; summary duplicated from Center |
| Waiting to sync | count | → queue view (§11) |
| Needs attention | count, red | → queue view filtered |
| Offline data | "1.2 MB" | snapshot + outbox + log size via `navigator.storage.estimate()` |
| Background sync | "Automatic ✓" / "When app is open" (iOS) | informational, not a toggle — honest per-platform capability (§16); no Wi-Fi-only option (payloads are KB-scale JSON) |
| This device | name + added date | device identity for conflict copy ("Changed on Chrome on Windows") |
| Sync now | button | §8 |
| Advanced → Export sync log | downloads syncLog + outbox metadata (no auth material) as JSON | support/debugging; cheap, valuable |
| Advanced → Clear offline data | wipes snapshot only — **never touches outbox** | safe; re-downloads on next visit |
| ~~Clear pending~~ | **deliberately omitted** | a bulk discard-my-unsynced-money button is a foot-gun; discard exists per-item in the queue view with a named confirmation ("Discard ₹180 Uber? It was never synced."). If bulk discard is ever demanded, it requires listing every item + typed confirmation — but the recommendation is to not build it |

Sign-out (existing button, sidebar): if outbox non-empty → blocking dialog: "2 unsynced
changes will be lost — ₹180 Uber, ₹90 Chai. Sync before signing out?" [Sync now] [Sign out
anyway] [Cancel]. On confirm: outbox, snapshot, log, meta fully wiped.

## 11. Queue experience

**Do users see the queue? Ambient yes, management no.**

Reasoning: pending items already live in the transaction list wearing badges — *the ledger
is the queue view*, in context, where users already look. A dedicated queue screen exists
inside the Sync Center for inspection and for failures, but nothing ever requires visiting it.
Users should never *manage* a queue (reorder, prioritize) — ordering is a correctness
concern (FIFO, §5), not a preference.

Queue view (`Sync Center → Waiting to sync / Needs attention`):
- **Ordering:** needs-attention pinned on top (they need eyes); then pending, oldest first —
  matching actual sync order, so the list reads as "what happens next".
- **Row:** icon+status, label (₹420 · Swiggy · Food), relative time, chevron.
- **Tap →** the existing transaction detail sheet with the sync status line and actions:
  - Pending: *Edit* (coalesces payload in place — no second intent), *Remove* (cancel; undo 5s).
  - Needs attention: scenario-specific guided fix (§12), *Discard* (named confirmation).
- **Retry:** no per-item retry button for pending items (they retry themselves; showing a
  button implies they don't). "Retry failed" exists at the Center level for parked items.

## 12. Failure UX catalog

Copy rules: name the amount and merchant, say what happened in plain past tense, offer one
primary action, never use error codes or the words *sync conflict/validation/queue*.

| Scenario | What the user sees (detail sheet / resolution card) | Primary action |
|---|---|---|
| Account deleted on another device | "The account **HDFC Savings** no longer exists, so **₹180 · Uber** couldn't be saved. Pick another account." | Opens edit form, account field focused, everything else pre-filled → requeues |
| Category deleted | *(auto-healed — not a failure)* Activity feed: "✓ Synced — **Snacks** was deleted, so ₹90 · Chai is now uncategorized." | Inline "Choose category" (normal edit, no urgency) |
| Participant removed from group | "**Priya** is no longer in **Flat 402**. Re-split **₹900 · Group dinner** among the remaining 3 people?" | [Re-split equally] (one tap, requeues) / [Edit split] / [Discard] |
| Group deleted | "**Flat 402** was deleted, so this split couldn't be saved. Keep it as a personal expense instead?" | [Keep as personal ₹300 (your share… )] — careful: default to full amount with the split removed, clearly stated / [Discard] |
| Shared record edited by someone else (conflict) | Conflict card: "This changed while you were away." Two stacked versions — "**Yours** · ₹500 · from this phone · 2:10 PM" vs "**Rohan's** · ₹450 · 2:14 PM" — changed fields highlighted | [Keep mine] (requeues against new version) / [Keep Rohan's] (discards intent; logged) |
| Split doesn't add up (trigger rejection) | "This split no longer adds up — the shares total **₹880** of **₹900**. Fix the amounts." | [Fix split] → split editor pre-filled |
| Too old (>30 days unsynced) | "**₹180 · Uber** waited too long to sync safely. Review it and add it again." | [Re-add] (opens pre-filled form as a fresh entry) / [Discard] |
| Session expired at sync time | Banner, not per-item: "Sign in again to sync your 3 changes." Queue holds; nothing is lost. | [Sign in] |

## 13. Multi-device UX

Promise made to the user (and kept by the architecture): **within seconds of two devices both
being online, they agree — with no button pressed.**

- Phone offline → records ₹180 Uber → desktop doesn't show it (correct — it hasn't happened
  to the ledger yet; the phone's footnote says "includes 1 unsynced change").
- Phone reconnects → drains → desktop shows it on next focus/refresh (existing focus-refresh
  behavior from the latency work).
- **Solo records, both devices edit:** last writer wins at server arrival (`OK_OVERRIDE`),
  both versions in the audit log, the overridden device's feed notes "Synced — replaced an
  edit from Chrome on Windows". No modal, no interruption: both writers were the same human.
- **Shared records:** never silent — the conflict card (§12) with device names and times.
- Device names appear exactly twice in the product: conflict copy and Sync Center "This
  device". Sync must never feel like device administration.
- Tablet = same behavior; identity is per-install (`deviceId` in IndexedDB).

## 14. Notifications

| Event | In-app (V1) | Push (Phase 5, opt-in) | Rationale |
|---|---|---|---|
| Sync completed (routine) | nothing | never | silence when healthy |
| Recovery after long offline | one toast: "All caught up — 6 changes synced ✓" | no | closes the anxiety loop after visible offline period |
| Needs attention (new) | toast + red dot trail (More → Settings → Sync) | yes: "1 change needs your attention in Ledgerly" | the one notification that matters; user may not reopen the app otherwise |
| Queue large / offline too long | on app open, if any intent >48h old: banner "3 changes haven't synced in 2 days — keep the app open a moment once you're online." | **impossible as push** — the server cannot know about intents it has never received; only the device knows. Document this honestly | mitigates iOS eviction risk (§16) at the only moment we can act |
| Conflict resolved by someone else | feed entry only | no | audit-level interest |

## 15. Security

**V1 (ships with Phase 1):**
- Rely on OS-level storage encryption (device passcode/FDE) — the same baseline every
  banking PWA accepts. App-layer encryption with a key stored beside the ciphertext is
  theater and is explicitly rejected.
- Minimize local surface: outbox + 200-entry log + (later) recent snapshot. Never full history.
- Auth unchanged (Better Auth, httpOnly cookie — the SW never reads it). Extend session
  lifetime to ~30 days so a week offline doesn't strand the queue. `AUTH_EXPIRED` holds the
  queue through re-auth; a different user signing in never adopts an existing outbox (userId
  guard in `meta`), and sign-out wipes local state behind the §10 warning.
- Server: replayed intents pass the identical zod + ownership scoping as live requests (free,
  same code path); basic rate limit on the sync entry point.

**V2 (post-roadmap, optional feature, only if requested by users):**
- **App PIN**: PBKDF2/Argon2-derived WebCrypto AES-GCM key wraps outbox+snapshot payloads.
  Forgotten PIN = wipe local, re-sync from server — safe *because* the server is canonical.
- **Biometric unlock**: WebAuthn platform authenticator; where the PRF extension is available
  it derives the wrapping key, PIN as fallback. This is the point where local encryption stops
  being theater — the key material finally lives in the platform authenticator, not beside the data.

## 16. Background sync — platform matrix

Design stance: the **foreground ladder is the primary mechanism**; the Background Sync API is
progressive enhancement. The app must never depend on background execution.

Foreground ladder (all platforms): drain immediately on enqueue-while-online → `online` event
→ `visibilitychange`/focus → 30s tick while open with non-empty queue.

| Platform | One-shot Background Sync | Periodic Sync | Behavior |
|---|---|---|---|
| Android Chrome (tab) | ✓ | ✗ | queue drains when connectivity returns even if tab closed |
| Android installed PWA | ✓ | ✓ (engagement-gated) | best case; periodic sync in Phase 5 |
| Desktop Chrome/Edge | ✓ | limited | drains on reconnect if browser running |
| Desktop Safari / Firefox | ✗ | ✗ | ladder only |
| **iPhone/iPad Safari & installed PWA** | ✗ | ✗ | **ladder only: sync happens next time the app is opened.** Same recovery model as Monito's backup. Mitigations: aggressive drain-on-open, the 48h banner (§14), install-to-home-screen prompting (reduces eviction risk), `navigator.storage.persist()` request |

Sync Center "Background sync" row states the truth per platform: "Automatic ✓" vs
"Syncs when the app is open" — no pretending.

## 17. Roadmap (refined, with exit criteria)

Change from the approved draft, with justification: **the trust UI ships in two stages** —
a minimal surface with Phase 1 (users must see pending state from the first offline write),
and the full Sync Center with Phase 2 (universal write-behind makes every write pass through
the machinery, so the machinery must be fully inspectable *before* it becomes universal).
Everything else holds.

| Phase | Contents | Exit criteria (added to `e2e:all`) |
|---|---|---|
| **0 — Foundations** (invisible) | Intent table + `version` migration; idempotency inside `addExpense` only; client id acceptance; deviceId + IndexedDB wrapper + empty outbox behind a flag; hand-written SW: app-shell precache → installable PWA, instant cold open | replaying the same create intent twice yields exactly one row and one balance effect (paise-exact); cold-open offline renders the shell; full existing suite green untouched |
| **1 — Offline create (solo)** | expense/income/transfer creates queue offline; ⏳ badges; balance footnote + inclusive display math; Settings sync row (status, last sync, counts, Sync now); drain ladder | Playwright `context.setOffline(true)` → create → badge → footnote → reconnect → drain → balances byte-identical to an online-created control; app killed mid-queue → reopen → intent survives and drains |
| **2 — Universal write-behind + Sync Center** | all in-scope writes flow through outbox even online; `/api/sync` batch endpoint; full Sync Center (hero, feed, queue view, device info); pending edit/delete coalescing | every write visible <100ms; double-tap submit produces one intent; batch applies in order; coalesced edit produces one server mutation |
| **3 — Offline edit/delete (synced, solo)** | baseVersion checks; `OK_OVERRIDE` LWW + audit; needs-attention resolution views; poison-pill parking | two-device edit race → LWW + both versions in audit; parked intent unblocks unrelated queue; every §12 solo scenario has a passing e2e |
| **4 — Shared expenses offline** | cached participants/groups; conflict card; guided fixes (re-split, keep-as-personal); settlements offline | participant-removed → guided fix requeues correctly (trigger stays green); conflict card both paths; settle offline → net recomputes exactly |
| **5 — Hardening** | push notifications (needs-attention only, opt-in); periodic background sync (Android PWA); `storage.persist()` + 48h banner; rate limiting; Intent pruning cron; export log | simulated eviction warning path; pruning removes >30d intents; STALE_INTENT flow e2e |
| **6 — Offline read snapshots** | SW caches last response per top route; offline navigation shows snapshot + "Offline — showing last synced data" banner | offline navigation to all five bottom-nav routes renders data with banner; snapshot never shown when online |

Each phase ends per session convention: paise-exact e2e extended, full suite green, report, review.

## 18. Six months later — what fails first (50k users, multi-device, shared groups)

Ranked by expected order of failure, each with the pre-emptive fix now baked into this spec:

1. **Intent-table growth** — tens of millions of rows as an unbounded idempotency ledger.
   *Baked in:* 30-day retention + pruning cron + `STALE_INTENT` semantics (§4.2, §5).
2. **Queue head-of-line blocking** — one intent stuck in a retry loop (server bug, weird
   payload) freezes a user's entire sync forever; support tickets say "Ledgerly stopped syncing".
   *Baked in:* poison-pill parking (24h/20 attempts) + per-`entityId` blocking only (§5).
3. **Chatty drain** — one HTTP round trip per intent × reconnecting commuters × 50k users =
   needless load spikes. *Baked in:* batched `/api/sync` from Phase 2 (§5).
4. **Ancient devices returning** — a tablet last opened in March drains a stale queue over
   entities long since edited. Without versioning this silently corrupts; with it, it degrades
   to noisy conflicts. *Baked in:* `baseVersion` + `STALE_INTENT` window; conflicts route
   through the same §12 UX instead of a special case.
5. **Conflict-rate growth in shared groups** — the keep-mine/keep-theirs card is fine at 2
   conflicts/year, tedious at 2/week for heavy shared users. *Improvement path (not V1):*
   field-level merge for non-overlapping edits on shared records (amount vs. notes edited by
   different people can both apply). Deliberately deferred: measure the real conflict rate first.
6. **Support burden without observability** — "my expense disappeared" is unanswerable
   without intent history. *Baked in:* export log (§10), intentId+deviceId in audit (§4.2).
   *Add at scale:* server-side sync metrics (drain sizes, error rates by code) — flagged for
   Phase 5, cheap counters, no user data.
7. **The 5-minute cookie cache** at 50k users means a revoked session can write for up to
   5 minutes. Accepted trade at current scale; at bank-grade scale, shrink the window for
   mutating endpoints. Noted, not scheduled.

What does **not** fail: the financial core. Every intent still lands in the same
`$transaction` reverse→apply path that 137 e2e checks guard today — scale changes arrival
patterns, not semantics.

## 19. Open questions for product owner

1. **Session lifetime** → 30 days to protect long-offline queues. Approve?
2. **Bulk "Clear pending"** — spec deliberately omits it (§10). Confirm, or require it with
   the heavy confirmation flow described.
3. **Category soft-heal** (`INVALID_REF_SOFT`: sync succeeds, category cleared, notice shown)
   vs. hard needs-attention. Spec recommends soft-heal. Confirm.
4. **Solo LWW** (`OK_OVERRIDE`: server applies your offline edit over your own newer edit
   from another device, audited, no prompt). Spec recommends this. Confirm.
5. **Push notifications** scope in Phase 5 — needs-attention only, opt-in. Confirm.
6. **Device naming** — auto-derived names editable in V1, or fixed until requested?
