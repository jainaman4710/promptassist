# PromptAssist backend — Hugging Face Spaces deployment.
#
# Runs AUDIT_VIA_GEMINI mode (see main.py's docstring) — no fine-tuned model,
# no GPU, no torch/transformers/peft. This is intentional, not a limitation
# of this Dockerfile: while the fine-tuned model isn't hosted anywhere,
# audit runs as a real Gemini call against the validated
# audit_step_v9_MODEL_FACING.md rulebook instead. Swapping to the real model
# later means changing which environment variables are set (or, for a
# Modal-hosted model, redeploying via modal_app.py instead of this
# Dockerfile) — main.py and pipeline.py don't change either way.
#
# audit_model.py IS still copied into the image even though its heavy
# dependencies (torch, transformers, peft, bitsandbytes) are deliberately
# NOT installed here — its imports are lazy (only pulled in inside
# load()/run_audit(), not at module level), and main.py imports the module
# unconditionally regardless of which audit mode is active. Safe as long as
# AUDIT_VIA_GEMINI=1 stays set, since that mode never calls into the code
# paths that need those heavy libraries.

FROM python:3.11-slim

WORKDIR /app

COPY requirements-hf.txt .
RUN pip install --no-cache-dir -r requirements-hf.txt

COPY main.py pipeline.py audit_model.py audit_gemini.py gemini_client.py ./
COPY audit_step_v9_MODEL_FACING.md ./

# Not secret, safe to bake in directly — BACKEND_API_KEY (which IS secret) is
# set separately via the Space's Settings -> Variables and secrets, never
# baked into the image or committed to the repo.
ENV AUDIT_VIA_GEMINI=1

# Hugging Face Spaces' Docker SDK expects the app on port 7860 specifically.
EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
