# Ledgerly Activity Timeline — RFC, Final Revision (v1.0)

**Status:** FINAL — approved for implementation (§14) · supersedes all prior drafts of this document
**Immutability:** this RFC is the contract. Implementation follows it phase by phase; any
deviation requires written justification in the phase report. Performance claims must be
measured. Every UI phase ships mobile screenshots (360×800 / 390×844 / 412×915), e2e
coverage, bundle numbers, and a full-suite regression run.
**Depends on:** existing audit log · offline-sync spec (`offline-sync-spec.md`) for Phase 3 only

---

## 1. Final architecture

```
existing services ──► audit() ──► Audit table            ← the ONLY writer (unchanged)
notifications service ─────────► Notification table      ← system insights (unchanged)
                                      │
                        new index: Audit(userId, createdAt DESC, id)
                                      │  read-time, per page of 50
                     ┌────────────────▼─────────────────┐
                     │       PRESENTER (service)         │
                     │  query → parse snapshots once →   │
                     │  registry lookup → diff + effects │
                     │  → collapse (in-page) → events    │
                     ├───────────────────────────────────┤
                     │       EVENT REGISTRY (module)     │
                     │  per-kind: allowlist · icon ·     │
                     │  summary/explain templates ·      │
                     │  diff manifest · related builder  │
                     └──┬──────────┬──────────┬──────────┘
                        ▼          ▼          ▼
                  /activity   History      tool API (Ask Ledgerly / future AI)
                    page      section
                        ▲
              client overlay: outbox local echo (⏳) — rendering only, never a source
```

Forbidden, restated: no new database, no event store, no second audit table, no duplicated
history, no duplicated sync log, no stored diffs. Everything below is a projection.

## 2. TimelineEvent schema (final)

```
TimelineEvent {
  activityId     string      // "ACT_<auditRowId>"; local echo: "ACT_LOCAL_<intentId>" (§5)
  schemaVersion  1           // tool-API contract version
  ts             string      // ISO-8601 with offset; server clock (audit createdAt)
  clientTs?      string      // when the human acted, if offline-recorded
  actor          { kind: "you" | "member" | "system", label: string, deviceLabel?: string }
  verb           "created" | "edited" | "deleted" | "restored" | "paid" | "settled"
               | "imported" | "import_undone" | "joined" | "left" | "exceeded"
               | "attention" | "resolved" | "connected" | "renamed" | "merged"
  entityType     "transaction" | "transfer" | "account" | "category" | "budget"
               | "bill" | "group" | "import" | "security"
  entityRef      { id: string, label: string }        // label from snapshot, never a join
  summary        string                                // "Edited expense · Swiggy"
  diff           Array<{ field, fieldLabel, before, after,
                         formattedBefore, formattedAfter, delta? }>   // delta for amounts
  effects        Array<{ accountId, accountLabel, deltaPaise }>       // balance impact (§10)
  syncMeta?      "pending" | "attention"               // absence = synced
  explainable    boolean                                // §6
  related        Array<{ label, href }>                 // §7; empty in list rows
  collapsed?     { count: number, memberActivityIds: string[] }       // §3 collapse
  sourceAuditId  string                                 // internal: support/debug, not UI
}
```

Changes from draft, all in service of the approved decisions: `activityId` (decision 6),
`effects[]` (AI question "why is my balance different", §10), `related[]` replaces the
draft's separate `links[]` (one concept, not two), `explainable` flag, `schemaVersion`,
`renamed`/`merged` verbs (category CRUD, decision 1).

## 3. Presenter responsibilities · Registry responsibilities

**Presenter (the only new server code path):**
- Cursor-paginate `(createdAt, id) <` over the index, `WHERE action IN (allowlist)` pushed
  into SQL; page size 50.
- Parse each row's before/after JSON **once**; hand parsed snapshots to the registry.
- Compute `diff[]` via the kind's field manifest; compute `effects[]` (pure paise addition
  from snapshots — the same bounded arithmetic class the sync spec permits, ≤ ~30 lines).
- Collapse in-page (rules below); merge notification-sourced events (budget exceeded) by
  timestamp; emit stable ordering.
- Expose three typed entry points, one implementation: `page(filters, cursor)`,
  `entityHistory(entityId)`, `tool(filters)` — RSC page, detail sheet, and AI all call these.
- Zero copy decisions, zero formatting decisions — those live in the registry.

**Registry (pure data + pure functions; the extension contract):**
- One entry per event kind: allowlist membership, icon, verb, summary template, diff field
  manifest (field → label → formatter), explain template (§6), related-link builder (§7),
  `explainable` flag, collapse eligibility.
- **Adding an event kind = adding a registry entry and nothing else.** If implementing a new
  kind requires touching the presenter, the design has been violated.
- Defensive by rule: unknown kind → skip row, count, log (never crash); missing snapshot
  field → omit that diff row (historical audit rows predate newer fields).

**Collapse rule (final — decision 3, accepted with refinement):**
Consecutive `edited` events on the same entity collapse when each is within **10 minutes of
the previous** (chain rule), starting from the 2nd edit. Any intervening event on that entity
(delete, settle, conflict) breaks the chain. A collapsed group renders the **net diff**
(first `before` → last `after`) with "3 changes" expanding to individual steps; its
`activityId` is the newest member's, and members keep their own ids. Collapse is computed
per page; a chain split across a page boundary renders as two groups — accepted cosmetic
edge, documented here so implementation doesn't "fix" it with cross-page lookahead
complexity. The 10-minute chain collapses typo-fix bursts (the stated goal) while morning
and evening edits to the same transaction remain distinct stories — the refinement over a
flat window is that a 25-minute continuous fixing session still collapses to one story,
which matches intent.

## 4. Event catalog — deltas from the approved draft

Everything in the draft catalog stands. Changes:

1. **Category CRUD added to V1** (decision 1): Created 🏷 / Renamed ✏️ ("Snacks → Street food") /
   Deleted 🗑 (with in-use protection already enforced by services). **"Merged category" is
   reserved in the registry but no merge feature exists in Ledgerly today** — the RFC does
   not invent one; the verb exists so the event lands the day the feature does. The Phase-1
   audit-coverage sweep explicitly includes category services (rename/kind-switch/delete are
   exercised by `e2e:perf` today; their audit coverage must be verified).
2. Settings changes remain excluded (decision 2).
3. Shared attribution confirmed as-is (decision 4): display names, snapshot-preserved for
   departed members.

## 5. Stable Activity IDs (decision 6)

- **Format:** `ACT_<auditRowId>` — a prefix over the id that already exists, uniqueness and
  permanence inherited from the audit table. **Derived, not stored; zero schema change.**
- **Local echo:** `ACT_LOCAL_<intentId>`. After drain, the audit payload records `intentId`
  (sync spec), so any held `ACT_LOCAL_*` reference is server-resolvable to its permanent
  `ACT_*` id. Local ids are transient by contract — anything durable (support tickets, AI
  citations) must use the post-sync id.
- **Collapsed groups:** group id = newest member's id; `collapsed.memberActivityIds` carries
  the rest.
- **Uses:** deep links (`/activity?focus=ACT_…`, Phase 3), AI citations ("this refers to
  ACT_…"), support ("send me the activity id from Explain → Details"), debugging (maps
  1:1 to the audit row). **Not visible in default UI**; exposed in the Explain expansion's
  fine print ("Details · ACT_…" with tap-to-copy) and in the sync-log export.
- **Notification-sourced events** (budget exceeded) use `ACT_N<notificationId>` — same
  scheme, different table prefix letter, still derived.

## 6. Explain This (final scope — decision 5)

- **Explainable kinds:** edit, delete, restore, conflict-resolved, settlement,
  split-modification, import, import-undo. **Not explainable:** plain creates (expense,
  budget, account, category) — "You added an expense of ₹420" restates the row; a button
  that adds nothing trains users to stop tapping it.
- **Stage 1 (deterministic, Phase 5):** template per kind in the registry, assembled from
  `diff[]` + `effects[]` + `syncMeta` + timestamps + actor. Examples fixed by this RFC:
  - *edit:* "You increased this expense by ₹100 on July 14 at 8:42 PM. The category stayed
    Food. Recorded on your phone and synced 2 minutes later."
  - *delete:* "You deleted this ₹420 Swiggy expense on July 15. HDFC Savings went up by
    ₹420 when it was removed."
  - *settlement:* "Karan paid you ₹450 on July 16, settling your share of Group dinner.
    Your balance with Karan is now even."
  - *split-modification:* "You changed Karan's share from ₹300 to ₹450. Your own share went
    down by ₹150. The total stayed ₹900."
  - Expansion footer: "Details · ACT_… ⧉" + Related chips (§7).
- **Stage 2 (assistant):** the model receives the same `TimelineEvent` (schemaVersion-ed)
  and narrates; it may quote or improve on the stage-1 template but **never parses audit
  JSON and never recomputes financial math** — `effects[]` is the only arithmetic it repeats.

## 7. Related Events (decision 7)

Lightweight rule set — related links are **deterministic navigation**, not a similarity
engine:

- **List rows carry no related links** (keeps list rendering allocation-free beyond the
  event itself). Related appears only in expanded views: Explain expansion, entity History,
  the deleted-entity snapshot card.
- **Built by the registry per kind, from data already inside the event** — no extra queries
  in the common case:
  - transaction/transfer → its account(s) (→ Accounts), its category (→ ledger filtered),
    its group if shared (→ Shared).
  - import → "View 74 transactions" (→ ledger filtered by `importBatchId` — requires the
    small `batch` query-param addition to the transactions page already noted in Phase 2).
  - settlement → the group, the counterparty's balance view.
  - category rename → ledger filtered to that category.
  - budget exceeded → the budget page, the category's ledger for the period.
- **One bounded exception:** the import event's expanded view may run a single capped query
  (top 5 merchants in the batch) to render "Salary · Rent · Swiggy" preview chips. One
  query, one place, LIMIT 5 — measured in the Phase 2 report like every performance claim.

## 8. Version History — recommendation: **do not build it** (decision 8 evaluation)

- **The capability is already preserved losslessly.** Audit rows hold full before/after
  snapshots; the complete version chain of any transaction is reconstructible at any future
  date. Declining the UI forecloses nothing — this is precisely why the recommendation is
  safe.
- **The user job is already served.** "What was it before?" is answered by History's diffs;
  a version browser answers "show me the full state at version N," which is a
  support/forensics job, not a product job.
- **The hidden cost is not the viewer — it's revert.** A version list creates the
  expectation of "restore this version," which is a *new financial mutation* (reverse
  current effects, apply historical state) with ugly semantics around splits, settlements,
  and deleted references — a new action, new service, new conflict surface, new e2e matrix.
  That is real correctness risk purchased for a feature whose read-only half is redundant.
- If forensic state-at-time-T is ever needed for support, it's an internal tool over the
  audit table, not product UI.

## 9. Performance review (constraints → design answers)

| Constraint | Answer |
|---|---|
| Server pagination | cursor `(createdAt, id)`, page 50, allowlist in `WHERE` — pagination never post-filters |
| Zero unnecessary joins | labels/icons come from snapshots; the presenter performs **no joins**, full stop; the one bounded exception is §7's import preview (expanded view only) |
| Lightweight presenter | pure functions over parsed rows; parse each JSON payload once; registry lookups are object-map hits; no classes, no abstraction layers — composition of ~4 modules (query, registry, diff, collapse) |
| Minimal allocations | per page: 50 parses + 50 event objects; diff rows only for changed fields; `related[]` empty in list emission |
| Lazy loading | first page RSC-rendered; "Load more" server action (identical pattern to `tx-list.tsx`); **no virtualization** — 50 simple rows is proven territory in this codebase; revisit only on measurement |
| Snapshot reuse | one parse feeds summary, diff, effects, and explain — no re-parsing per concern |
| Caching | route inherits `staleTimes`; every mutation already revalidates its pages — Phase 1 adds `/activity` to those `revalidatePath` calls |
| Index cost | one composite index; if measurement shows heavy non-allowlisted scan waste (unlikely — excluded kinds are a minority of audit rows), adding `action` to the index is the pre-approved follow-up. Measure first |
| Bundle | new route budget: ≤ the transactions page (~3.4 kB route JS, shared chunk unchanged) — a hard number the Phase 1 report must publish |

## 10. AI-readiness review

Tested against the four canonical questions:

| Question | Served by |
|---|---|
| "What changed yesterday?" | `tool({date: yesterday})` → events; summaries are pre-humanized |
| "Why is my balance different?" | **`effects[]`** — the schema addition made for exactly this: sum `deltaPaise` per account over the window and narrate. The model repeats arithmetic the presenter already did; it never derives it from raw fields |
| "When did I edit this expense?" | `entityHistory(id)` → `verb: "edited"` events with `ts`/`clientTs` |
| "What happened to my money this week?" | `tool({period})` + `effects[]` + summaries |

Contract guarantees: the tool API returns `TimelineEvent[]` only — **raw audit JSON is
unreachable through it by construction**; `schemaVersion` pins prompt/tool compatibility;
`activityId` gives the assistant citable references; filters mirror the page's (period,
type, entity, q) so the assistant and the UI can always deep-link each other. Verdict:
schema is sufficient; no further fields speculatively added — `schemaVersion` exists so
real assistant work can extend it later without breakage.

## 11. Risks

1. **Audit coverage gaps** (top risk): the timeline shows only what `audit()` recorded.
   Mitigation: Phase 1 opens with the coverage sweep (now explicitly including category
   services); every catalog kind gets an e2e asserting mutation → expected event.
2. **Historical payload drift:** old audit rows written by earlier code may lack fields.
   Mitigation: defensive registry rules (§3) — omit, never crash; e2e includes a
   legacy-shaped fixture row.
3. **Collapse page-boundary edge:** documented and accepted (§3); not a correctness issue.
4. **`merged` verb without a merge feature:** reserved only; risk is someone "helpfully"
   implementing merge to fill it. The RFC forbids that — feature work is out of scope.
5. **Index scan waste** if allowlist excludes many rows: measure-then-index path
   pre-approved (§9).
6. **Copy/i18n:** all user-facing strings live in the registry — single-locale today,
   centralized for whenever that changes.
7. **Scope creep at implementation:** the immutability contract (§13) is the mitigation.

## 12. Removed before implementation (simplifications in this final pass)

1. **History in-place "Full history" expansion** → replaced by navigation to
   `/activity?entity=<id>` (reuses the page; deletes an expansion state machine).
2. **Empty-state ghosted example row** → copy only.
3. **`links[]` field** → folded into `related[]` (one concept).
4. **`?focus` deep-link support moved out of Phase 1** → lands in Phase 3 with its only
   consumers (Sync Center, notifications).
5. **Version-history UI** → rejected outright (§8).
6. **Cross-page collapse lookahead** → rejected; per-page collapse accepted (§3).
7. **Related chips in list rows** → expanded views only (§7).

## 13. Final implementation roadmap & contract

**Contract (binding on every phase):** this RFC is immutable during implementation.
Implement **Phase 1 only**; Phase 2 does not begin without explicit approval. Architectural
deviations require written justification in the phase report. Performance claims are
measured, not asserted. UI phases deliver: screenshots at 360×800 / 390×844 / 412×915,
e2e additions to `e2e:all`, bundle-impact numbers, and a green full-suite regression run.

| Phase | Scope | Exit criteria |
|---|---|---|
| **1 — Timeline core** | audit-coverage sweep (incl. categories); `Audit(userId, createdAt, id)` index; presenter + registry (transaction/transfer/account/**category**/budget/bill/import kinds); `effects[]`; ACT ids; `/activity` — day groups, net-diff rows, six chips, period picker, Load more; More-sheet + sidebar entries; `/activity` added to revalidate calls | every catalog kind: mutation → asserted event with paise-exact diff and effects; deleted-entity snapshot card renders; pagination stable; bundle ≤ transactions-page budget; 3-viewport screenshots; suite green |
| **2 — Transaction History + Related** | History section in detail sheet (`entityHistory`); collapse (10-min chain, net diff, expand); import batch tap-through (`batch` param); Related chips in expanded views; import preview query (bounded, measured) | edit/delete/restore cycles render correctly; triple-edit chain collapses to net diff and expands; related chips navigate correctly; preview query timing published |
| **3 — Offline integration** *(gated on sync spec Phases 1–2)* | local echo overlay + ⏳; needs-attention / conflict-resolved events; `ACT_LOCAL_*` → `ACT_*` resolution; device attribution; `?focus` deep links (Sync Center, notifications) | §13 invariant of the draft holds: post-sync timeline byte-identical to online control; echo appears instantly offline; conflict resolution visible from second device |
| **4 — Search & NL** | text search over snapshots; Ask Ledgerly activity intents; deep-link matrix | canonical queries return exact expected event sets; palette routes the three canonical phrases |
| **5 — Explain This + tool API** | deterministic Explain for the §6 kind list; ACT id in expansion footer; presenter `tool()` endpoint typed + schemaVersion-ed | Explain fixtures render the §6 templates verbatim; tool API returns schema-stable JSON for the same fixtures; a "raw audit JSON unreachable" test exists |

## 14. Verdict

**Approved for implementation. Phase 1 may begin.**

Basis: the architecture is a pure projection over infrastructure that already exists and is
already tested; the only schema change is an index; the riskiest unknown (audit coverage) is
the first task of Phase 1 and is bounded — worst case it adds small `audit()` calls through
the existing deviation-justification channel; every product decision from this review is
incorporated above (category CRUD in, 10-minute chain collapse, expanded Explain scope,
stable ACT ids, related events, version-history UI rejected with reasoning). No open
questions remain that block Phase 1; the two external dependencies (offline-sync Phases 1–2)
gate only Phase 3 and are marked as such.

Preconditions carried into Phase 1, restated once: coverage sweep first · "merged" stays a
reserved verb, not a feature · every §13 contract item applies from the first commit.
