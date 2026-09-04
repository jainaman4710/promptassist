/**
 * Fetch with exponential backoff retry on 429 (rate limit) responses.
 * PRD requirement: retry with exponential backoff on 429s for both providers.
 * Shared between gemini.js and groq.js — load this script before either.
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= maxRetries) {
      if (!res.ok && res.status !== 429) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Request failed (${res.status}): ${errText.slice(0, 200)}`);
      }
      return res;
    }
    const delayMs = 500 * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt += 1;
  }
}
