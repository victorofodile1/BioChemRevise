// POST /api/tutor  { slug, topicKey, question, level }  -> text/event-stream
import Anthropic from '@anthropic-ai/sdk';
import { loadTopic } from './_content.js';
import { rateLimit, tooBig } from './_ratelimit.js';

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const LEVELS = {
  1: 'Answer at the level of a strong A-level student. Use correct technical terms and the exact wording an AQA mark scheme would credit.',
  2: 'Answer at the level of a student who is finding this hard. Introduce each technical term with a plain-English gloss the first time you use it.',
  3: 'Answer using everyday language and a concrete analogy. Use at most two technical terms, and define both. Assume no biology background.'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { slug, topicKey, question, level = 1 } = req.body || {};
  if (tooBig(req.body))        return res.status(413).json({ error: 'Too long' });
  if (!(await rateLimit(req))) return res.status(429).json({ error: 'Slow down a moment.' });

  const topic = loadTopic(slug, topicKey);
  if (!topic) return res.status(400).json({ error: 'Unknown topic' });

  const system = `You are a tutor for AQA A-level Biology, helping with spec point ${topic.num} ${topic.title}, specifically "${topic.label}".

Everything you say must come from the NOTES below. They are written to match what AQA mark schemes credit.
- If the notes cover the question, answer from them, using their terminology exactly.
- If the question is about this spec point but the notes don't cover it, answer briefly from general A-level knowledge and say "that's beyond what's on this page".
- If the question is off-topic, say so in one line and point them back to the contents page. Do not answer it.
- Never invent a mark-scheme rule, a required word, or an examiner preference that isn't in the notes.
- Be concise. Three short paragraphs maximum. No preamble, no "great question".

${LEVELS[level] || LEVELS[1]}

<notes>
${topic.sectionText}
</notes>

<terms_the_markscheme_credits>
${topic.keywords.join(', ')}
</terms_the_markscheme_credits>`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: 700,
      system,
      messages: [{
        role: 'user',
        content: String(question || `Explain ${topic.label}.`).slice(0, 2000)
      }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ t: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('tutor error', err);
    res.write(`data: ${JSON.stringify({ error: 'Tutor unavailable' })}\n\n`);
    res.end();
  }
}
