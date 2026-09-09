# PromptAssist — Track A Implementation Plan

**Status:** Supersedes `promptassist_track_a_build_brief.md` for anything listed below. Where this
document is silent, the original build brief and PRD v7.0 still apply. This file is the build
reference going forward — treat the original build brief as historical context, not the live spec.

**Guiding principle for this build:** this is a prototype. Getting a working, demoable pipeline
end-to-end beats rigor, completeness, or hitting every PRD number exactly. Where a spec detail
is expensive to get precisely right but cheap to approximate for a demo, default to the cheap
version and note it here rather than block on it.

---

## 1. What changed from the original build brief

1. **Compare mode is dropped entirely.** There is one pipeline and one output. The original
   brief's "Gemini / Groq / Compare both" provider selector, Screen 3's side-by-side comparison
   view, and the per-provider latency badges are all removed. This directly contradicts brief
   sections 3, 5, and 6 — those sections are stale.
2. **Provider selection moved from user-facing to internal, and from per-session to per-call.**
   Instead of the user picking a provider, the pipeline routes each *step* to whichever provider
   suits it, splitting load across both free tiers. See routing table below.
3. **Self-critique: revise and recheck are separate calls, capped at 1 iteration** (one revise +
   one recheck, then stop regardless of outcome). Not 2 iterations as originally discussed.
4. **Latency target loosened slightly.** PRD §7.10's 5–8s total is treated as a target to aim for
   rather than a hard promise, since the corrected call count (see below) runs a bit above what
   the PRD assumed. Loading-state copy should allow for up to ~10s on worst-case inputs.
5. **Eval set gold labels:** Claude drafts the first pass of the 15–25 eval prompts and gold
   labels; user reviews, refines, and iterates from there. Not started until the audit JSON
   schema is finalized (labels need to match the real schema, not a guess at it).

Everything else in the original build brief (hard constraints, paste-in-only UI, side panel over
popup, out-of-scope list, deliverables list) still stands.

---

## 2. Pipeline calls, in order

| # | Call | Provider | Input | Output | Runs when |
|---|------|----------|-------|--------|-----------|
| 1 | Audit | Gemini | Draft prompt | Anatomy states (instruction/context/input_data/output_indicator: present/weak/missing/not_applicable), task_domain, complexity, technique flags (role_assignment, few_shot_examples, chain_of_thought, explicit_structure, grounding_permission), confidence score, plus intent layer fields (inferred goal, register, audience) | Always |
| 2 | Structural pass | Groq | Draft prompt + audit JSON | Gap-filled prompt + role/structure/grounding applied where flagged + Recap text | Always |
| 3 | CoT pass | Groq | Structural output + task_domain + complexity | Reasoning framing added, domain-appropriate | Only if `chain_of_thought` flagged |
| 4 | Few-shot pass | Groq | Latest prompt + task_domain | Labelled example (creative/summarization/extraction) or labelled placeholder (analysis_reasoning/coding/factual_qa) | Only if `few_shot_examples` flagged |
| 5 | Critique check | Gemini | Current prompt + checklist from audit | Pass/fail + itemized findings | Always, once, after last enhance pass |
| 6 | Revise | Groq | Prompt + check failures | Corrected prompt | Only if check fails |
| 7 | Recheck | Gemini | Revised prompt + checklist | Same as call 5 | Only after a revise |

Calls 6–7 form a single iteration, capped at 1 (max 2 calls from critique-on-failure). After the
cap, return the best available result with no special UI indication — matches the PRD's own
risk-register fallback (§10.3).

**Call count: 3 minimum (audit, structural, one passing check) to 7 maximum** (audit, structural,
CoT, few-shot, check, revise, recheck).

### Provider routing rationale
- **Gemini → audit + every critique check.** Both are JSON-schema-constrained, "does this data
  satisfy a structure" calls, where Gemini's native structured-output support carries the most
  weight.
- **Groq → everything that generates or revises prompt text** (structural, CoT, few-shot,
  revise). These are free-text generation calls where Groq's higher daily request cap matters
  more than schema fidelity, and a revise is functionally just another enhance pass.

This keeps a single-provider action to at most ~3 Gemini calls and ~4 Groq calls in the
worst case, well inside free-tier daily limits for a prototype's demo volume.

---

## 3. Build sequence

1. Scaffold: manifest v3, side panel shell, options page for API keys (chrome.storage.local
   only), one-line disclaimer.
2. Happy path only: audit → structural → one critique check, no conditionals, no revise loop.
   Get this rendering a real enhanced prompt + Recap in the side panel end to end.
3. Layer in CoT and few-shot conditional passes.
4. Layer in the revise/recheck loop, capped at 1 iteration.
5. Retry/backoff on 429s for both providers.
6. Eval set: draft prompts + gold labels (Claude drafts, user reviews/iterates), scoring pass,
   short written summary.

Model identifiers for Gemini (Flash-class, confirm exact ID — free tier has shifted across
2.5 Flash / 3 Flash / 3.5 Flash within 2026, family name alone doesn't guarantee free-tier
status) and Groq (Llama 3.3 70B or current equivalent) get pinned immediately before step 1,
not now, since they're the most likely thing to have moved since this plan was written.

---

## 4. Open items still unresolved

- Exact current Gemini and Groq model IDs — pin at build start.
- Minor: exact wording for the "up to ~15s" loading-state copy.

Everything else from the original build brief's "Open Ambiguities" section is now resolved by
this document or was already answered by PRD §7.6 (Recap tone example).

---

## 5. Post-build scope changes

**Injection reopened (2026-08-15).** The original build brief's hard constraint against
injection is partially reversed: a contained spike now auto-reads the draft from and
injects the enhanced prompt into ChatGPT, Gemini, and Claude's own input fields, via a
per-site selector adapter (`site-adapters.js`) and content script. This is explicitly a
spike, not a commitment to full PRD parity — kept structurally isolated (its own two files
plus a few UI hooks) so it can be removed cleanly if selector fragility proves not worth
maintaining. Selectors were written from documented DOM patterns, not verified against the
live sites (no browser access from the build environment) — expect at least one to need a
fix after first real test. Manual paste-in/copy-out remains the fallback whenever a site
isn't detected or a selector fails, matching the PRD's own risk-register mitigation
(clipboard fallback always available).

**Audit calibration under investigation.** A real test case surfaced the audit returning no
technique flags on a prompt the user considered imperfect. Root cause not yet determined —
candidates are: the prompt was structurally fine even if not perfect in other ways, the
audit system prompt's deliberate anti-over-flagging bias is miscalibrated too far the other
way, or model-specific behavior on `gemini-3.5-flash`. Pending the specific draft prompt
text to diagnose; will become eval entry #1 with a user-supplied gold label once available.
