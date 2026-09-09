# explanations.md — the ideas that shape the whole system

Conceptual/cross-cutting explainers that apply across every phase, not tied
to one package. Concrete "how does module X work" detail lives in a phase
folder's `explain_<topic>.md`, or in a global `explain_<topic>.md` here for
topics that aren't phase-specific (e.g. `explain_testing.md`).

## The one idea that shapes almost everything: never trust the client for anything gradeable

A leaderboard is only meaningful if a client can't fabricate its own score.
Two things follow from that, and they show up repeatedly across the
codebase:

1. **Scores are computed server-side** — the client submits an architecture
   graph, not a score; `verify/` computes the canonical metrics (Phase 4).
   This is also *why* that service exists at all — see `architecture.md`'s
   two-service split.
2. **Elapsed time is computed server-side** — an attempt's clock is
   server-timestamped at start/pause/resume/submit, never taken from a
   client-reported duration (see the `attempt` package, once built).

Auth's own version of this same idea: a JWT's claims (including `role`) are
fixed at the moment it's issued and can't be edited by the client afterward
without invalidating the signature — see `phase-1-auth-rbac/explain_auth.md`'s
note that a promoted user's *old* token keeps asserting their *old* role
until it expires and they log in again. Same principle, three different
places it shows up.

## How to read these docs

- **`architecture.md`** — what exists, structurally (packages, services,
  status).
- **`flow.md`** — what happens, in order, for a request.
- **`explanations.md`** (this file) — why the system is *shaped* the way it
  is, at a conceptual level, plus any global `explain_<topic>.md` docs for
  cross-cutting mechanics (testing setup, etc.).
- **`decisions.md`** — why any one specific technical choice was made over
  an alternative, project-wide (Java/Spring Boot itself, Maven, dependency
  selection, package layout).
- **`phase-N-<slug>/`** — everything specific to one milestone: its own
  `decisions.md`, its own `explain_<topic>.md` files, and a short `README.md`
  summarizing what shipped and its test status.
