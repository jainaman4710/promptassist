"""
Thin wrapper around the Gemini API for schema-constrained JSON calls. Ported
directly from Track A's gemini.js — same model pin, same endpoint, same retry
behavior, same header-based key auth (not a ?key= query param, to keep the
key out of logs/history) — so this backend's behavior matches the client-side
version already validated, rather than reimplementing it differently.

Model pinned to gemini-3.5-flash, matching gemini.js's own pin — verified
current, stable (GA), and billing-not-required as of this file's writing.
Re-check https://ai.google.dev/gemini-api/docs/models if this starts 404ing;
Gemini retires free-tier models on comparatively short notice.
"""
import json
import time

import requests

GEMINI_MODEL = "gemini-3.5-flash-lite"  # matches what self_critique/fewshot/cot were actually
# validated against per promptassist_final_pipeline.md ("Gemini flash-lite cascade") — Track A's
# original gemini.js had drifted to plain gemini-3.5-flash independently of that, this corrects it.
GEMINI_ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"


def _fetch_with_retry(url: str, headers: dict, body: dict, max_retries: int = 3) -> requests.Response:
    """Exponential backoff on 429, matching shared.js's fetchWithRetry exactly."""
    attempt = 0
    while True:
        res = requests.post(url, headers=headers, json=body, timeout=60)
        if res.status_code != 429 or attempt >= max_retries:
            if not res.ok and res.status_code != 429:
                raise RuntimeError(f"Request failed ({res.status_code}): {res.text[:200]}")
            return res
        delay = 0.5 * (2 ** attempt)
        time.sleep(delay)
        attempt += 1


def _extract_text_or_raise(data: dict) -> str:
    """Pulls the text out of a Gemini response, or raises an error that
    actually says WHY it's missing, instead of a generic message. A 200 OK
    with no usable content usually means one of:
      - the prompt was blocked before generation even started
        (promptFeedback.blockReason — safety, or a few other categories)
      - a candidate was produced but cut short before any content
        (candidates[0].finishReason — e.g. SAFETY, RECITATION, MAX_TOKENS —
        note content can be entirely absent in some of these cases, not
        just short)
      - something else entirely, in which case the raw response is printed
        so it's actually diagnosable rather than guessed at.
    """
    prompt_feedback = data.get("promptFeedback")
    if prompt_feedback and prompt_feedback.get("blockReason"):
        raise RuntimeError(
            f"Gemini blocked the prompt before generating anything "
            f"(blockReason={prompt_feedback['blockReason']!r}). "
            f"Full promptFeedback: {prompt_feedback}"
        )

    candidates = data.get("candidates")
    if not candidates:
        raise RuntimeError(f"Gemini returned zero candidates. Full response: {json.dumps(data)[:500]}")

    candidate = candidates[0]
    finish_reason = candidate.get("finishReason")
    if "content" not in candidate:
        raise RuntimeError(
            f"Gemini's candidate had no content at all "
            f"(finishReason={finish_reason!r}). This usually means a safety "
            f"or recitation block on the OUTPUT, not the input — full "
            f"candidate: {candidate}"
        )

    try:
        return candidate["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(
            f"Gemini's candidate had content but no usable text part "
            f"(finishReason={finish_reason!r}). Full candidate: {candidate}"
        )


def call_gemini_json_freeform(api_key: str, system_instruction: str, user_content: str) -> dict:
    """Same as call_gemini_json, but WITHOUT a responseSchema — JSON mode only
    (responseMimeType: application/json, no schema constraint).

    Needed specifically for the validated self-critique prompt
    (self_critique_prompt_v3_gemini.md), whose checklist fields are
    genuinely mixed-type per its own spec (each technique's value is the
    JSON boolean true/false OR the string "not_flagged" — three possible
    values, two different JSON types). Gemini's schema system requires one
    fixed type per field, so forcing this into a strict schema would mean
    either dropping the three-state distinction or stringifying the
    booleans — a real behavior change from what was actually tested, not a
    cosmetic one. This prompt was originally tested via manual/spreadsheet
    JSON output anyway (not through strict schema enforcement), so freeform
    mode reproduces the conditions it was validated under, rather than
    introducing a new constraint it was never checked against.

    The prompt itself fully specifies the required JSON shape in its own
    text, which is why this is safe to use without a schema — the schema
    isn't doing the enforcement work here, the prompt is.
    """
    body = {
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": user_content}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2,
        },
    }
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }

    res = _fetch_with_retry(GEMINI_ENDPOINT, headers, body)
    data = res.json()
    text = _extract_text_or_raise(data)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"Gemini response was not valid JSON: {text[:200]!r}")


def call_gemini_json(api_key: str, system_instruction: str, user_content: str, response_schema: dict) -> dict:
    """Calls Gemini with a system instruction + user content, constrained to a
    JSON schema (Gemini's OpenAPI-subset schema object, same shape as the
    AUDIT_SCHEMA / CRITIQUE_SCHEMA constants Track A defines in pipeline.js)."""
    body = {
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": user_content}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
            "temperature": 0.2,
        },
    }
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }

    res = _fetch_with_retry(GEMINI_ENDPOINT, headers, body)
    data = res.json()
    text = _extract_text_or_raise(data)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"Gemini response was not valid JSON: {text[:200]!r}")
