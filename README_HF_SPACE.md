---
title: PromptAssist Backend
emoji: 🧩
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# PromptAssist Backend

FastAPI backend for the PromptAssist Chrome extension's audit-enhance-
critique pipeline. Running in `AUDIT_VIA_GEMINI` mode — audit runs as a
real Gemini call against the validated `audit_step_v9_MODEL_FACING.md`
rulebook, an interim setup while the fine-tuned model isn't hosted
anywhere yet (see `main.py`'s docstring for the full mode explanation).

Not a public service — this Space exists to give the extension a stable
HTTPS URL to call. Requires the `X-API-Key` header (set via this Space's
own `BACKEND_API_KEY` secret) on every request to `/enhance`; `/health` is
open.

See the main project's `README.md` for local development and testing
instructions — this file only covers what's specific to the HF Spaces
deployment itself.
