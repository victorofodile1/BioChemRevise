// POST /api/blurt  { slug, topicKey, blurt }
// Marks a free-recall attempt the way an examiner would, and returns structured JSON.
import Anthropic from '@anthropic-ai/sdk';
import { loadTopic } from './_content.js';
import { rateLimit, tooBig } from './_ratelimit.js';

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const MARKING_TOOL = {
  name: 'record_marking',
  description: 'Record the marking of a student free-recall attempt.',
  input_schema: {
    type: 'object',
    required: ['points', 'misconceptions', 'overall'],
    properties: {
      points: {
        type: 'array',
        description: "One entry per markable point in the notes, in the notes' own order.",
        items: {
          type: 'object',
          required: ['point', 'status'],
          properties: {
            point:  { type: 'string', description: 'The markable point, in mark-scheme wording.' },
            status: { type: 'string', enum: ['correct', 'partial', 'missing', 'wrong'] },
            note:   { type: 'string', description: 'For partial/wrong only: one sentence on what is off.' }
          }
        }
      },
      misconceptions: {
        type: 'array',
        description: 'Statements the student made that are biologically wrong, however fluent. Empty if none.',
        items: {
          type: 'object',
          required: ['wrote', 'why_wrong', 'correct_version'],
          properties: {
            wrote:           { type: 'string' },
            why_wrong:       { type: 'string' },
            correct_version: { type: 'string' }
          }
        }
      },
      overall: { type: 'string', description: 'Two sentences to the student. Specific, not generic encouragement.' }
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { slug, topicKey, blurt } = req.body || {};
  if (tooBig(req.body))            return res.status(413).json({ error: 'Too long' });
  if (!blurt || !blurt.trim())     return res.status(400).json({ error: 'Nothing to mark' });
  if (!(await rateLimit(req)))     return res.status(429).json({ error: 'Slow down a moment.' });

  const topic = loadTopic(slug, topicKey);
  if (!topic) return res.status(400).json({ error: 'Unknown topic' });

  const system = `You are marking a student's free-recall "blurt" on AQA A-level Biology spec point ${topic.num}, "${topic.label}".

The student wrote everything they could remember from memory, quickly, against a three-minute timer. Mark it the way an AQA examiner marks a written answer.

Rules:
- Credit the POINT, not the exact words. "Pi", "phosphate" and "inorganic phosphate" are the same point. So are "makes it more reactive" and "lowers the activation energy" if the notes list both as acceptable.
- Spelling, grammar and punctuation do not matter. This was typed against a timer.
- Mark a point "wrong" — not "correct" — when the student used the right term to say something false. A student who writes "ATP hydrolase catalyses the condensation of ADP" has NOT earned the ATP hydrolase point.
- Only list points that the notes below actually make. Do not add points from your own knowledge.
- Flag misconceptions even when the student also made the same point correctly elsewhere.
- Be exact and unsentimental. This student wants to find their gaps, not be reassured.

<notes>
${topic.sectionText}
</notes>

<terms_the_markscheme_credits>
${topic.keywords.join(', ')}
</terms_the_markscheme_credits>`;

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      tools: [MARKING_TOOL],
      tool_choice: { type: 'tool', name: 'record_marking' },
      messages: [{ role: 'user', content: `<blurt>\n${String(blurt).slice(0, 6000)}\n</blurt>` }]
    });

    const block = msg.content.find(b => b.type === 'tool_use');
    if (!block) return res.status(502).json({ error: 'No marking returned' });

    const points = block.input.points || [];
    const score = points.reduce((n, p) =>
      n + (p.status === 'correct' ? 1 : p.status === 'partial' ? 0.5 : 0), 0);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ...block.input,
      pct: points.length ? Math.round((score / points.length) * 100) : 0
    });
  } catch (err) {
    console.error('blurt error', err);
    // The frontend should fall back to the built-in keyword checker on any non-200.
    return res.status(500).json({ error: 'Marking unavailable' });
  }
}
