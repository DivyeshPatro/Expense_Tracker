# Architecture Decision Records

An ADR captures a decision that was genuinely debated — where a reasonable
alternative existed and was rejected for a stated reason — not a restatement
of what the code does. If you're trying to understand *how* something works,
read [`../architecture.md`](../architecture.md) or the relevant `docs/*.md`
first; come here for *why it was built this way instead of the obvious
alternative*.

| ADR | Decision |
|---|---|
| [0001](0001-offline-first.md) | Why Ledgerly is offline-first |
| [0002](0002-universal-outbox.md) | Why the Universal Outbox exists |
| [0003](0003-loanentry-flat.md) | Why `LoanEntry` stayed a flat event log |
| [0004](0004-loanallocation-additive.md) | Why `LoanAllocation` is additive-only |
| [0005](0005-fifo-settlement.md) | Why FIFO was chosen for automatic settlement |
| [0006](0006-derived-financial-metrics.md) | Why settlement status is derived, never stored |
| [0007](0007-finance-hub-aggregation.md) | Why the Finance Hub aggregates existing services |
| [0008](0008-lww-conflict-resolution.md) | Why last-write-wins (with actor-aware escalation) was chosen for conflicts |

## Writing a new one

Copy the shape of any existing ADR: **Context**, **Problem**, **Alternatives
considered**, **Decision**, **Consequences**. Number sequentially, never
renumber or delete a past ADR even if it's later superseded — add a new one
and note the supersession in both files.
