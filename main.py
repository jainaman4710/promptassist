"""
FastAPI backend for the full audit-enhance-critique pipeline.

THREE AUDIT MODES, checked in this priority order at both startup and per
request:
  1. MOCK_AUDIT=1        — fixed fake result, for local testing without a
                            model or Gemini calls for audit specifically.
  2. AUDIT_VIA_GEMINI=1  — audit runs as a real Gemini call against the
                            validated audit_step_v9_MODEL_FACING.md rulebook
                            (see audit_gemini.py). Interim mode for while the
                            fine-tuned model isn't deployed anywhere — not a
                            placeholder, this rulebook was a validated Gemini
                            prompt before fine-tuning existed at all.
  3. (neither set)       — the real fine-tuned model, loaded from ADAPTER_DIR
                            (audit_model.py). The eventual production mode
                            once the model is actually hosted (Modal or
                            otherwise).

RUN LOCALLY (see README.md for full steps):
    export BACKEND_API_KEY=some-key-you-make-up
    export AUDIT_VIA_GEMINI=1                        # or ADAPTER_DIR=./trackb_audit_adapter_v1, or MOCK_AUDIT=1
    uvicorn main:app --reload

This is the same FastAPI app that promptassist_final_pipeline.md's
architecture eventually wraps in @modal.asgi_app() for real deployment (see
modal_app.py) — running it directly with uvicorn now lets you test the whole
pipeline today, without a Modal account. It's also the same app deployed
as-is to Hugging Face Spaces (see Dockerfile) for AUDIT_VIA_GEMINI mode —
no code differences between "run locally" and "hosted on HF Spaces," only
which environment variables are set.

Auth: a single static API key per deployment (pipeline doc Section 9) — safe
under the self-hosted-kit distribution model specifically because every
installer's key only grants access to infrastructure they themselves run and
pay for. Checked via the X-API-Key header, matching what the extension's
settings page (per that section) is meant to store and send.

The caller supplies their OWN Gemini key per request (gemini_api_key in the
body) rather than the backend holding one server-side — also per the self-
hosted-kit model, so each installer's Gemini usage bills to their own key.
This is true for every Gemini call this backend makes, AUDIT_VIA_GEMINI mode
included — the server itself never holds a Gemini key.
"""
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import audit_gemini
import audit_model
import pipeline

app = FastAPI(title="PromptAssist Backend")


@app.on_event("startup")
def _startup():
    if os.environ.get("MOCK_AUDIT") == "1":
        print("MOCK_AUDIT=1 — skipping real model load, audit calls return a fixed fake result.")
        return
    if os.environ.get("AUDIT_VIA_GEMINI") == "1":
        print("AUDIT_VIA_GEMINI=1 — audit will run as a real Gemini call, no local model load needed.")
        return
    adapter_dir = os.environ.get("ADAPTER_DIR")
    if not adapter_dir:
        raise RuntimeError(
            "Set ADAPTER_DIR to the unzipped trackb_audit_adapter_v1/ path, "
            "or set AUDIT_VIA_GEMINI=1 for the interim Gemini-audit mode, "
            "or set MOCK_AUDIT=1 to test without any real audit call."
        )
    print(f"Loading audit model from {adapter_dir} ...")
    audit_model.load(adapter_dir)
    print("Audit model loaded.")


class EnhanceRequest(BaseModel):
    draft_prompt: str
    gemini_api_key: str
    # Optional override, mainly for testing/harness-style runs against this
    # endpoint — production traffic from the extension should omit this and
    # get the default (1) per the final architecture's production cap.
    max_critique_iterations: int | None = None
    # TESTING ONLY. When MOCK_AUDIT=1 on the server, lets a caller supply a
    # specific audit result instead of the default fixed mock — this is what
    # makes it possible to exercise every conditional branch (each technique
    # flag alone, every domain, the all-false control case) without a real
    # model, rather than only ever testing the one fixed combination
    # audit_model.mock_audit() returns. Silently IGNORED unless the server
    # has MOCK_AUDIT=1 set — a real deployment (Modal, or ADAPTER_DIR set
    # locally) never honors this, so a caller can never bypass the real
    # audit model this way.
    audit_override: dict | None = None


class EnhanceResponse(BaseModel):
    enhanced_prompt: str
    recap: str
    audit: dict
    critique_passed: bool | None
    # Internal-only per the validated critique prompt's own instructions
    # ("for logging, this is never shown to the user") — included here for
    # your own debugging, the extension UI should not display these two.
    critique_issue_summary: str
    critique_checklist: dict | None


def _check_auth(x_api_key: str | None):
    expected = os.environ.get("BACKEND_API_KEY")
    if not expected:
        raise HTTPException(500, "Server misconfigured: BACKEND_API_KEY not set.")
    if x_api_key != expected:
        raise HTTPException(401, "Invalid or missing X-API-Key header.")


@app.post("/enhance", response_model=EnhanceResponse)
def enhance(req: EnhanceRequest, x_api_key: str | None = Header(default=None)):
    _check_auth(x_api_key)

    if not req.draft_prompt.strip():
        raise HTTPException(400, "draft_prompt is empty.")
    if not req.gemini_api_key.strip():
        raise HTTPException(400, "gemini_api_key is required.")

    max_iters = req.max_critique_iterations if req.max_critique_iterations is not None else 1

    if os.environ.get("MOCK_AUDIT") == "1":
        audit_fn = audit_model.run_audit
        if req.audit_override is not None:
            override = req.audit_override
            audit_fn = lambda draft_prompt: override  # noqa: E731 — deliberately simple, testing-only path
    elif os.environ.get("AUDIT_VIA_GEMINI") == "1":
        # Closure captures this request's own Gemini key — audit_gemini.run_audit needs
        # one (no server-side key, see module docstring), but pipeline.py's audit_fn
        # contract stays a single-argument callable either way, so pipeline.py itself
        # never needs to know or care which audit source is active.
        gemini_key = req.gemini_api_key
        audit_fn = lambda draft_prompt: audit_gemini.run_audit(draft_prompt, gemini_key)  # noqa: E731
    else:
        audit_fn = audit_model.run_audit

    try:
        result = pipeline.run_pipeline(
            draft_prompt=req.draft_prompt,
            gemini_key=req.gemini_api_key,
            audit_fn=audit_fn,
            max_critique_iterations=max_iters,
        )
    except Exception as e:
        raise HTTPException(502, f"Pipeline error: {e}")

    return result


@app.get("/health")
def health():
    return {"status": "ok"}
