"""
Loads the fine-tuned Phi-4-mini-reasoning audit model (base + LoRA adapter)
and exposes run_audit(draft_prompt) -> dict, matching the exact JSON shape
the model was trained to produce (see trackb prepare_finetune_data.py /
audit_step_v9_MODEL_FACING.md).

IMPORTANT: no "intent" field here. Track A's original client-side
AUDIT_SCHEMA (pipeline.js) has one (goal/register/audience), but nothing in
the labeled training data or the harness schema ever did — that mismatch was
flagged during fine-tuning data prep and deliberately not carried into this
backend. pipeline.py's structural pass infers intent directly from the draft
prompt it already receives, instead of depending on a field the fine-tuned
model doesn't emit — see that file's docstring.

THIS MODULE IS FOR LOCAL TESTING OF THE PIPELINE, NOT THE FINAL DEPLOYMENT
TARGET. The actual architecture (promptassist_final_pipeline.md) serves audit
from a Modal GPU function — see modal_app.py for that, not yet tested since
Modal access requires a payment method not presently set up. This module lets
you validate the full pipeline's orchestration logic today, using the adapter
checkpoint already produced by training, without waiting on that.

Requires a local CUDA GPU for the real model (bitsandbytes 4-bit quant is not
practical on CPU). If you don't have one, set MOCK_AUDIT=1 to test the rest of
the pipeline (Gemini calls, orchestration, API) against a fixed fake audit
result instead — see mock_audit() below.
"""
import json
import os
import re
from pathlib import Path

BASE_MODEL = "unsloth/Phi-4-mini-reasoning-unsloth-bnb-4bit"
SYSTEM_PROMPT_PATH = Path(__file__).parent / "audit_step_v9_MODEL_FACING.md"

_model = None
_tokenizer = None
_system_prompt = None


def _format_phi4_mini(conversations):
    """Literal Phi-4-mini-reasoning template — must match the fine-tuning
    notebook exactly (<|role|>content<|end|>, no separators, no <bos> etc.)."""
    parts = []
    for turn in conversations:
        parts.append(f"<|{turn['role']}|>{turn['content']}<|end|>")
    return "".join(parts)


def _extract_json(text: str):
    """Strip a <think>...</think> span (Phi-4-mini-reasoning may emit one
    despite the system prompt asking for JSON only) and markdown fences,
    then parse. Same logic as the fine-tuning notebook's §9 eval cell."""
    text = text.strip()
    think_end = text.rfind("</think>")
    if think_end != -1:
        text = text[think_end + len("</think>"):].strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def load(adapter_dir: str):
    """Call once at process startup. adapter_dir: path to the unzipped
    trackb_audit_adapter_v1/ directory (adapter_config.json, adapter_model.
    safetensors, tokenizer files — exactly what §8 of the training notebook
    produces)."""
    global _model, _tokenizer, _system_prompt

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    _tokenizer = AutoTokenizer.from_pretrained(adapter_dir)
    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL, load_in_4bit=True, device_map="auto",
    )
    _model = PeftModel.from_pretrained(base, adapter_dir)
    _model.eval()
    _system_prompt = SYSTEM_PROMPT_PATH.read_text()


def run_audit(draft_prompt: str) -> dict:
    if os.environ.get("MOCK_AUDIT") == "1":
        return mock_audit(draft_prompt)

    if _model is None:
        raise RuntimeError(
            "audit_model.load() must be called before run_audit() — "
            "or set MOCK_AUDIT=1 to skip real inference for local testing."
        )

    import torch

    prompt_text = _format_phi4_mini([
        {"role": "system", "content": _system_prompt},
        {"role": "user", "content": draft_prompt},
    ]) + "<|assistant|>"

    inputs = _tokenizer(prompt_text, return_tensors="pt").to(_model.device)
    with torch.no_grad():
        out = _model.generate(
            **inputs, max_new_tokens=600, use_cache=True,
            temperature=0.1, do_sample=False,
        )
    text = _tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
    result = _extract_json(text)
    if result is None:
        raise ValueError(f"Audit model returned unparseable output: {text[:300]!r}")
    return result


def mock_audit(draft_prompt: str) -> dict:
    """Fixed, deliberately-mixed fake audit result for testing the rest of the
    pipeline (Gemini calls, conditional branching, critique/revise loop, the
    API layer) without a GPU or a loaded model at all. Flags every technique
    true at least once so every conditional pass in pipeline.py actually gets
    exercised during a smoke test — do not use this for anything but local
    dev testing."""
    return {
        "anatomy": {
            "instruction": "present",
            "context": "weak",
            "input_data": "not_applicable",
            "output_indicator": "missing",
        },
        "task_domain": "analysis_reasoning",
        "complexity": "multi_part",
        "technique_flags": {
            "role_assignment": True,
            "few_shot_examples": True,
            "chain_of_thought": True,
            "explicit_structure": True,
            "grounding_permission": False,
        },
        "confidence": 0.65,
    }
