"""
Full audit-enhance-critique pipeline, server-side, per promptassist_final_
pipeline.md's architecture: audit -> structural (always) -> chain_of_thought
(conditional) -> few_shot (conditional) -> self-critique (with a bounded
revise loop).

WHAT THIS CHANGES RELATIVE TO TRACK A'S pipeline.js, AND WHY:

1. Track A's pipeline.js explicitly only wired audit -> structural -> one
   critique CHECK (its own header comment marks chain_of_thought, few_shot,
   and the revise-on-failure loop as "NOT YET WIRED... next build
   increments"). Those three pieces are built here, following the behavior
   the PRD and the Track B project report describe for them (Sections 2.1,
   4.3, 4.4 of the report) — they are new work, not a port, since no
   validated Track A prompt text exists yet for them.

2. Track A's structural pass ran on Groq, not Gemini. The final architecture
   (promptassist_final_pipeline.md, and the project report Section 2.2's
   account of why the harness moved to Gemini-only) settled on Gemini for
   every enhancement/critique step specifically because Groq's rate limits
   proved disruptive at evaluation scale. This backend routes every non-
   audit step through Gemini, matching that decision, not Track A's
   pipeline.js as currently written.

3. Track A's STRUCTURAL_SYSTEM_PROMPT tells the model to preserve intent
   "given in the audit's intent field" — but the fine-tuned audit model
   (audit_model.py) never emits an intent field; nothing in the labeled
   training data had one. Fixed here by having the structural pass infer
   intent directly from the draft prompt it already receives as input,
   rather than depending on a field that will always be absent.

4. Track A's critiqueCheck() never received the original draft prompt, only
   the enhanced prompt and the audit. This is exactly the defect the project
   report documents finding and fixing in Section 4.5: without the original
   draft, a critique step cannot distinguish "the user wrote this
   specifically" from "an earlier pass added this without authorization,"
   and was observed to delete genuine user content on well-formed prompts
   as a result. Fixed here by passing draft_prompt into every critique call.

5. A correction capability is added that pipeline.js never had at all — it
   only ever checked and flagged, never corrected. Per Section 7's exact
   wording ("Reads three things every call... Writes the minimum correction
   if any check fails"), the check and the correction happen in ONE Gemini
   call, not two: critique_and_correct() returns passed/issues AND a
   corrected_prompt in the same response. The loop in run_pipeline() calls
   this once per iteration, capped at max_critique_iterations (1 in
   production per the final architecture, 2 for harness-style evaluation
   runs) — this exact design was checked directly against Section 8's call-
   volume arithmetic ("1 self-critique, capped at 1 in production" as a
   fixed, non-variable addition to the total call count), which only holds
   if checking and correcting are the same call.
"""
from gemini_client import call_gemini_json, call_gemini_json_freeform


# ---------------------------------------------------------------------------
# Structural pass — always runs. Ported from pipeline.js's STRUCTURAL_SYSTEM_
# PROMPT with the intent-field fix (see module docstring, point 3) and moved
# to Gemini (point 2).
# ---------------------------------------------------------------------------

STRUCTURAL_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "enhanced_prompt": {"type": "STRING"},
        "recap": {"type": "STRING"},
    },
    "required": ["enhanced_prompt", "recap"],
}

STRUCTURAL_SYSTEM_PROMPT = """You are the structural enhancement pass in a prompt-enhancement pipeline. You receive a draft prompt and an audit of it. Apply ONLY the following, and only where the audit indicates a genuine gap:
- Fill in any anatomy element marked "weak" or "missing" (instruction, context, output_indicator; input_data only if not "not_applicable").
- If technique_flags.role_assignment is true, prepend an appropriate role/persona line.
- If technique_flags.explicit_structure is true, organize the prompt with clear structure (e.g. labelled sections).
- If technique_flags.grounding_permission is true, append a line giving the model permission to say "I don't know" or ask for clarification rather than guess.
- Do NOT add chain-of-thought framing or few-shot examples — those are handled by separate passes.
- Do NOT change anything the audit marked "present" or add anything not flagged.
- Preserve the user's original intent, goal, register, and audience. Infer these directly from the draft prompt itself (there is no separate "intent" field supplied) — you are structuring their request, not replacing it.

Return a JSON object with exactly two fields:
{
  "enhanced_prompt": "the improved prompt text",
  "recap": "1-2 plain-language sentences on what changed and why, e.g. 'Added a clear output format so the response comes back structured the way you'll actually use it.' If nothing needed changing, say so briefly."
}"""


def structural_pass(draft_prompt: str, audit: dict, gemini_key: str) -> dict:
    user_content = _json_dumps({"draft_prompt": draft_prompt, "audit": audit})
    return call_gemini_json(gemini_key, STRUCTURAL_SYSTEM_PROMPT, user_content, STRUCTURAL_SCHEMA)


# ---------------------------------------------------------------------------
# Chain-of-thought pass — conditional on technique_flags.chain_of_thought.
#
# REAL, TESTED PROMPT (cot_enhance_prompt_v1.md) — replaces this file's
# earlier first-attempt version. This is the actual Track B-validated
# prompt (tested clean on 5 rows across both providers during harness
# development). Two adaptations were required, not present when it was
# tested against the old Groq-based architecture:
#   1. It requires BOTH task_domain AND complexity as input (see its own
#      "Input when testing this" note) — the first-attempt version this
#      replaces only passed task_domain. Fixed in chain_of_thought_pass()
#      below and in run_pipeline()'s call site.
#   2. Its output field is "recap_addition", not "recap" — kept exactly as
#      validated rather than forced to match the other passes' naming, so
#      the prompt text (which explicitly instructs this field name) stays
#      byte-identical to what was tested.
# No provider-specific tuning needed here — this file was validated on
# both Gemini and Groq during original testing and never required a
# provider split the way self-critique and few-shot did.
# ---------------------------------------------------------------------------

COT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "enhanced_prompt": {"type": "STRING"},
        "recap_addition": {"type": "STRING"},
    },
    "required": ["enhanced_prompt", "recap_addition"],
}

COT_SYSTEM_PROMPT = 'You are the chain-of-thought enhancement pass of a prompt-improvement\npipeline. You will receive a prompt that has already been through a\nstructural enhancement pass (it may already have a role, format, or\npermission language added), along with its task_domain and complexity. Your\nonly job is to add reasoning framing that helps the target AI think through\nthe task well, tailored to the kind of task it is, and only if that framing\nisn\'t already implied by the prompt\'s existing structure.\n\nOutput ONLY valid JSON, no markdown fences, no preamble, matching exactly:\n\n{\n  "enhanced_prompt": "the prompt text, with reasoning framing added",\n  "recap_addition": "one sentence on what reasoning framing was added and why"\n}\n\n--- STEP 1: CHECK FOR REDUNDANCY FIRST ---\nBefore adding anything, check whether the prompt you received already\nspecifies an output format that itself implies the reasoning order (for\nexample: "list the trade-offs, then give a recommendation", "pros and cons\nfor each option, then a conclusion", "walk through your reasoning, then\nanswer"). If it does, the reasoning structure is already there, just wearing\nthe clothes of an output format instead of an explicit reasoning\ninstruction. In that case, add nothing, or at most one short clause\nreinforcing that the model should genuinely weigh the factors rather than\njust listing them procedurally, do NOT add a separate numbered framework or\n"think step by step" instruction on top of an already-structured request. If\nthis applies, say so plainly in recap_addition, e.g. "No separate reasoning\nframing needed, the requested pros/cons-then-recommendation format already\nprovides that structure."\n\n--- STEP 2: IF NOT REDUNDANT, CHOOSE FRAMING BY DOMAIN ---\n\nFor coding, and any task that\'s fundamentally procedural or involves tracing\nthrough a sequence of causes or steps (debugging, multi-file reasoning, root\ncause analysis): add a short numbered-step instruction, but make the steps\nspecific to the actual content of this prompt, not generic placeholders like\n"Step 1: analyze, Step 2: conclude". Name the actual things to check or\nconsider, drawn from what the prompt itself describes.\n\nFor analysis_reasoning and other decision- or trade-off-style tasks: add a\nshort instruction to explicitly weigh the actual named factors or options\nagainst each other before concluding, again using the real content of the\nprompt (the real options, the real constraints), not generic language like\n"consider all relevant factors".\n\nFor any domain where the real chain_of_thought need is reconciling\nconflicting or disagreeing information (this can happen in summarization,\nextraction, or other domains, not just analysis_reasoning): add a short\ninstruction directing the model to explicitly address the specific points of\ndisagreement or tension before producing its answer, naming what\'s actually\nin conflict rather than a generic "consider multiple viewpoints" line.\n\nIn every case: keep the addition to one or two sentences. This is a nudge,\nnot a rewritten framework. Preserve everything else in the prompt exactly as\ngiven, you are adding one instruction, not restructuring the whole thing.\n\n--- CONFIDENCE CHECK ---\nIf you\'re not sure the framing you\'re about to add is genuinely specific to\nthis prompt\'s actual content, rather than a generic template phrase, rewrite\nit until it references something real from the prompt.\n\n--- WORKED EXAMPLES ---\nNone of these are in the eval dataset, they\'re illustrative only.\n\nInput prompt (from structural pass): "My deployment pipeline fails intermittently on the test stage, roughly one in five runs, and I can\'t tell if it\'s a flaky test, a resource limit, or a race condition in how the containers start up. Here is the relevant log output: [paste the log output here]. Provide your diagnosis followed by a recommended fix."\ntask_domain: coding, complexity: multi_part\nOutput:\n{"enhanced_prompt":"My deployment pipeline fails intermittently on the test stage, roughly one in five runs, and I can\'t tell if it\'s a flaky test, a resource limit, or a race condition in how the containers start up. Here is the relevant log output: [paste the log output here]. Before answering, work through the three possibilities in order: first check whether the failures look like a specific flaky test recurring, then check for signs of a resource limit (timeouts, OOM errors), then check for signs of a race condition in container startup order. Provide your diagnosis followed by a recommended fix.","recap_addition":"Added a specific order to check the three possible causes you mentioned, flaky test, resource limits, and race conditions, since each has different symptoms worth ruling in or out in turn."}\n(Note: the numbered steps reference the actual three hypotheses the user named, not a generic troubleshooting checklist.)\n\nInput prompt (from structural pass): "Should our team switch from Jira to Linear for issue tracking? We\'re a 12-person eng team, Linear seems faster and the UI is nicer but Jira has way more integrations with our other tools and switching would mean re-training everyone. Give me the trade-offs for each, then a recommendation."\ntask_domain: analysis_reasoning, complexity: multi_part\nOutput:\n{"enhanced_prompt":"Should our team switch from Jira to Linear for issue tracking? We\'re a 12-person eng team, Linear seems faster and the UI is nicer but Jira has way more integrations with our other tools and switching would mean re-training everyone. Give me the trade-offs for each, then a recommendation.","recap_addition":"No separate reasoning framing needed, the requested trade-offs-then-recommendation format already provides that structure."}\n(Note: this is the redundancy case. The prompt already asks for trade-offs then a recommendation, adding a second reasoning instruction on top would be redundant stacking, so nothing was added.)\n\nInput prompt (from structural pass): "okay so my self-review is due in 3 days and I got peer feedback back from like 6 different people and honestly it\'s kind of all over the place, some people said I need to speak up more in meetings and stop waiting to be asked before sharing my opinion, but then two other people said the opposite, that I sometimes talk over others and should let more space for quieter people on the team, and one person said my written updates are too long and hard to skim, but someone else specifically said they loved how thorough my written updates are and wished more people did that, so I genuinely don\'t know what to make of all this because it feels like contradictory advice, I haven\'t actually pasted the specific comments here because there\'s a lot of them and they\'re kind of scattered across an email and a survey tool, but that\'s basically the gist of what came back, can you help me figure out what to actually write for my self-review reflection section based on this, I really just need help pulling this into something coherent for my self-review. Write your response as 2-3 short paragraphs suitable for a formal self-review document."\ntask_domain: other, complexity: multi_part\nOutput:\n{"enhanced_prompt":"okay so my self-review is due in 3 days and I got peer feedback back from like 6 different people and honestly it\'s kind of all over the place, some people said I need to speak up more in meetings and stop waiting to be asked before sharing my opinion, but then two other people said the opposite, that I sometimes talk over others and should let more space for quieter people on the team, and one person said my written updates are too long and hard to skim, but someone else specifically said they loved how thorough my written updates are and wished more people did that, so I genuinely don\'t know what to make of all this because it feels like contradictory advice, I haven\'t actually pasted the specific comments here because there\'s a lot of them and they\'re kind of scattered across an email and a survey tool, but that\'s basically the gist of what came back, can you help me figure out what to actually write for my self-review reflection section based on this, I really just need help pulling this into something coherent for my self-review. Before writing, directly address the two specific contradictions in the feedback (speaking up vs. talking over others, and update length being both too long and appreciated), don\'t just pick one side, reconcile what a reasonable middle reading of each looks like. Write your response as 2-3 short paragraphs suitable for a formal self-review document.","recap_addition":"Added an instruction to directly reconcile the two specific contradictions in the feedback before writing, rather than just picking a side, since that reconciliation is the actual hard part of this task."}\n(Note: the output format here ("2-3 short paragraphs") doesn\'t itself imply weighing conflicting input, it\'s just a length/format spec, not a reasoning order. So this isn\'t the redundancy case, the reasoning framing genuinely adds something, and it names the actual two contradictions rather than a generic "consider the feedback" line.)\n\nNow add reasoning framing (or correctly add nothing) to the prompt you receive.'


def chain_of_thought_pass(current_prompt: str, task_domain: str, complexity: str, gemini_key: str) -> dict:
    user_content = _json_dumps({"prompt": current_prompt, "task_domain": task_domain, "complexity": complexity})
    return call_gemini_json(gemini_key, COT_SYSTEM_PROMPT, user_content, COT_SCHEMA)


# ---------------------------------------------------------------------------
# Few-shot pass — conditional on technique_flags.few_shot_examples.
#
# REAL, TESTED PROMPT (fewshot_enhance_prompt_v3_gemini.md) — replaces this
# file's earlier first-attempt version. Gemini-tuned: v3 specifically fixes
# a real regression found during testing (Gemini substituting a request for
# the user's own business context instead of actually addressing the
# few_shot_examples flag) with an explicit scope-lock rule and a negative
# worked example. Same "recap_addition" field-naming note as chain-of-
# thought above — kept as validated, not forced to match.
# ---------------------------------------------------------------------------

FEWSHOT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "enhanced_prompt": {"type": "STRING"},
        "recap_addition": {"type": "STRING"},
    },
    "required": ["enhanced_prompt", "recap_addition"],
}

FEWSHOT_SYSTEM_PROMPT = 'You are the few-shot enhancement pass of a prompt-improvement pipeline. You\nwill receive a prompt that has already been through earlier enhancement\npasses, along with its task_domain. Your only job is to add either a\ngenerated illustrative example or a clearly labeled placeholder asking for\nreal examples, whichever is appropriate, and nothing else.\n\nOutput ONLY valid JSON, no markdown fences, no preamble, matching exactly:\n\n{\n  "enhanced_prompt": "the prompt text, with an example or placeholder added",\n  "recap_addition": "one sentence on what was added and why"\n}\n\nThe input you receive may include structural markers, labels, or delimiters\n(for example, lines like "task_domain:", or wrapper tokens marking where the\nprompt text starts and ends). These are formatting aids for how the input\nwas presented to you, not part of the actual prompt. Never include them, or\nanything resembling them, anywhere in your enhanced_prompt output, only the\nactual prompt content and your addition belong there.\n\n--- STEP 1: DOMAIN DEFAULT ---\nStart from this default based on task_domain:\n- creative, summarization, extraction: default to GENERATING one plausible\n  illustrative example.\n- analysis_reasoning, coding, factual_qa: default to INSERTING A PLACEHOLDER\n  asking the user to supply 2-3 real examples.\n\nThe reasoning behind the default: for creative, summarization, and\nextraction tasks, a generic made-up example is low-risk, it just\ndemonstrates a style or shape, nobody could mistake it for a real fact\nabout their situation. For analysis_reasoning, coding, and factual_qa, a\nfabricated example risks looking like real domain expertise or a real fact\nwhen it isn\'t, so asking the user for their own real examples is safer than\ninventing something that could mislead.\n\n--- STEP 2: CHECK FOR THE EXCEPTION ---\nThe domain default is a starting point, not an absolute rule. Override it\nwhen the specific content of the prompt makes the usual risk not apply:\n\nOverride to GENERATE (even in a placeholder-default domain) when the\nexample needed is generic and self-contained, a worked calculation, a\nsimple illustrative scenario used purely to demonstrate a concept, not\nsomething that needs to be factually authoritative or specific to the\nuser\'s real situation.\n\nOverride to INSERT A PLACEHOLDER (even in a generate-default domain) when\nthe example would need to reflect something specific and real to be useful,\ncompany-specific business rules, a particular person\'s actual writing\nstyle, real data the model has no way to know.\n\nWhen in doubt, ask: if this example turned out to be wrong or made up,\nwould that actually mislead the user, or would they obviously recognize it\nas illustrative? If the former, use a placeholder. If the latter, generate.\n\n--- STEP 3: STAY SCOPED TO THIS TECHNIQUE, DO NOT SUBSTITUTE A DIFFERENT FIX ---\nYour only job is to add an example, or a request for examples. Do not\nreplace this with a different kind of addition, no matter how useful it\nmight seem. In particular, do not ask for general background or context\nabout the user\'s own situation (their metrics, their budget, their current\nsetup) as a substitute for asking about comparable examples. Requesting\ncontext is a different pass\'s job, not this one\'s. If the flagged need is\nfor comparable or illustrative examples, your addition must specifically be\nabout examples, full stop, even when a different kind of question also\noccurs to you as helpful.\n\nWRONG, do not produce this kind of output: given a prompt asking "can you\ngive me some comparable examples of how other companies handled this",\nresponding with an addition like "please provide 2-3 details about your own\nticket volume, complexity, or costs". That\'s asking for the user\'s own\ncontext, not examples, it doesn\'t satisfy the few_shot_examples flag even\nthough it\'s a reasonable-sounding question.\n\n--- STEP 4: HOW TO WRITE EACH ---\n\nGenerated example: label it clearly as an example the user should verify\nor replace, don\'t present it as if it came from a real source. Keep it\nshort.\n\nPlaceholder: phrase it as a specific request naming what kind of examples\nwould help, not a generic "[insert examples]". Ask for 2-3, and briefly say\nwhy real ones matter more than made-up ones for this particular case.\n\nIn both cases: add this as one clearly-separated addition to the prompt,\ndon\'t rewrite or restructure anything else that\'s already there.\n\n--- WORKED EXAMPLES ---\nNone of these are in the eval dataset, they\'re illustrative only.\n\nInput prompt: "Write a few different email subject lines for a\nre-engagement campaign targeting users who haven\'t logged in for 60+ days,\nnot sure what tone works best, want to see some range before I commit to a\ndirection."\ntask_domain: creative\nOutput:\n{"enhanced_prompt":"Write a few different email subject lines for a re-engagement campaign targeting users who haven\'t logged in for 60+ days, not sure what tone works best, want to see some range before I commit to a direction. For reference, one possible style: \\"We miss you, here\'s what\'s new\\", casual and warm. Feel free to explore other tones too, this is just one illustrative direction, not the only one to use.","recap_addition":"Added one example subject line to anchor the kind of range you\'re looking for, since the tone was left open. Treat it as one illustrative direction, not a fixed answer."}\n\nInput prompt: "Explain how to calculate a weighted average, it would help\nto see it applied to an example."\ntask_domain: factual_qa\nOutput:\n{"enhanced_prompt":"Explain how to calculate a weighted average, it would help to see it applied to an example. Include a simple worked example with made-up numbers (for instance, averaging a few test scores with different weights) to illustrate the mechanism clearly.","recap_addition":"Added a note to include a simple worked example with illustrative numbers, since a generic worked calculation helps explain this kind of concept without needing to be about anything specific."}\n\nInput prompt: "Write a function to validate our company\'s discount code\nformat, not sure what edge cases to cover, can you show me a few examples\nof test cases so I understand what to check for."\ntask_domain: coding\nOutput:\n{"enhanced_prompt":"Write a function to validate our company\'s discount code format, not sure what edge cases to cover. Please provide 2-3 real example discount codes (valid and invalid) from your actual format so the test cases reflect your real rules rather than a generic guess, made-up examples here could miss the specific pattern your codes actually follow.","recap_addition":"Added a request for 2-3 of your real discount code examples instead of generating fake ones, since your actual code format is company-specific and a fabricated example could miss real edge cases you need covered."}\n\nInput prompt: "Extract the key terms from these contracts, not sure what\nformat would be most useful, can you show me what the output could look\nlike?"\ntask_domain: extraction\nOutput:\n{"enhanced_prompt":"Extract the key terms from these contracts, not sure what format would be most useful. For reference, one possible output shape: \\"Term: [name] | Definition: [as stated] | Section: [reference]\\", one row per key term. This is just one illustrative format, adjust it if something else would work better for your use.","recap_addition":"Added one example of a possible output format to give a concrete starting point, since the format itself was left open."}\n\nInput prompt: "Help me think through this decision by looking at how other\ncompanies handled similar trade-offs, can you give me some comparable\nexamples?"\ntask_domain: analysis_reasoning\nOutput:\n{"enhanced_prompt":"Help me think through this decision by looking at how other companies handled similar trade-offs. Please share 2-3 real, specific comparable examples if you have them, company name and situation, not a generic or invented case study, since a fabricated example could be mistaken for a real precedent and actually mislead the decision.","recap_addition":"Added a request for real, named comparable examples rather than leaving it open to a generic answer, since an invented case study here could be mistaken for a real precedent."}\n(Note: the request was specifically for comparable examples. The fix asks for comparable examples too, real and named. It does NOT pivot to asking about the user\'s own business metrics instead, that would be answering a different question than the one that was actually flagged.)\n\nNow add the appropriate example or placeholder to the prompt you receive.\nStay strictly scoped to examples, not general context-gathering.'


def few_shot_pass(current_prompt: str, task_domain: str, gemini_key: str) -> dict:
    user_content = _json_dumps({"prompt": current_prompt, "task_domain": task_domain})
    return call_gemini_json(gemini_key, FEWSHOT_SYSTEM_PROMPT, user_content, FEWSHOT_SCHEMA)


# ---------------------------------------------------------------------------
# Self-critique — REAL, TESTED PROMPT (self_critique_prompt_v3_gemini.md),
# replacing this file's earlier first-attempt version. Went through a real
# v1->v2->v3 correction cycle during harness development: v1 had a serious
# bug (deleting genuine user content, root-caused to never receiving the
# original draft — the same defect independently rediscovered and fixed in
# this backend's own pipeline.js port, see module docstring point 4); v2
# fixed that but introduced a Gemini-specific regression on the
# chain_of_thought redundancy carve-out; v3 (this file) fixes that too and
# corrects a backwards grounding_permission fix Gemini was producing
# (hedging language instead of confidence-granting language). All of that
# history is real testing this backend inherits for free by using the file
# as-is rather than reinventing it.
#
# Confirms, independently, the single-combined-call design already used in
# this module (see the call-volume note that used to live here): this
# validated prompt's own schema already returns passed + revised_prompt in
# ONE response, exactly the pattern Section 8's call-volume arithmetic
# requires.
#
# ONE REAL ADAPTATION REQUIRED: this prompt's checklist.flagged_techniques_
# applied values are genuinely mixed-type per its own spec — the JSON
# boolean true/false OR the string "not_flagged", three states across two
# JSON types. Gemini's strict responseSchema requires one fixed type per
# field, so calling this through the same schema-constrained path as the
# other passes would force either dropping the three-state distinction or
# stringifying the booleans — a real behavior change from what was tested,
# not a cosmetic one. Since this prompt was originally tested via manual/
# spreadsheet output rather than strict schema enforcement anyway, this
# call uses call_gemini_json_freeform() (JSON mode, no schema) instead,
# reproducing the conditions it was actually validated under. The prompt's
# own text fully specifies the required shape, so the schema isn't doing
# real enforcement work here regardless.
# ---------------------------------------------------------------------------

CRITIQUE_SYSTEM_PROMPT = 'You are the self-critique step of a prompt-improvement pipeline. You will\nreceive three things: the user\'s original draft prompt, the audit findings\nfor it, and the enhanced prompt that was produced from it. Your job is to\nverify the enhancement was done correctly, using the original draft as your\nreference for what content already existed versus what was added, and fix\nit directly if it wasn\'t done correctly.\n\nOutput ONLY valid JSON, no markdown fences, no preamble, matching exactly:\n\n{\n  "checklist": {\n    "anatomy_gaps_addressed": true or false,\n    "flagged_techniques_applied": {\n      "role_assignment": true, false, or "not_flagged",\n      "few_shot_examples": true, false, or "not_flagged",\n      "chain_of_thought": true, false, or "not_flagged",\n      "explicit_structure": true, false, or "not_flagged",\n      "grounding_permission": true, false, or "not_flagged"\n    },\n    "no_unflagged_techniques_added": true or false\n  },\n  "passed": true or false,\n  "revised_prompt": null, or the corrected prompt text if passed is false,\n  "issue_summary": "" if passed, otherwise a brief internal note on what was wrong, for logging, this is never shown to the user\n}\n\nThe input you receive may include structural markers or labels (for\nexample, lines like "Original draft prompt:", "Audit:", "Enhanced prompt:").\nThese are formatting aids, not part of any actual prompt content. Never\ninclude them, or anything resembling them, anywhere in your revised_prompt\noutput.\n\nThe checklist always describes the enhanced_prompt exactly as you received\nit, before any correction you make.\n\n--- IDENTICAL TEXT IS NOT ITSELF EVIDENCE OF A PROBLEM ---\nIt\'s completely normal and correct for the enhanced_prompt to be word-for-\nword identical to the original draft prompt. This happens whenever nothing\nneeded to change, either because every technique flag is false, or because\nthe one true flag is chain_of_thought and the redundancy carve-out already\napplies (see Check 2 below). Do not treat "the text is unchanged" as proof\nthat a flagged technique wasn\'t applied. Judge each flag on its own actual\nevidence, not on whether the overall text moved.\n\n--- EVERY CHECKLIST FIELD MUST MATCH THE EVIDENCE, AND MATCH YOUR OWN FIX ---\nThis applies to anatomy_gaps_addressed and no_unflagged_techniques_added\njust as much as it applies to the individual technique flags. A field can\nonly be marked true if you can point to actual text already present in the\nenhanced_prompt you were given, never mark something true because you\'re\nabout to fix it in your revision, or because a related field looks\ncorrect, check each field independently. And the reverse matters just as\nmuch: if you mark a field false because something is missing or wrong,\nyour revised_prompt must actually contain that fix. Before finalizing your\noutput, re-read your own issue_summary against your own checklist values,\nif they describe different problems, one of them is wrong, resolve the\ncontradiction before answering.\n\n--- CHECK 1: ANATOMY GAPS ADDRESSED ---\nFor every anatomy element the audit marked "weak" or "missing" (instruction,\ncontext, output_indicator), check that the enhanced prompt now genuinely\naddresses it, with real content or an honest placeholder. For input_data\nmarked "missing", check that a clearly marked placeholder exists. Elements\nmarked "present" or "not_applicable" don\'t need checking.\n\n--- CHECK 2: EVERY TRUE FLAG IS ACTUALLY REFLECTED ---\nFor each technique flag the audit set to true, look for real evidence in\nthe enhanced_prompt text:\n- role_assignment: a role/persona framing is present.\n- explicit_structure: concrete length/format/audience/tone guidance is\n  present.\n- grounding_permission: language giving PERMISSION TO ANSWER DIRECTLY AND\n  CONFIDENTLY is present, something like "answer directly rather than\n  listing extensive caveats" or "give a clear, confident take". This is the\n  opposite of hedging language. A line like "if you\'re unsure, say you\n  don\'t know" does NOT satisfy this flag, that\'s inviting uncertainty, not\n  granting confidence, don\'t accept it as a fix and don\'t write it as one.\n- few_shot_examples: a generated example or a real-examples request is\n  present.\n- chain_of_thought: if the requested output format already implies a\n  reasoning order on its own (e.g. "pros and cons, then a recommendation"),\n  it\'s correct for no separate reasoning framework to be visible, and it\'s\n  also correct for the enhanced_prompt to be identical to the original in\n  this case, that\'s not evidence of failure, that\'s the redundancy\n  carve-out working as intended. Only fail this if there\'s neither an\n  implied order in the output format NOR any reasoning framing at all.\n\nFlags not true in the audit are "not_flagged", don\'t evaluate them here.\n\n--- CHECK 3: NOTHING UNFLAGGED WAS ADDED, COMPARE AGAINST THE ORIGINAL ---\nFor every technique flag the audit set to false, check whether that kind of\ncontent exists in the enhanced_prompt AND is ABSENT from the original draft\nprompt, meaning it was actually added during enhancement. If content\nresembling a false-flagged technique is present in BOTH the original draft\nand the enhanced_prompt, that\'s not a problem, the user already had it,\nleave it exactly as written. Never remove or rewrite anything present in\nthe original draft prompt, regardless of which flags are true or false.\n\n--- DECIDING PASSED, AND WHAT TO DO IF NOT ---\npassed is true only if all three checks pass. If any check fails, produce\nrevised_prompt: the minimum correction needed, nothing more. Don\'t invent\nelaborate extra specifics beyond what the gap actually calls for. If an\nunflagged technique was added (confirmed absent from the original draft),\nremove exactly that, nothing else. Every part of the prompt that traces\nback to the user\'s own original draft stays exactly as it was.\n\n--- WORKED EXAMPLES ---\nNone of these are in the eval dataset, they\'re illustrative only.\n\nOriginal draft prompt: "Write a haiku (5-7-5 syllables) about the first snowfall of winter. Traditional nature-focused tone, no rhyme needed, present tense, no title."\nAudit: anatomy all present; technique_flags: role_assignment=false, few_shot_examples=false, chain_of_thought=false, explicit_structure=false, grounding_permission=false\nEnhanced prompt: "Write a haiku (5-7-5 syllables) about the first snowfall of winter. Traditional nature-focused tone, no rhyme needed, present tense, no title."\nOutput:\n{"checklist":{"anatomy_gaps_addressed":true,"flagged_techniques_applied":{"role_assignment":"not_flagged","few_shot_examples":"not_flagged","chain_of_thought":"not_flagged","explicit_structure":"not_flagged","grounding_permission":"not_flagged"},"no_unflagged_techniques_added":true},"passed":true,"revised_prompt":null,"issue_summary":""}\n(Note: the detail present is also in the original draft, word for word, nothing was added by enhancement.)\n\nOriginal draft prompt: "write me a poem"\nAudit: anatomy instruction=weak, context=missing, input_data=not_applicable, output_indicator=missing; technique_flags: role_assignment=false, few_shot_examples=false, chain_of_thought=false, explicit_structure=false, grounding_permission=false\nEnhanced prompt: "Act as a master poet. Write a poem about a topic of your choosing."\nOutput:\n{"checklist":{"anatomy_gaps_addressed":false,"flagged_techniques_applied":{"role_assignment":"not_flagged","few_shot_examples":"not_flagged","chain_of_thought":"not_flagged","explicit_structure":"not_flagged","grounding_permission":"not_flagged"},"no_unflagged_techniques_added":false},"passed":false,"revised_prompt":"Write a poem about a topic of your choosing.","issue_summary":"\'Act as a master poet\' appears in the enhanced prompt but not in the original draft, and role_assignment was flagged false, removed it. output_indicator is still unaddressed."}\n\nOriginal draft prompt: "Should we outsource our customer support team or keep it in-house? We\'re a 15-person company, outsourcing would save roughly $80k a year but we\'ve heard mixed things about response quality. Give me the trade-offs, then a recommendation."\nAudit: anatomy all present; technique_flags: role_assignment=false, few_shot_examples=false, chain_of_thought=true, explicit_structure=false, grounding_permission=false\nEnhanced prompt: "Should we outsource our customer support team or keep it in-house? We\'re a 15-person company, outsourcing would save roughly $80k a year but we\'ve heard mixed things about response quality. Give me the trade-offs, then a recommendation."\nOutput:\n{"checklist":{"anatomy_gaps_addressed":true,"flagged_techniques_applied":{"role_assignment":"not_flagged","few_shot_examples":"not_flagged","chain_of_thought":true,"explicit_structure":"not_flagged","grounding_permission":"not_flagged"},"no_unflagged_techniques_added":true},"passed":true,"revised_prompt":null,"issue_summary":""}\n(Note: chain_of_thought is flagged true, and the enhanced_prompt is identical to the original draft, nothing changed. This is still correct: "trade-offs, then a recommendation" already provides the reasoning order the flag is asking for. An unchanged prompt is not evidence the flag was missed, judge the actual content, which already satisfies it.)\n\nNow check the enhanced prompt you receive against its original draft and\naudit, and return only the JSON object.'


def critique_and_correct(draft_prompt: str, audit: dict, current_prompt: str, gemini_key: str) -> dict:
    user_content = _json_dumps({
        "draft_prompt": draft_prompt,
        "audit": audit,
        "enhanced_prompt": current_prompt,
    })
    return call_gemini_json_freeform(gemini_key, CRITIQUE_SYSTEM_PROMPT, user_content)


# ---------------------------------------------------------------------------
# Full orchestration
# ---------------------------------------------------------------------------

def run_pipeline(
    draft_prompt: str,
    gemini_key: str,
    audit_fn,
    max_critique_iterations: int = 1,
    on_progress=lambda stage: None,
) -> dict:
    """
    audit_fn: callable(draft_prompt) -> dict — injected rather than imported
    directly, so this module stays agnostic to whether audit is served by
    audit_model.run_audit (local testing) or, later, a Modal GPU function
    call (see modal_app.py) — the orchestration logic is identical either way.

    max_critique_iterations: 1 in production (per the final architecture,
    to bound added latency on a live user-facing request), pass 2 to match
    how the harness has always measured it for offline evaluation runs.
    """
    on_progress({"step": "audit", "label": "Auditing your draft..."})
    audit = audit_fn(draft_prompt)

    on_progress({"step": "structural", "label": "Applying structural improvements..."})
    structural = structural_pass(draft_prompt, audit, gemini_key)
    current = structural["enhanced_prompt"]
    recaps = [structural["recap"]]

    flags = audit["technique_flags"]

    if flags.get("chain_of_thought"):
        on_progress({"step": "chain_of_thought", "label": "Adding reasoning framing..."})
        cot = chain_of_thought_pass(current, audit["task_domain"], audit["complexity"], gemini_key)
        current = cot["enhanced_prompt"]
        recaps.append(cot["recap_addition"])

    if flags.get("few_shot_examples"):
        on_progress({"step": "few_shot", "label": "Adding an example..."})
        fewshot = few_shot_pass(current, audit["task_domain"], gemini_key)
        current = fewshot["enhanced_prompt"]
        recaps.append(fewshot["recap_addition"])

    # Self-critique is deliberately invisible to the end user (per its own
    # header: "Final step before the enhanced prompt reaches the user,
    # invisible to them") — its issue_summary is explicitly documented as
    # "for logging, this is never shown to the user". So it contributes to
    # the returned enhanced_prompt when it corrects something, but never to
    # the user-facing `recap` text the way structural/cot/fewshot do.
    critique = None
    for i in range(max_critique_iterations):
        on_progress({"step": "critique", "label": f"Running self-critique (iteration {i + 1})..."})
        critique = critique_and_correct(draft_prompt, audit, current, gemini_key)
        # revised_prompt is null when passed=true (per the validated schema) —
        # only overwrite `current` when a real correction was made, never
        # blindly assign, or a passing check would wipe out the prompt.
        if critique.get("revised_prompt") is not None:
            current = critique["revised_prompt"]
        if critique["passed"]:
            break

    return {
        "enhanced_prompt": current,
        "recap": " ".join(recaps),
        "audit": audit,
        "critique_passed": critique["passed"] if critique else None,
        # Internal-only, per the prompt's own instructions — expose it in the
        # API response for your own debugging/logging, but the extension
        # should not surface this to the end user the way `recap` is meant to.
        "critique_issue_summary": critique.get("issue_summary", "") if critique else "",
        "critique_checklist": critique.get("checklist") if critique else None,
    }


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj)
