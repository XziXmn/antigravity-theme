/**
 * core/flow/recover.mjs — Bounded Truncation Continuation & Optional Lightweight Judge
 *
 * Host-neutral recovery engine adapted from nsfw-flow:
 *   - Classifies primary response via Outcome contract + dual-scene refusal/truncation detector
 *   - Optionally delegates ambiguous endings (tail 1200 chars) to a fast classifier model
 *   - Continues truncated text up to maxContinuations and seamlessly stitches segments
 */
import { Outcome, classifyFinishReason, classifyError } from './contract.mjs';
import { isRefusalText, isPolicyBlockText, looksAbnormalStop } from './detect.mjs';

const TAIL_LENGTH = 1200;

export const judgeVerdicts = Object.freeze({
  complete: 'complete',
  truncated: 'truncated',
  refused: 'refused'
});

function buildJudgePrompt(tail) {
  return [
    'You are a stream-output classifier. Below is the tail of a generated text.',
    'Classify ONLY the form of the ending; ignore the topic and content.',
    'Reply with exactly one word:',
    '- "complete" — the text ends at a natural sentence or scene boundary',
    '- "truncated" — the text stops mid-sentence or mid-scene, as if cut off',
    '- "refused" — the text is an apology or a policy refusal instead of the requested content',
    '',
    'Tail:',
    '<<<',
    tail,
    '>>>'
  ].join('\n');
}

function parseVerdict(reply) {
  const cleaned = String(reply ?? '')
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`.,!?\s]+$/g, '');
  if (Object.hasOwn(judgeVerdicts, cleaned)) return judgeVerdicts[cleaned];
  const m = cleaned.match(/\b(complete|truncated|refused)\b/);
  if (m && Object.hasOwn(judgeVerdicts, m[1])) return judgeVerdicts[m[1]];
  throw new TypeError('Invalid judge verdict: expected complete, truncated, or refused');
}

export function createJudge({ call, tailLength = TAIL_LENGTH } = {}) {
  if (typeof call !== 'function') {
    throw new TypeError('createJudge requires an injected call(prompt) => string');
  }
  if (!Number.isSafeInteger(tailLength) || tailLength <= 0) {
    throw new RangeError('tailLength must be a positive safe integer');
  }
  return async function judge({ text } = {}) {
    const tail = String(text ?? '').slice(-tailLength);
    const reply = await call(buildJudgePrompt(tail));
    return parseVerdict(reply);
  };
}

const TERMINAL_OUTCOMES = new Set([
  Outcome.QUOTA_EXCEEDED,
  Outcome.CONTEXT_OVERFLOW,
  Outcome.FILTER_TRIGGERED,
  Outcome.REFUSED
]);

export function createRecoverer({
  transport,
  judge = null,
  continuationFrame = '',
  maxContinuations = 3,
  scene = 'writing'
} = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('createRecoverer requires an injected transport({ messages, accumulatedText }) => { text, finishReason }');
  }
  if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 0) {
    throw new RangeError('maxContinuations must be a non-negative safe integer');
  }
  if (judge !== null && typeof judge !== 'function') {
    throw new TypeError('judge must be a function or null');
  }

  async function assess(response, actions) {
    const outcome = classifyFinishReason(response.finishReason);
    if (TERMINAL_OUTCOMES.has(outcome)) return outcome;
    if (!String(response.text || '').trim()) return Outcome.ABNORMAL;
    if (response.finishReason === undefined || response.finishReason === '') {
      return Outcome.ABNORMAL;
    }
    const refusal = isRefusalText(response.text, { scene }) || isPolicyBlockText(response.text);
    if (outcome === Outcome.LENGTH_CAPPED && !refusal) return outcome;
    if (!refusal && !looksAbnormalStop(response.text)) return Outcome.OK;
    if (judge === null) return refusal ? Outcome.REFUSED : Outcome.LENGTH_CAPPED;
    const verdict = await judge(response);
    if (!['complete', 'truncated', 'refused'].includes(verdict)) {
      throw new TypeError('Invalid judge verdict');
    }
    actions.push({ type: 'judge', verdict });
    if (verdict === 'refused') return Outcome.REFUSED;
    if (outcome === Outcome.LENGTH_CAPPED) return outcome;
    return verdict === 'complete' ? Outcome.OK : Outcome.LENGTH_CAPPED;
  }

  return async function recover(request, response) {
    if (!Array.isArray(request?.messages) || typeof response?.text !== 'string') {
      throw new TypeError('recover requires request.messages and response.text');
    }
    const actions = [];
    let current = response;
    let text = response.text;
    let outcome = Outcome.ABNORMAL;
    let error;
    let pendingText = '';
    try {
      request.signal?.throwIfAborted();
      outcome = await assess(current, actions);
      for (let index = 0; outcome === Outcome.LENGTH_CAPPED && index < maxContinuations; index += 1) {
        request.signal?.throwIfAborted();
        const messages = [...request.messages, { role: 'assistant', content: text }];
        if (continuationFrame) messages.push({ role: 'user', content: continuationFrame });
        current = await transport({ ...request, messages, accumulatedText: text, continuationIndex: index + 1 });
        if (typeof current?.text !== 'string') throw new TypeError('transport must return text');
        pendingText = current.text;
        actions.push({ type: 'continue', index: index + 1, chars: current.text.length });
        request.signal?.throwIfAborted();
        outcome = await assess(current, actions);
        if (
          outcome !== Outcome.REFUSED &&
          !(outcome === Outcome.FILTER_TRIGGERED && isRefusalText(current.text, { scene })) &&
          current.text.trim()
        ) {
          text += current.text;
        }
        pendingText = '';
      }
    } catch (failure) {
      error = failure;
      outcome = classifyError(failure) ?? Outcome.ABNORMAL;
      if (pendingText.trim() && !isRefusalText(pendingText, { scene })) text += pendingText;
      actions.push({ type: 'recovery-error', outcome });
    }
    return {
      text,
      finishReason: current.finishReason,
      outcome,
      actions,
      ...(error ? { error } : {})
    };
  };
}
