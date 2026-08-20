// POST /api/feynman  { slug, topicKey, explanation }
// Judges an explain-it-to-a-beginner attempt. NOTE: this is deliberately NOT
// the blurt prompt — coverage is not what's being marked, comprehensibility is.
import Anthropic from '@anthropic-ai/sdk';
import { loadTopic } from './_content.js';
import { rateLimit, tooBig } from './_ratelimit.js';

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const MAX_CHARS = 6000;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

const JUDGE_TOOL = {
  name: 'record_judgement',
  description: 'Record the judgement of a Feynman-technique explanation.',
  input_schema: {
    type: 'object',
    required: ['understanding', 'chain', 'jargon_unexplained', 'gaps', 'next_step'],
    properties: {
      understanding: { type: 'string', enum: ['solid', 'partial', 'surface'] },
      chain: {
        type: 'array',
        description:
          'One entry for EVERY step in the numbered chain given in the system prompt, in that ' +
          'same order — including steps the student never mentioned. Do not add, merge or drop steps.',
        items: {
          type: 'object',
          required: ['step', 'present'],
          properties: {
            step:    { type: 'string', description: 'The step, copied verbatim from the numbered chain.' },
            present: { type: 'boolean', description: 'Did the explanation actually convey this step to a beginner?' },
            note:    { type: 'string', description: 'One sentence, only if the step is absent or garbled.' }
          }
        }
      },
      jargon_unexplained: {
        type: 'array',
        description: 'Technical terms used without being explained. A beginner would be lost at each.',
        items: {
          type: 'object',
          required: ['term', 'beginner_would_ask'],
          properties: {
            term:               { type: 'string' },
            beginner_would_ask: { type: 'string' }
          }
        }
      },
      analogy_check: {
        type: 'object',
        required: ['used'],
        properties: {
          used:       { type: 'boolean' },
          quote:      { type: 'string', description: 'Verbatim from the explanation. Omit if no analogy was used.' },
          misleading: { type: 'boolean' },
          why:        { type: 'string' }
        }
      },
      gaps: {
        type: 'array',
        description: 'Vague phrases the student is hiding behind. Quote them EXACTLY, word for word.',
        items: {
          type: 'object',
          required: ['quote', 'what_is_missing'],
          properties: {
            quote:           { type: 'string', description: 'Verbatim substring of the explanation. Never paraphrase.' },
            what_is_missing: { type: 'string' }
          }
        }
      },
      next_step: { type: 'string', description: 'One concrete thing to do before explaining it again.' }
    }
  }
};

/** Whitespace/case-insensitive haystack match, so transcript spacing doesn't fail a real quote. */
const norm = (s) => String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

function buildSystem(topic, chain) {
  const chainBlock = chain.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `You are judging a student's attempt at the Feynman technique on AQA A-level Biology spec point ${topic.num}, "${topic.label}". They were asked to explain it out loud as if teaching a complete beginner.

Judge ONE thing: would a beginner who heard only this come away with a correct mental model?
- Technical terms used WITHOUT explanation are a fault, not a strength. "It's chemiosmosis" explains nothing to a beginner.
- Reward correct causal chains ("because… which means… so…"), good analogies, and correct sequencing.
- Penalise circular explanation ("photolysis is when photolysis happens"), missing causal steps, and any analogy that would leave the beginner with a wrong idea.
- Vagueness the student is hiding behind is the most useful thing you can find. Quote the exact phrase and say what a beginner would still be asking.
- Do not reward length. A short, correct, well-sequenced explanation beats a long one.

This is the causal chain to mark against. It is fixed. Do not substitute your own:
${chainBlock}

Return one \`chain\` entry per numbered step above, in the same order, copying the step text verbatim. Mark \`present: false\` for any step the student never got across — a step you did not see is the single most useful thing to report. A step named but not explained ("then the electron transport chain happens") is NOT present.

Grade \`understanding\`:
- "solid" — every step present and causally linked, a beginner could re-tell it.
- "partial" — the shape is right but one or more steps are missing, out of order, or asserted rather than explained.
- "surface" — correct-sounding vocabulary with the mechanism absent, or the causal direction wrong.

Every string in \`gaps[].quote\` and \`analogy_check.quote\` must be copied character-for-character from the explanation. If you cannot quote it exactly, leave that entry out entirely.

The input may be a speech-to-text transcript: ignore missing punctuation, filler words and false starts. Judge the ideas, not the delivery.

<notes>
${topic.sectionText}
</notes>`;
}

/** Drop hallucinated quotes; realign the chain to the canonical steps. */
function sanitise(out, explanation, chain) {
  const hay = norm(explanation);
  const quoted = (q) => typeof q === 'string' && q.trim() && hay.includes(norm(q));

  const gaps = Array.isArray(out.gaps) ? out.gaps.filter((g) => g && quoted(g.quote) && g.what_is_missing) : [];

  let analogy = out.analogy_check && typeof out.analogy_check === 'object' ? { ...out.analogy_check } : { used: false };
  if (analogy.quote && !quoted(analogy.quote)) delete analogy.quote;
  if (!analogy.quote) analogy.used = analogy.used === true && false; // no verifiable analogy => treat as none
  if (analogy.used !== true) analogy = { used: false };

  // Canonical chain wins: keep the model's verdicts, discard any invented step text.
  const byIndex = Array.isArray(out.chain) ? out.chain : [];
  const marked = chain.map((step, i) => {
    const m =
      byIndex[i] && norm(byIndex[i].step) === norm(step)
        ? byIndex[i]
        : byIndex.find((c) => c && norm(c.step) === norm(step)) || byIndex[i];
    const present = m ? m.present === true : false;
    const entry = { step, present };
    if (!present && m && typeof m.note === 'string' && m.note.trim()) entry.note = m.note.trim();
    return entry;
  });

  const jargon = Array.isArray(out.jargon_unexplained)
    ? out.jargon_unexplained.filter((j) => j && j.term && j.beginner_would_ask)
    : [];

  const allowed = ['solid', 'partial', 'surface'];
  const understanding = allowed.includes(out.understanding) ? out.understanding : 'partial';

  return {
    understanding,
    chain: marked,
    jargon_unexplained: jargon,
    analogy_check: analogy,
    gaps,
    next_step: typeof out.next_step === 'string' && out.next_step.trim() ? out.next_step.trim() : ''
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { slug, topicKey, explanation } = req.body || {};

    if (tooBig(req.body)) return res.status(413).json({ error: 'Too long' });
    if (typeof slug !== 'string' || !ID_RE.test(slug) || typeof topicKey !== 'string' || !ID_RE.test(topicKey)) {
      return res.status(400).json({ error: 'Unknown topic' });
    }
    if (typeof explanation !== 'string' || !explanation.trim()) {
      return res.status(400).json({ error: 'Nothing to judge' });
    }
    if (!(await rateLimit(req))) return res.status(429).json({ error: 'Slow down a moment.' });

    const topic = loadTopic(slug, topicKey);
    if (!topic || !topic.sectionText) return res.status(400).json({ error: 'Unknown topic' });

    const chain = Array.isArray(topic.chain) ? topic.chain.filter((s) => typeof s === 'string' && s.trim()) : [];
    if (!chain.length) {
      console.error('feynman: no chain defined for', slug, topicKey);
      return res.status(500).json({ error: 'Feedback unavailable' });
    }

    const truncated = explanation.length > MAX_CHARS;
    const text = truncated ? explanation.slice(0, MAX_CHARS) : explanation;

    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0,
      system: buildSystem(topic, chain),
      tools: [JUDGE_TOOL],
      tool_choice: { type: 'tool', name: 'record_judgement' },
      messages: [{ role: 'user', content: `<explanation>\n${text}\n</explanation>` }]
    });

    if (msg.stop_reason === 'max_tokens') {
      console.error('feynman: judgement truncated', { slug, topicKey, steps: chain.length });
      return res.status(502).json({ error: 'Feedback unavailable' });
    }

    const block = msg.content.find((b) => b.type === 'tool_use');
    if (!block || !block.input || typeof block.input !== 'object') {
      return res.status(502).json({ error: 'No judgement returned' });
    }

    const judgement = sanitise(block.input, text, chain);
    if (truncated) judgement.truncated = true;

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(judgement);
  } catch (err) {
    console.error('feynman error', err);
    return res.status(500).json({ error: 'Feedback unavailable' });
  }
}
