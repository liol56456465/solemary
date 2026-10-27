// applicationQuestions.js
//
// Application questions are stored either as plain strings (older data, minimum
// answer length 1) or as { question, minLength } objects. Everything that reads
// questions goes through normalizeApplicationQuestions so both shapes work.
// Admins set a minimum in the question editor with a trailing tag: "Why join? [min:10]".

export const DEFAULT_MIN_ANSWER_LENGTH = 1;
export const MAX_ANSWER_LENGTH = 1000;
export const MAX_QUESTION_LENGTH = 100;

const MIN_TAG = /\s*\[\s*min\s*:?\s*(\d+)\s*\]\s*$/i;

function clampMinLength(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < DEFAULT_MIN_ANSWER_LENGTH) return DEFAULT_MIN_ANSWER_LENGTH;
  return Math.min(n, MAX_ANSWER_LENGTH);
}

/** Returns { question, minLength } for a stored entry, or null if it has no text. */
export function normalizeApplicationQuestion(entry) {
  const text = typeof entry === 'string' ? entry : entry?.question;
  if (typeof text !== 'string' || !text.trim()) return null;
  return {
    question: text.trim().substring(0, MAX_QUESTION_LENGTH),
    minLength: clampMinLength(typeof entry === 'string' ? DEFAULT_MIN_ANSWER_LENGTH : entry.minLength)
  };
}

export function normalizeApplicationQuestions(entries) {
  return (Array.isArray(entries) ? entries : []).map(normalizeApplicationQuestion).filter(Boolean);
}

/** Question text of a stored entry (string or object). */
export function applicationQuestionText(entry) {
  return normalizeApplicationQuestion(entry)?.question ?? '';
}

/**
 * Turns editor input into the stored shape: a plain string when no minimum is
 * set (same as older data), otherwise { question, minLength }. Null if empty.
 */
export function parseApplicationQuestionInput(input) {
  const raw = String(input ?? '').trim();
  const match = raw.match(MIN_TAG);
  const question = (match ? raw.slice(0, match.index) : raw).trim().substring(0, MAX_QUESTION_LENGTH);
  if (!question) return null;
  const minLength = match ? clampMinLength(match[1]) : DEFAULT_MIN_ANSWER_LENGTH;
  return minLength > DEFAULT_MIN_ANSWER_LENGTH ? { question, minLength } : question;
}

/** Inverse of parseApplicationQuestionInput, for pre-filling the editor. */
export function formatApplicationQuestionForEditing(entry) {
  const normalized = normalizeApplicationQuestion(entry);
  if (!normalized) return '';
  return normalized.minLength > DEFAULT_MIN_ANSWER_LENGTH
    ? `${normalized.question} [min:${normalized.minLength}]`
    : normalized.question;
}
