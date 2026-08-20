// POST /api/feynman  { slug, topicKey, explanation }
// Judges an explain-it-to-a-beginner attempt. NOTE: this is deliberately NOT
// the blurt prompt — coverage is not what's being marked, comprehensibility is.
import Anthropic from '@anthropic-ai/sdk';
import { loadTopic } from './_content.js';
import { rateLimit, tooBig } from './_ratelimit.js';

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

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
        description: 'The causal chain the notes require, in order. One entry per step.',
        items: {
          type: 'object',
          required: ['step', 'present'],
          properties: {
            step:    { type: 'string' },
            present: { type: 'boolean' },
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
        properties: {
          used:       { type: 'boolean' },
          quote:      { type: 'string' },
          misleading: { type: 'boolean' },
          why:        { type: 'string' }
        }
      },
      gaps: {
        type: 'array',
        description: 'Vague phrases the student is hiding behind. Quote them exactly.',
        items: {
          type: 'object',
          required: ['quote', 'what_is_missing'],
          properties: { quote: { type: 'string' }, what_is_missing: { type: 'string' } }
        }
      },
      next_step: { type: 'string', description: 'One concrete thing to do before explaining it again.' }
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { slug, topicKey, explanation } = req.body || {};
  if (tooBig(req.body))                        return res.status(413).json({ error: 'Too long' });
  if (!explanation || !explanation.trim())     return res.status(400).json({ error: 'Nothing to judge' });
  if (!(await rateLimit(req)))                 return res.status(429).json({ error: 'Slow down a moment.' });

  const topic = loadTopic(slug, topicKey);
  if (!topic) return res.status(400).json({ error: 'Unknown topic' });

  const system = `You are judging a student's attempt at the Feynman technique on AQA A-level Biology spec point ${topic.num}, "${topic.label}". They were asked to explain it out loud as if teaching a complete beginner.

Judge ONE thing: would a beginner who heard only this come away with a correct mental model?

- Technical terms used WITHOUT explanation are a fault, not a strength. "It's chemiosmosis" explains nothing to a beginner.
- Reward correct causal chains ("because… which means… so…"), good analogies, and correct sequencing.
- Penalise circular explanation ("photolysis is when photolysis happens"), missing causal steps, and any analogy that would leave the beginner with a wrong idea.
- Vagueness the student is hiding behind is the most useful thing you can find. Quote the exact phrase and say what a beginner would still be asking.
- Do not reward length. A short, correct, well-sequenced explanation beats a long one.
- The chain you check against must come from the notes below, not from your own knowledge.

The input may be a speech-to-text transcript: ignore missing punctuation, filler words and false starts.

<notes>
${topic.sectionText}
</notes>`;

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      tools: [JUDGE_TOOL],
      tool_choice: { type: 'tool', name: 'record_judgement' },
      messages: [{ role: 'user', content: `<explanation>\n${String(explanation).slice(0, 6000)}\n</explanation>` }]
    });

    const block = msg.content.find(b => b.type === 'tool_use');
    if (!block) return res.status(502).json({ error: 'No judgement returned' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(block.input);
  } catch (err) {
    console.error('feynman error', err);
    return res.status(500).json({ error: 'Feedback unavailable' });
  }
}
