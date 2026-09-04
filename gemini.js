// Thin wrapper around the Gemini API. Two call variants:
//   callGeminiJSON          - constrained to a strict JSON schema (audit, structural, cot, fewshot)
//   callGeminiJSONFreeform  - JSON mode only, no schema (self-critique — see its own comment below)
//
// Model: gemini-3.5-flash-lite — matches what self_critique_prompt_v3_gemini.md,
// fewshot_enhance_prompt_v3_gemini.md, and cot_enhance_prompt_v1.md were actually
// validated against ("Gemini flash-lite cascade" in the harness). An earlier version of
// this file had drifted to plain gemini-3.5-flash independently of that — corrected here,
// not just switched for cost. Gemini retires free-tier models on short notice; re-verify
// at https://ai.google.dev/gemini-api/docs/models if either call starts 404ing.
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Pulls the text out of a Gemini response, or throws an error that actually says WHY
 * it's missing instead of a generic message. A 200 OK with no usable content usually
 * means one of: the prompt was blocked before generation started (promptFeedback.
 * blockReason), a candidate was produced but cut short before any content
 * (candidates[0].finishReason — content can be entirely absent in some of these cases,
 * not just short), or something else, in which case the raw response is surfaced so
 * it's actually diagnosable rather than guessed at.
 */
function extractTextOrThrow(data) {
  const promptFeedback = data?.promptFeedback;
  if (promptFeedback?.blockReason) {
    throw new Error(
      `Gemini blocked the prompt before generating anything (blockReason=${promptFeedback.blockReason}). ` +
      `Full promptFeedback: ${JSON.stringify(promptFeedback)}`
    );
  }

  const candidates = data?.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error(`Gemini returned zero candidates. Full response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const candidate = candidates[0];
  if (!candidate.content) {
    throw new Error(
      `Gemini's candidate had no content at all (finishReason=${candidate.finishReason}). ` +
      `This usually means a safety or recitation block on the OUTPUT, not the input — full candidate: ${JSON.stringify(candidate)}`
    );
  }

  const text = candidate.content.parts?.[0]?.text;
  if (!text) {
    throw new Error(
      `Gemini's candidate had content but no usable text part (finishReason=${candidate.finishReason}). ` +
      `Full candidate: ${JSON.stringify(candidate)}`
    );
  }
  return text;
}

/**
 * Calls Gemini with a system instruction + user content, constrained to a JSON schema.
 * @param {string} apiKey
 * @param {string} systemInstruction
 * @param {string} userContent
 * @param {object} responseSchema - Gemini's OpenAPI-subset schema object
 * @returns {Promise<object>} parsed JSON matching responseSchema
 */
async function callGeminiJSON(apiKey, systemInstruction, userContent, responseSchema) {
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.2,
    },
  };

  const res = await fetchWithRetry(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey, // header, not ?key= query param — keeps the key out of URLs (Network tab, history, referrers)
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const text = extractTextOrThrow(data);

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini response was not valid JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Same as callGeminiJSON, but WITHOUT a responseSchema — JSON mode only.
 *
 * Needed specifically for self_critique_prompt_v3_gemini.md, whose checklist fields are
 * genuinely mixed-type per its own spec (each technique's value is the JSON boolean
 * true/false OR the string "not_flagged" — three possible values, two different JSON
 * types). Gemini's schema system requires one fixed type per field, so forcing this into
 * a strict schema would mean either dropping the three-state distinction or stringifying
 * the booleans — a real behavior change from what was actually tested, not a cosmetic
 * one. This prompt was validated via manual/spreadsheet JSON output, not strict schema
 * enforcement, so freeform mode reproduces the conditions it was actually tested under.
 * The prompt's own text fully specifies the required JSON shape, which is why this is
 * safe without a schema — the schema was never doing the real enforcement work here.
 */
async function callGeminiJSONFreeform(apiKey, systemInstruction, userContent) {
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  const res = await fetchWithRetry(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const text = extractTextOrThrow(data);

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini response was not valid JSON: ${text.slice(0, 200)}`);
  }
}
