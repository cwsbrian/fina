# Experiment: Is Opus actually necessary?

**Date:** 2026-05-14
**Researcher:** Brian (cwsbrian@gmail.com)
**Subject feature:** Plan 1E-chat (Chat Agent — the largest planned feature)

---

## 1. Hypothesis

The current Fina development workflow uses **Opus** for the design and planning phases, **Sonnet** for implementation, and **Codex** for code review. Opus is the most expensive model. The question:

> **Does using Opus for design + planning produce meaningfully better outcomes than using a cheaper model (Sonnet or Haiku) for the same phases?**

If the difference is small, we can save cost by using Sonnet everywhere. If the difference is meaningful (catches more issues early, produces tighter specs, requires fewer review rounds), Opus is justified for design-phase work.

## 2. Current workflow (the "Opus variant")

For each plan, the pipeline runs:

1. **Brainstorming** (Opus) — clarifying questions, approach selection, design sections
2. **Design spec writing** (Opus) — `docs/superpowers/specs/<plan>-design.md`
3. **Codex review of spec** (round 1, round 2, ... until 0 Critical + 0 Important remain)
4. **Spec fixes** (Opus) — apply codex feedback
5. **Plan writing** (Opus) — `docs/superpowers/plans/<plan>.md`
6. **Codex review of plan** (round 1, round 2, ... until 0 Critical + 0 Important)
7. **Plan fixes** (Opus) — apply codex feedback
8. **Subagent-driven implementation** (Sonnet per task) — TDD, commit per task
9. **Codex spec-compliance review** (per task) — Sonnet implementer fixes
10. **Codex quality review** (per task) — Sonnet implementer fixes
11. **Final codex review** of full implementation (Opus)
12. **E2E + smoke** verification

## 3. Experiment design

### Variant A — Opus baseline (current workflow)

Implement Plan 1E-chat using the workflow above. Opus for steps 1-7, 11. Sonnet for steps 8-10. This is the **baseline** — exactly how we've been working.

Worktree: `plan-1e-chat-opus`

### Variant B — Non-Opus comparison

Implement the **same** Plan 1E-chat from scratch using **Sonnet** (or Haiku, decision TBD) for steps 1-7, 11. Sonnet still does implementation (steps 8-10).

Worktree: `plan-1e-chat-sonnet` (or `-haiku`)

Branch from the same base commit as variant A so both start from identical state.

### Variant C (optional) — Codex-only baseline

If interested, a third variant using a single non-Anthropic model end-to-end as a sanity check.

## 4. Metrics

For each variant, capture:

### Spec phase
- **Lines of spec** at first commit
- **Codex review rounds** before 0 Critical + 0 Important
- **Issues raised per round** (Critical / Important / Minor counts)
- **Issues correctly applied** vs **pushed back** vs **missed**
- **Final spec quality** (subjective — assessed after both variants done)

### Plan phase
- Same metrics as spec phase
- **Number of placeholders / TBDs found** by reviewer
- **Code accuracy** — does the plan's pseudocode compile when copied to real files?

### Implementation phase
- **Tasks completed** in one shot vs needing fix iterations
- **Codex spec-compliance issues per task** (avg)
- **Codex quality issues per task** (avg)
- **Final test count and pass rate**

### Cost / time
- **Tokens consumed** per phase (best effort — from session logs)
- **Wall-clock time** per phase
- **Total cost** if calculable

### Behavioral observations
- Did Opus catch design-level issues Sonnet would have missed?
- Did Sonnet produce specs/plans that needed more codex review rounds?
- Were there architecture decisions where Opus's choice diverged from Sonnet's?

## 5. Comparison criteria

After both variants complete, compare:

1. **Final feature quality** — both should pass the same tests. Did one have bugs the other didn't?
2. **Effort to ship** — review rounds, fix iterations, time-to-green.
3. **Cost** — tokens consumed for each phase.
4. **Spec/plan robustness** — count of issues raised by codex that the model missed.
5. **Architectural quality** — were design choices comparable, or did one variant produce a noticeably weaker design?

## 6. Bias controls

- **Same plan, same base commit** — both variants implement Plan 1E-chat from identical starting state.
- **Same codex prompts** — review prompts must be identical between variants (no leading questions).
- **Same subagent-driven execution** — both use Sonnet for implementation tasks, so implementation quality is held constant.
- **Same E2E + smoke tests** — both must pass identical verification.
- **Both variants run by the same human operator** — to avoid operator-skill variance.

## 7. Risks / limitations

- **Sample size of one feature.** A single comparison may not generalize. If results are mixed, may need to repeat with a smaller plan.
- **Context contamination.** Once variant A completes, variant B may benefit indirectly (the operator has seen the answer). Mitigate by avoiding cross-variant context references.
- **Model drift.** If a new Anthropic release lands mid-experiment, comparison becomes apples-to-oranges. Lock model identifiers if possible.
- **Codex acts as a leveler.** Codex review catches many issues that either model misses, which may mask the design-phase quality difference. This is acceptable — it reflects the actual workflow.

## 8. Outcome documentation

After both variants complete:
- Write a comparison report at `docs/superpowers/experiments/2026-05-14-opus-vs-non-opus-results.md`
- Include raw metrics, qualitative observations, and a recommendation.
- If results favor cheaper model: update workflow guidance.
- If Opus is justified: document the specific aspects that justify the cost.

---

## 9. Worktree setup

| Variant | Worktree path | Branch | Status |
|---|---|---|---|
| A (Opus) | `.claude/worktrees/plan-1e-chat-opus` | `plan-1e-chat-opus` | starting now |
| B (Non-Opus) | TBD | TBD | after A completes |

Both variants branch from the same `main` commit so initial state is identical.
