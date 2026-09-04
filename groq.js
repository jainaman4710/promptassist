// Thin wrapper around Groq's OpenAI-compatible API for generation calls (structural
// pass, CoT pass, few-shot pass, revise). Model updated 2026-08-16 to openai/gpt-oss-120b
// after llama-3.3-70b-versatile was decommissioned by Groq on that date — this is
// Groq's own recommended replacement (free tier: 1,000 req/day, 8,000 TPM). Re-verify
// at https://console.groq.com/docs/models if this call starts failing.
const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Calls Groq for a JSON-structured generation response.
 * Groq's JSON mode is a "best-effort" contract (unlike Gemini's schema-enforced one),
 * so the system prompt must spell out the exact shape expected, and callers should
 * validate the parsed result rather than trust it blindly.
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} userContent
 * @returns {Promise<object>} parsed JSON
 */
async function callGroqJSON(apiKey, systemPrompt, userContent) {
  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    temperature: 0.4,
    // gpt-oss is a reasoning model. "low" effort suits a straightforward rewrite task
    // (faster, and reduces how much reasoning text there is to potentially leak).
    // include_reasoning:false is the correct param for gpt-oss specifically — it does
    // NOT support reasoning_format (that's for other reasoning models on Groq).
    reasoning_effort: "low",
    include_reasoning: false,
  };

  const res = await fetchWithRetry(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  // Documented gpt-oss quirk: the actual answer sometimes ends up in a reasoning
  // field instead of content — fall back to those if content is empty.
  let text = message?.content || message?.reasoning_content || message?.reasoning;
  if (!text) {
    throw new Error("Groq returned no content — check API key and model availability.");
  }

  // Another documented quirk: leaked internal control tokens like "<|return|>" can
  // appear in the text — strip anything matching that pattern before parsing.
  text = text.replace(/<\|[^|]*\|>/g, "").trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    // json_object mode occasionally still wraps the JSON in surrounding prose —
    // try to salvage the first {...} block before giving up entirely.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through to the error below
      }
    }
    throw new Error(`Groq response was not valid JSON: ${text.slice(0, 200)}`);
  }
}
