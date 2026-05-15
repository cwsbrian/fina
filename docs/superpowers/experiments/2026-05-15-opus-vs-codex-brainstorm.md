# Experiment: Opus vs Codex vs Claude+Codex — Brainstorming Quality

**Date:** 2026-05-15
**Researcher:** Brian (cwsbrian@gmail.com)
**Subject feature:** Plan 1E-next (additional chat tools beyond the 4 in Plan 1E)

---

## 1. Hypothesis

Can a cheaper/different model (Codex CLI) produce brainstorming + design output comparable to Opus 4.7? And does the established workflow (Claude brainstorm + Codex review) outperform either model working alone?

> **Questions:**
> 1. Does Opus brainstorm better designs than Codex, or are they comparable when each self-reviews?
> 2. Does adding Codex as an external reviewer (the existing production workflow) produce meaningfully better output than either model alone?

---

## 2. Experimental design

### Task

All three variants receive **identical starting documents** (no session context, no prior conversation):

1. `docs/superpowers/context/2026-05-15-plan-1e-next-briefing.md` — comprehensive briefing on Fina's codebase, current chat architecture, and the brainstorming task
2. `docs/superpowers/specs/2026-05-14-plan-1e-chat-foundation-design.md` — Plan 1E spec (current state)

**Their job:** Brainstorm and design Plan 1E-next (additional chat tools).

### Variant A — Opus + self-review

- Model: `claude-opus-4-7`
- Worktree: `.claude/worktrees/plan-1e-next-opus`
- Branch: `plan-1e-next-opus`
- Process: read briefing → brainstorm → write design spec → **self-review**
- No external reviewer.

### Variant B — Codex + self-review

- Model: Codex CLI (OpenAI o3 or codex-mini)
- Worktree: `.claude/worktrees/plan-1e-next-codex`
- Branch: `plan-1e-next-codex`
- Process: read briefing → brainstorm → write design spec → **self-review**
- No external reviewer.

### Variant C — Claude + Codex review (existing production workflow)

- Brainstorm model: `claude-opus-4-7`
- Review model: Codex CLI
- Worktree: `.claude/worktrees/plan-1e-next-claude-codex`
- Branch: `plan-1e-next-claude-codex`
- Process: read briefing → brainstorm → write design spec → **Codex reviews** → Claude applies fixes → repeat until 0 Critical/Important
- This is the established workflow that produced Plans 1B–1E.

### Evaluation method

After all three complete, call Opus and Codex **simultaneously** with all three outputs visible. Have them debate:
- Which design is most complete?
- Which caught the most edge cases?
- Which is best structured for implementation?
- Did the Codex review in Variant C add real value vs Variant A's self-review?
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
- **Reviewer value (Variant C vs A)** — how many issues did Codex catch in Variant C that Opus missed in its own self-review?

---

## 4. Worktree setup

| Variant | Worktree | Branch | Status |
|---|---|---|---|
| A (Opus + self-review) | `.claude/worktrees/plan-1e-next-opus` | `plan-1e-next-opus` | ready |
| B (Codex + self-review) | `.claude/worktrees/plan-1e-next-codex` | `plan-1e-next-codex` | ready |
| C (Claude + Codex review) | `.claude/worktrees/plan-1e-next-claude-codex` | `plan-1e-next-claude-codex` | ready |

All three branch from `main` at commit `5f83929`.

---

## 5. Bias controls

- **Identical starting documents** — all three variants read exactly the same briefing
- **No cross-contamination** — no variant sees another's output during design
- **Same task description** — the briefing's task section is model-agnostic
- **Variant C uses the actual established workflow** — same Codex-review-until-0-Critical loop used in Plans 1B–1E; this is the production baseline, not a simplified version
- **Simultaneous debate** — all variants debated at the same time with all outputs visible

---

## 6. Risks

- **Self-review bias** — models may be too lenient on their own work (A, B); this is expected and is itself a measurement
- **Variant C effort asymmetry** — Variant C involves more rounds (Codex review loops), so it's naturally more polished; the question is whether that extra effort is justified vs A or B
- **Different strengths** — Codex may excel at code-level accuracy; Opus may excel at holistic design; both are valid
- **Sample size of one feature** — results may not generalize

---

## 7. Outcome documentation

After all three variants + debate complete:
- Write results to `docs/superpowers/experiments/2026-05-15-opus-vs-codex-results.md`
- Include raw metrics, debate transcript highlights, and answers to:
  - Is Codex self-review good enough to replace Opus+Codex? (A vs C)
  - Can Codex replace Opus entirely for brainstorming? (B vs A)
  - Is the extra effort of Variant C justified? (C vs A, C vs B)
- Recommendation: which workflow should become the new default?
