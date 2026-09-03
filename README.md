# PromptAssist Backend

This is the FastAPI backend from `promptassist_final_pipeline.md`'s
architecture: audit → structural (always) → chain-of-thought (conditional)
→ few-shot (conditional) → self-critique with a bounded revise loop, all
server-side. Runnable locally for testing, or deployed to Hugging Face
Spaces as a real, publicly-reachable interim deployment (see Option C)
while the fine-tuned model isn't hosted anywhere yet.

**Model**: every Gemini call in this backend uses `gemini-3.5-flash-lite`
— matches what `self_critique_prompt_v3_gemini.md`, `fewshot_enhance_
prompt_v3_gemini.md`, and the CoT prompt were actually validated against
per `promptassist_final_pipeline.md` ("Gemini flash-lite cascade"). Track
A's original `gemini.js` had drifted to plain `gemini-3.5-flash`
independently of that — corrected here, not just switched for cost.

## What's real vs. what's new here

Ported directly from Track A, with two real fixes applied:
- `gemini_client.py` — same model, endpoint, retry logic as `gemini.js`
- `pipeline.py`'s structural pass — same rules as `pipeline.js`'s
  `STRUCTURAL_SYSTEM_PROMPT`, **fixed** to not depend on an `intent` field
  the fine-tuned audit model never produces, and **moved from Groq to
  Gemini** (Track A's code still called Groq for this; the final
  architecture settled on Gemini-only for every non-audit step)

**Chain-of-thought, few-shot, and self-critique now use the real, tested
Track B prompts** (`cot_enhance_prompt_v1.md`, `fewshot_enhance_prompt_v3_
gemini.md`, `self_critique_prompt_v3_gemini.md`) — not the first-attempt
versions this backend originally shipped with, which were an honest guess
at intended behavior with no validation behind them. These went through
real v1→v2→v3 correction cycles during harness development (documented in
each file's own changelog) and are meaningfully better as a result: the
critique prompt's checklist is far more structured, and both it and the
few-shot prompt encode real, previously-discovered Gemini-specific
regressions (the chain_of_thought redundancy carve-out being
misjudged as a failure; grounding_permission being "fixed" with backwards
hedging language; few-shot substituting a request for the user's own
business context instead of actual examples).

Swapping them in surfaced three integration issues from the architecture
changes since they were tested, all fixed in `pipeline.py`:
1. **`chain_of_thought_pass` needs `complexity` as well as `task_domain`**
   (the validated prompt requires both — the first-attempt version this
   replaced only passed one).
2. **Field naming**: the validated CoT/few-shot prompts return
   `recap_addition`, not `recap` — kept exactly as validated rather than
   forced into a uniform name, so the prompt text (which explicitly
   specifies that field name) stays byte-identical to what was tested.
3. **Self-critique's checklist has a genuine mixed type** — each technique's
   value is the JSON boolean `true`/`false` *or* the string `"not_flagged"`,
   three states across two JSON types, which Gemini's strict `responseSchema`
   can't represent with one fixed type. Since this prompt was originally
   validated via manual/spreadsheet JSON output rather than schema
   enforcement anyway, `gemini_client.py` gained a second call variant,
   `call_gemini_json_freeform` (JSON mode, no schema), used only for this
   call — reproducing the conditions it was actually tested under instead of
   forcing a schema compromise that would've been a real behavior change.
4. **Self-critique's `revised_prompt` is `null` when the check passes** —
   `run_pipeline` only overwrites the running prompt when a real correction
   is present; naively assigning it unconditionally would wipe the prompt
   to nothing on every passing check. Caught and fixed via a dedicated test
   before shipping (see the smoke-test transcript in this backend's build
   history), not left to be discovered at request time.
5. **Self-critique's `issue_summary` is internal-only** — its own header
   says so explicitly ("for logging, this is never shown to the user").
   It's returned in the API response (`critique_issue_summary`,
   `critique_checklist`) for your own debugging, but deliberately kept out
   of `recap`, which is the user-facing summary structural/CoT/few-shot
   contribute to.

**The one enhance-pass prompt NOT yet swapped in**: structural. No
validated Track B version was provided in this pass — the version in use is
still Track A's `pipeline.js` prompt (with the intent-field and
Groq-to-Gemini fixes above). If you have a tested `structural_enhance_
prompt` file the way you had these three, send it over and I'll do the same
swap for it.

## Three ways to run it

### Option A — with the real trained adapter (needs a local CUDA GPU)

```bash
pip install -r requirements.txt

# Unzip the adapter you already downloaded from training:
unzip trackb_audit_adapter_v1.zip -d trackb_audit_adapter_v1

export BACKEND_API_KEY=some-key-you-make-up
export ADAPTER_DIR=./trackb_audit_adapter_v1
uvicorn main:app --reload
```

Note this loads the **current** adapter — the one that scored 46.4% on the
temp-val split, not a finished model. That's fine for testing the pipeline
plumbing; expect audit output quality to match what you already saw from
that run.

### Option B — mock audit, no GPU needed (test everything else)

```bash
pip install -r requirements.txt   # torch/transformers/peft/bitsandbytes not
                                   # actually used in this mode, but the
                                   # import in audit_model.py is lazy so this
                                   # still works without a GPU present

export BACKEND_API_KEY=some-key-you-make-up
export MOCK_AUDIT=1
uvicorn main:app --reload
```

`MOCK_AUDIT=1` skips loading the real model entirely and returns a fixed,
deliberately-mixed fake audit result (every technique flag true at least
once) so every conditional branch in the pipeline — chain-of-thought,
few-shot, critique, revise — actually gets exercised on every call. Use
this to validate the Gemini-side orchestration, the API layer, and the
extension's integration against this backend, independent of model quality.

### Option C — audit via Gemini, no model/GPU at all (the real interim mode)

```bash
pip install -r requirements-hf.txt   # lightweight — no torch/transformers/peft

export BACKEND_API_KEY=some-key-you-make-up
export AUDIT_VIA_GEMINI=1
uvicorn main:app --reload
```

Audit runs as a real, schema-constrained Gemini call against
`audit_step_v9_MODEL_FACING.md` — see `audit_gemini.py`. **This is not a
placeholder** — that rulebook was a validated Gemini prompt before
fine-tuning entered the picture at all (the v7→v8→v9 harness work), so
this reuses an already-proven configuration rather than inventing a new
stopgap. This is the mode the Hugging Face Spaces deployment below runs.

## Deploying to Hugging Face Spaces (Option C, hosted)

1. Go to **huggingface.co** → sign in → **New Space**.
2. **SDK: Docker**. Name it whatever you like (this affects your Space's
   URL). No credit card required for the free CPU tier.
3. Upload these files to the Space's repo (via the web UI, or `git push` if
   you're comfortable with that — Spaces are git repos):
   - `Dockerfile`
   - `requirements-hf.txt`
   - `main.py`, `pipeline.py`, `audit_model.py`, `audit_gemini.py`,
     `gemini_client.py`
   - `audit_step_v9_MODEL_FACING.md`
   - Rename `README_HF_SPACE.md` to `README.md` when uploading (Spaces
     read the YAML frontmatter in `README.md` specifically for SDK config
     — don't upload both this repo's general `README.md` and the Space one
     under the same name, use the HF one for the Space).
4. In the Space's **Settings → Variables and secrets**, add
   `BACKEND_API_KEY` as a **secret** (not a plain variable — it's sensitive,
   and Space repos can be public). `AUDIT_VIA_GEMINI=1` is already baked
   into the Dockerfile as a non-secret `ENV`, no need to set it again here.
5. The Space builds automatically on upload — watch the **Logs** tab. Once
   it shows the app running, your backend is live at
   `https://<your-username>-<space-name>.hf.space`.
6. Test exactly like local testing, just against that URL instead of
   `localhost:8000`:
   ```bash
   curl -X POST https://<your-space-url>/enhance \
     -H "Content-Type: application/json" \
     -H "X-API-Key: <your BACKEND_API_KEY>" \
     -d '{"draft_prompt": "explain how compound interest works", "gemini_api_key": "<your Gemini key>"}'
   ```
7. Update the extension's Settings page: change **Backend URL** from
   `http://localhost:8000` to your Space's URL. Everything else in the
   extension stays the same — it doesn't know or care which audit mode the
   backend is running.

**Free-tier caveat, not hidden**: Spaces on the free CPU tier sleep after a
period of inactivity and cold-start on the next request (same tradeoff as
most free hosts) — expect the first request after a quiet period to be
noticeably slower than subsequent ones.

**Verification note**: Docker itself isn't available in the environment
that built this, so the Dockerfile couldn't be build-tested directly. It
was verified as closely as possible without Docker: a clean virtualenv
with *only* `requirements-hf.txt` installed (confirmed no torch/
transformers/peft leaking in), containing only the exact files the
Dockerfile's `COPY` steps specify, running the exact `CMD` — which started
cleanly and served `/health` correctly. A real Space build could still
surface something this couldn't catch (a Spaces-specific quirk, a base
image difference) — if the build fails, paste the Space's build log here
and I'll fix it.

## Testing it

```bash
curl -X POST http://localhost:8000/enhance \
  -H "Content-Type: application/json" \
  -H "X-API-Key: some-key-you-make-up" \
  -d '{
    "draft_prompt": "explain how compound interest works",
    "gemini_api_key": "YOUR_GEMINI_KEY_HERE"
  }'
```

You'll need your own real Gemini API key for this — the backend calls
Gemini on your behalf using whatever key you pass in the request body,
exactly matching the self-hosted-kit distribution model (each installer's
own key, their own bill, no shared secret).

`/health` is a plain unauthenticated liveness check, no key needed.

## What's NOT done yet

- **Modal deployment** (`modal_app.py`) is written but untested — deferred
  since Modal needs a payment method on file even for the free tier, and
  that isn't set up yet. It reuses `pipeline.py` and `main.py` completely
  unmodified, only swapping how the audit function is invoked (remote GPU
  call instead of in-process), so once Modal access exists this shouldn't
  need pipeline logic changes, just deployment testing.
- **The extension** (separate delivery, not in this folder) has already
  been updated to call this backend instead of Gemini/Groq directly — its
  Settings page needs the Hugging Face Spaces URL once deployed (Option C
  above), replacing whatever it's currently pointed at.
- **The structural pass is still Track A's, not a validated Track B
  version** — see the note above. Everything else in the enhance/critique
  chain now uses real, tested prompts.
- **HF Spaces deployment is untested in the sense that matters most**: the
  build was verified as closely as possible without Docker (see the
  deployment section above), but hasn't actually run on Spaces' real
  infrastructure yet. Treat the first real deploy as the actual test.
