"""
Audit via Gemini — an interim, non-dummy audit source for while the
fine-tuned model isn't hosted anywhere yet (no Modal deployment, and local
GPU inference isn't an option for a hosted service).

This is NOT a placeholder in the "fake it for now" sense. audit_step_v9_
MODEL_FACING.md was originally a validated Gemini prompt before fine-tuning
entered the picture at all — that's what the v7->v8->v9 harness work in
promptassist_project_report.md actually was. Using it here as a real,
schema-constrained Gemini call reuses an already-proven configuration,
rather than inventing a new stopgap approach.

Used when AUDIT_VIA_GEMINI=1 is set on the server (see main.py's startup
and /enhance handler). Swappable later for the real fine-tuned model
(audit_model.py, local or Modal-hosted per modal_app.py) by changing which
function gets passed as audit_fn into pipeline.run_pipeline() — nothing
else in the pipeline needs to change, that's the whole point of audit_fn
being an injected callable rather than a hardcoded import.
"""
from pathlib import Path

from gemini_client import call_gemini_json

SYSTEM_PROMPT_PATH = Path(__file__).parent / "audit_step_v9_MODEL_FACING.md"
_system_prompt = None

# Every field here is a uniform type (string enum, boolean, number) — unlike
# the self-critique prompt's genuinely mixed-type checklist (see pipeline.py's
# critique section for that story), audit's schema has no such conflict, so
# this uses the normal schema-constrained call, not the freeform one.
AUDIT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "anatomy": {
            "type": "OBJECT",
            "properties": {
                "instruction": {"type": "STRING", "enum": ["present", "weak", "missing"]},
                "context": {"type": "STRING", "enum": ["present", "weak", "missing"]},
                "input_data": {"type": "STRING", "enum": ["present", "weak", "missing", "not_applicable"]},
                "output_indicator": {"type": "STRING", "enum": ["present", "weak", "missing"]},
            },
            "required": ["instruction", "context", "input_data", "output_indicator"],
        },
        "task_domain": {
            "type": "STRING",
            "enum": ["creative", "factual_qa", "analysis_reasoning", "coding", "summarization", "extraction", "other"],
        },
        "complexity": {"type": "STRING", "enum": ["single_step", "multi_part"]},
        "technique_flags": {
            "type": "OBJECT",
            "properties": {
                "role_assignment": {"type": "BOOLEAN"},
                "few_shot_examples": {"type": "BOOLEAN"},
                "chain_of_thought": {"type": "BOOLEAN"},
                "explicit_structure": {"type": "BOOLEAN"},
                "grounding_permission": {"type": "BOOLEAN"},
            },
            "required": [
                "role_assignment", "few_shot_examples", "chain_of_thought",
                "explicit_structure", "grounding_permission",
            ],
        },
        "confidence": {"type": "NUMBER"},
    },
    "required": ["anatomy", "task_domain", "complexity", "technique_flags", "confidence"],
}


def _load_system_prompt() -> str:
    global _system_prompt
    if _system_prompt is None:
        _system_prompt = SYSTEM_PROMPT_PATH.read_text()
    return _system_prompt


def run_audit(draft_prompt: str, gemini_key: str) -> dict:
    """Note the extra gemini_key argument, unlike audit_model.run_audit(draft_prompt) —
    this audit source needs a per-request key (the caller's own, self-hosted-kit style,
    same as every other Gemini call in this backend), not a locally-loaded model. main.py
    wraps this in a closure that captures the request's key so pipeline.py's audit_fn
    contract (a single-argument callable) doesn't need to change."""
    system_prompt = _load_system_prompt()
    return call_gemini_json(gemini_key, system_prompt, draft_prompt, AUDIT_SCHEMA)
