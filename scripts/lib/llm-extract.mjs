/**
 * Fallback job-call extraction for locals whose page doesn't match any of
 * scrape-job-calls.mjs's FORMATS regexes — i.e. the adaptable part of the
 * scraper. Where a hand-written matcher only ever covers one phrasing, this
 * asks Gemini to read the page's plain text and return the same shape
 * (`{count, classification, text}` per listing) that a regex matcher would,
 * so it slots into the existing new/edited/filled diff and Discord pipeline
 * with no other code changes.
 *
 * Uses Gemini 3.5 Flash-Lite — free on Google AI Studio's free tier (1,500
 * requests/day, no credit card) as of this writing, and the cheapest paid
 * fallback if that quota is ever exceeded. Needs GEMINI_API_KEY (or
 * GOOGLE_API_KEY) in the environment — get one free at
 * https://aistudio.google.com/apikey. Callers should treat a missing key as
 * "skip the LLM fallback", not a hard failure; see scrape-job-calls.mjs.
 */
import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-3.5-flash-lite';
// A job-calls page's actual listings are almost always near the top of the
// content region; capping here keeps token spend (and free-tier quota use)
// bounded even when the page has no UnionActive-style region marker to
// narrow it first.
const MAX_TEXT_CHARS = 15000;

const CALL_SCHEMA = {
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          classification: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['count', 'classification', 'text'],
      },
    },
  },
  required: ['calls'],
};

const SYSTEM = `You read the plain text of an IBEW local union's "job calls" / dispatch / referral webpage and extract every currently-open job listing on it.

Rules:
- Only extract listings that are actually open right now. Ignore navigation, contact info, membership/dues text, rules or policy explanations, and anything marked filled, cancelled, or past.
- "count" is how many openings that one listing has. If the page doesn't give a number for a listing, use 1.
- "classification" is the trade classification/job title as written on the page (e.g. "Journeyman Wireman", "CW/CE", "Foreman", "Technician", "Journeyman Lineman"). Keep the page's own wording — don't invent a category it doesn't use.
- "text" should read like the original listing: reuse the page's own wording and details (contractor, pay, hours, location, requirements) instead of summarizing them away. No added commentary, headers, or numbering of your own.
- If the page clearly states there are no open calls right now, or the listings area is empty, return an empty "calls" array — that's a correct answer, not a failure.
- If you can't tell whether something is a real listing, leave it out rather than guessing.`;

let client = null;
function getClient() {
  // Reads GEMINI_API_KEY (GOOGLE_API_KEY also works) from the environment —
  // construct lazily so a missing key only breaks callers that actually use it.
  if (!client) client = new GoogleGenAI({});
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The SDK's real diagnostic text lives in e.body (a JSON string), not
// e.message (a generic "API error occurred" wrapper) — an invalid key comes
// back as HTTP 400/INVALID_ARGUMENT, not 401/403, so check both fields' text.
const errText = (e) => {
  let body = '';
  try { body = typeof e?.body === 'string' ? e.body : JSON.stringify(e?.body || ''); } catch { /* ignore */ }
  return `${e?.message || ''} ${body}`;
};
const isRateLimited = (e) => e?.status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(errText(e));
const isAuthError = (e) =>
  e?.status === 401 || e?.status === 403 ||
  /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(errText(e));

/**
 * @param {string} pageText - plain text of the job-calls page (HTML already stripped).
 * @returns {Promise<{calls: Array<{count:number, classification:string, text:string}>}>}
 */
export async function extractCallsWithLLM(pageText) {
  const text = pageText.length > MAX_TEXT_CHARS ? pageText.slice(0, MAX_TEXT_CHARS) : pageText;
  if (!text.trim()) return { calls: [] };

  let interaction;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      interaction = await getClient().interactions.create({
        model: MODEL,
        input: text,
        system_instruction: SYSTEM,
        response_format: { type: 'text', mime_type: 'application/json', schema: CALL_SCHEMA },
      });
      break;
    } catch (e) {
      if (isAuthError(e)) throw new Error('GEMINI_API_KEY missing or invalid');
      if (isRateLimited(e) && attempt < 2) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(interaction.output_text);
  } catch {
    return { calls: [] }; // schema-constrained output should always parse, but never throw on a fluke
  }

  const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  return {
    calls: calls
      .filter((c) => c && typeof c.text === 'string' && c.text.trim())
      .map((c) => ({
        count: Number.isFinite(c.count) && c.count > 0 ? Math.round(c.count) : 1,
        classification: String(c.classification || 'Journeyman Wireman').trim(),
        text: c.text.trim(),
      })),
  };
}
