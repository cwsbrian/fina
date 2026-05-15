# Experiment: Opus vs Codex — Brainstorming Quality

**Date:** 2026-05-15
**Researcher:** Brian (cwsbrian@gmail.com)
**Subject feature:** Plan 1E-next (additional chat tools beyond the 4 in Plan 1E)

---

## 1. Hypothesis

Can a cheaper/different model (Codex CLI) produce brainstorming + design output that is comparable to Opus 4.7? In the previous experiment (2026-05-14), Codex reviews were replaced; now Codex *writes* the initial design, matching Opus's output on the same task.

> **Question:** Does Opus brainstorm better designs than Codex, or are they comparable when each self-reviews?

---

## 2. Experimental design

### Task

Both models receive **identical starting documents** (no session context, no prior conversation):

1. `docs/superpowers/context/2026-05-15-plan-1e-next-briefing.md` — comprehensive briefing on Fina's codebase, current chat architecture, and the brainstorming task
2. `docs/superpowers/specs/2026-05-14-plan-1e-chat-foundation-design.md` — Plan 1E spec (current state)

**Their job:** Brainstorm and design Plan 1E-next (additional chat tools) and self-review the result.

No Codex review of Opus output. No Opus review of Codex output. Each is self-contained.

### Variant A — Opus 4.7 baseline

- Model: `claude-opus-4-7`
- Worktree: `.claude/worktrees/plan-1e-next-opus`
- Branch: `plan-1e-next-opus`
- Task: read briefing → brainstorm → write design spec → self-review

### Variant B — Codex comparison

- Model: Codex CLI (OpenAI o3 or codex-mini)
- Worktree: `.claude/worktrees/plan-1e-next-codex`
- Branch: `plan-1e-next-codex`
- Task: same as Variant A

### Evaluation method

After both complete, call Opus and Codex simultaneously with each other's outputs. Have them debate:
- Which design is more complete?
- Which caught more edge cases?
- Which is better structured for implementation?
- Overall: which would you rather implement?

---

## 3. Metrics

For each variant:

### Design phase
- **Tools proposed** — count, novelty, coverage of common use cases
- **Arg design quality** — are zod schemas precise? Are `.describe()` strings LLM-friendly?
- **Edge cases caught** — cross-workspace isolation, empty state, error paths
- **Spec completeness** — missing sections, TBDs, contradictions found in self-review
- **Self-review depth** — how many real issues did the model catch in its own output?

### Structural quality
- **File size** — is the spec appropriately sized for the scope?
- **Internal consistency** — do sections contradict each other?
- **Implementation-readiness** — could a Sonnet subagent implement from this spec alone?

### Debate quality
- **Accuracy of cross-critique** — does each model correctly identify real weaknesses in the other?
- **Defensiveness** — does Opus over-defend its own output? Does Codex?

---

## 4. Worktree setup

| Variant | Worktree | Branch | Status |
|---|---|---|---|
| A (Opus) | `.claude/worktrees/plan-1e-next-opus` | `plan-1e-next-opus` | ready |
| B (Codex) | `.claude/worktrees/plan-1e-next-codex` | `plan-1e-next-codex` | ready |

Both branch from `main` at commit `7309c73`.

---

## 5. Bias controls

- **Identical starting documents** — both agents read exactly the same briefing
- **No cross-contamination** — neither agent sees the other's output during design
- **Same task description** — the briefing's task section is model-agnostic
- **Both self-review** — no external reviewer (removes the Codex-as-leveler effect from the prior experiment)
- **Simultaneous debate** — both are called at the same time with both outputs visible

---

## 6. Risks

- **Self-review bias** — models may be too lenient on their own work; this is expected and is itself a measurement
- **Different strengths** — Codex may excel at code-level accuracy; Opus may excel at holistic design; both are valid
- **Sample size of one feature** — results may not generalize

---

## 7. Outcome documentation

After both variants + debate complete:
- Write results to `docs/superpowers/experiments/2026-05-15-opus-vs-codex-results.md`
- Include raw metrics, debate transcript highlights, recommendation
