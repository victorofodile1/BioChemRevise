# Building the real Tutor AI, Blurt AI and Feynman AI

The three tools on every notes page are currently **demos**. They work, they're useful, and they cost
nothing to run — but they don't understand anything. This is how to turn each one into a real
model-backed tool without throwing away what's already there.

Read this in order. Steps 1–3 are shared infrastructure; step 4 onwards is one tool at a time.

---

## 0. What the demos actually do today

Every notes page has a JavaScript object called `TOPICS` near the bottom of the file. For `3.1.6 ATP`
it looks like this:

```js
const TOPICS = {
  hydrolysis: {
    label: "Hydrolysis of ATP",
    section: "s2",
    tiers: [ "…standard explanation…", "…simpler…", "…simplest…" ],
    qa: [ ["question", "answer"], … ],
    keywords: ["ATP hydrolase","water molecule","ADP","releases energy","coupled", …]
  },
  …
}
```

- **Tutor AI** prints `tiers[0]`, then `tiers[1]`, then `tiers[2]` as you press "break this down further",
  and lists the `qa` pairs underneath. It's a lookup table, not a conversation.
- **Blurt AI** lowercases what you typed and does `text.includes(keyword)` for each entry in `keywords`.
  The percentage is `hits / keywords.length`.
- **Feynman AI** does exactly the same check on a different topic.

**The limits this creates, in order of how much they matter:**

1. **Neither Blurt nor Feynman can read.** Write "ATP hydrolase breaks down glucose" and it scores a hit
   for *ATP hydrolase* — the term is present, the biology is wrong. It rewards vocabulary, not
   understanding, which is the opposite of what free recall is for.
2. **Synonyms fail.** "Inorganic phosphate" is a keyword; a student who writes "Pi" scores zero for it.
   Correct answers get marked down, which trains students to write for the checker.
3. **Tutor AI can't answer a question.** It has three fixed paragraphs. A student who is stuck on
   something the author didn't anticipate has nowhere to go.
4. **Nothing is diagnostic.** A 60% score doesn't tell you *which misconception* you have.

That's what a model fixes. Note what it must *not* break: the tools are fast, private, and free. Every
design decision below is about keeping as much of that as possible.

---

## 1. Architecture: why you need a backend at all

You cannot call the Claude API from the browser. Your API key would be in the page source, and within a
week someone's script would be running up your bill. There is no way around this — no obfuscation, no
"restricted" key, no CORS trick.

So: **the browser calls your own endpoint, and your endpoint calls Claude with the key held server-side.**

```
browser (notes page)
   │  POST /api/tutor  { slug, topicKey, question, level }
   ▼
Vercel Function (api/tutor.js)          ← ANTHROPIC_API_KEY lives here, as an env var
   │  loads content/<slug>.json, builds the prompt
   ▼
Claude API  ──stream──▶  back through the function  ──stream──▶  browser
```

The good news: **this repo is already a Vercel project, so you get this for free.** Drop a file at
`api/tutor.js` and Vercel serves it at `/api/tutor` as a serverless function. No config change, no
separate server, no CORS. The static site keeps deploying exactly as it does now.

### Set up

```bash
npm init -y
npm install @anthropic-ai/sdk
```

Add `node_modules` to `.gitignore` (already there). Commit `package.json` and `package-lock.json` —
Vercel installs from them.

Then in the Vercel dashboard → **Settings → Environment Variables**, add:

| Name | Value | Environments |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` from <https://console.anthropic.com> | Production, Preview, Development |

Locally, put it in `.env.local` (gitignored) and run `vercel dev`.

### Which model

As of now the sensible options are:

| Model | API ID | Input / Output per Mtok | Use it for |
|---|---|---|---|
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 / $5 | **Start here.** Blurt + Feynman marking, simple tutor answers |
| Claude Sonnet 5 | `claude-sonnet-5` | $2 / $10 | Tutor AI once you want proper back-and-forth |
| Claude Opus 5 | `claude-opus-5` | $5 / $25 | Only if marking quality genuinely isn't good enough |

Check <https://platform.claude.com/docs/en/about-claude/models/overview> before you build — these
change. Put the model ID in an env var (`CLAUDE_MODEL`) so you can switch it without a deploy.

---

## 2. Extract the content into a corpus

The model must be **grounded in your notes**, not asked to recall A-level Biology from training. That's
the difference between a tool that teaches AQA mark-scheme wording and one that produces plausible
biology that loses marks.

Your `TOPICS` objects are already a near-perfect corpus. Pull them out into JSON at build time:

```bash
node tools/extract-content.mjs      # writes content/<slug>.json for all 53 pages
```

The script is in `ai-upgrade/tools/extract-content.mjs` in this repo. It reads each notes page, finds
the `const TOPICS = {…}` block, evaluates it in a sandboxed VM, and writes out:

```json
{
  "slug": "3-1-6-atp",
  "num": "3.1.6",
  "title": "ATP",
  "topics": {
    "hydrolysis": { "label": "…", "tiers": [...], "qa": [...], "keywords": [...] }
  },
  "sections": { "s2": "…full plain-text of that section of the notes…" }
}
```

Note the `sections` field — that's the *prose from the page itself*, not just the tool data. Grab it.
It's the richest thing you have and the demos don't use it at all.

Run the extractor whenever you edit a notes page. It produces 53 JSON files, about 1.9 MB in total,
covering 306 sections. Two options:

- **Commit `content/`** — simplest, and your functions have zero cold-start data fetching. But note that
  Vercel will then also serve them as static files at `/content/3-1-6-atp.json`, i.e. your whole corpus
  becomes trivially scrapeable. Add a `vercel.json` rewrite blocking `/content/(.*)` if that bothers you.
- **Generate at build time into a non-served directory** — set the Vercel build command to
  `node tools/extract-content.mjs` and write the output somewhere outside the static root. Slightly more
  setup, nothing exposed.

Either way, `content/` is not committed in this repo right now — run the script to create it.

---

## 3. Protect the endpoint before you ship it

A public, unauthenticated endpoint that calls a paid API will be abused. Not maybe — it's a
question of when someone finds it. Do all four of these *before* the first deploy:

1. **Cap the input.** Reject any request body over ~4 KB. A blurt is a few hundred words; nobody needs
   more. This alone kills most abuse.
2. **Cap the output.** `max_tokens: 700` for tutor, `400` for marking. Hard ceiling on cost per call.
3. **Rate limit per IP.** Vercel gives you `req.headers['x-forwarded-for']`. Use
   [Upstash Redis](https://upstash.com) (free tier is plenty) with a sliding window — 20 requests per
   IP per 10 minutes is generous for a real student and useless for a scraper.
4. **Pin the topic.** Never let the client send the notes content. It sends `slug` + `topicKey`; the
   server looks up the text. Otherwise your endpoint is a free general-purpose Claude proxy and it
   *will* be used as one.

Also set a **monthly spend limit** in the Anthropic console. Belt and braces.

---

## 4. Tutor AI

**What it becomes:** a tutor that can answer a student's actual question about this specific spec point,
at a level they control, refusing to wander off the topic.

**Keep:** the three-level control, the topic chips, the layout. Students like the level buttons and they
map neatly onto a prompt instruction.

**Endpoint:** `POST /api/tutor`

```js
// api/tutor.js
import Anthropic from '@anthropic-ai/sdk';
import { loadTopic } from './_content.js';
import { rateLimit } from './_ratelimit.js';

const client = new Anthropic();     // reads ANTHROPIC_API_KEY from env
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const LEVELS = {
  1: 'Answer at the level of a strong A-level student. Use correct technical terms and the exact wording an AQA mark scheme would credit.',
  2: 'Answer at the level of a student who is finding this hard. Introduce each technical term with a plain-English gloss the first time you use it.',
  3: 'Answer using everyday language and a concrete analogy. Use at most two technical terms, and define both. Assume no biology background.'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { slug, topicKey, question, level = 1 } = req.body || {};

  if (JSON.stringify(req.body).length > 4000) return res.status(413).json({ error: 'Too long' });
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

${LEVELS[level]}

<notes>
${topic.sectionText}
</notes>

<key_terms_the_markscheme_credits>
${topic.keywords.join(', ')}
</key_terms_the_markscheme_credits>`;

  const stream = await client.messages.stream({
    model: MODEL,
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: question || `Explain ${topic.label}.` }]
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ t: chunk.delta.text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}
```

**Stream it.** A 700-token answer takes several seconds to generate; streaming makes it feel instant.
Frontend side:

```js
async function askTutor(question, level) {
  const el = document.getElementById('tutorText');
  el.textContent = '';
  const r = await fetch('/api/tutor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, topicKey: tutorTopic, question, level })
  });
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6);
      if (d === '[DONE]') return;
      el.textContent += JSON.parse(d).t;
    }
  }
}
```

Add a text input under the level buttons. Keep the existing `tiers[]` as the **instant default** shown
before anyone asks anything — it costs nothing and fills the panel immediately. The model only fires
when the student actually types a question or presses "break this down further" past level 3.

**Cost:** roughly 1,500 input + 400 output tokens per question ≈ **£0.003** on Haiku. A thousand
questions a month is about £3.

---

## 5. Blurt AI

This is the one that changes most, and the one worth doing first — the current keyword check is
actively misleading, and free recall is the single highest-value revision technique on the site.

**What it becomes:** a marker that reads the blurt as an examiner would. Not "did you say the words"
but "did you make the point, and is what you wrote actually correct".

**Use structured output**, not free text. You want to render a coverage bar, a list of hits and misses,
and a misconception flag — parsing prose for that is fragile. Force a tool call:

```js
// api/blurt.js  (abridged — full version in ai-upgrade/api/)
const MARK_SCHEME_TOOL = {
  name: 'record_marking',
  description: 'Record the marking of a student free-recall attempt.',
  input_schema: {
    type: 'object',
    required: ['points', 'misconceptions', 'overall'],
    properties: {
      points: {
        type: 'array',
        description: 'One entry per markable point in the notes, in the notes\' own order.',
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
      overall: { type: 'string', description: 'Two sentences, addressed to the student. Specific, not encouraging-generic.' }
    }
  }
};

const system = `You are marking a student's free-recall "blurt" on AQA A-level Biology spec point ${topic.num}, "${topic.label}".

The student wrote everything they could remember from memory, quickly. Mark it the way an AQA examiner marks a written answer.

Rules:
- Credit the POINT, not the exact words. "Pi", "phosphate", "inorganic phosphate" are all the same point. So are "makes it more reactive" and "lowers activation energy" if the notes list both.
- Spelling and grammar do not matter. This was typed against a timer.
- Mark a point "wrong" — not "correct" — when the student used the right term to say something false. A student who writes "ATP hydrolase catalyses the condensation of ADP" has NOT earned the ATP hydrolase point.
- Only list points that the notes below actually make. Do not add points from your own knowledge.
- Flag misconceptions even when the student also made the point correctly elsewhere.
- Be exact and unsentimental. This student wants to find their gaps, not be reassured.

<notes>
${topic.sectionText}
</notes>`;

const msg = await client.messages.create({
  model: MODEL,
  max_tokens: 2000,
  system,
  tools: [MARK_SCHEME_TOOL],
  tool_choice: { type: 'tool', name: 'record_marking' },
  messages: [{ role: 'user', content: `<blurt>\n${blurt}\n</blurt>` }]
});

const marking = msg.content.find(b => b.type === 'tool_use').input;
```

**Frontend changes:** your existing `#blurtBarFill` / `#blurtPct` / `#blurtKwGrid` are almost right
already. Compute the percentage as `(correct + 0.5 × partial) / points.length`, colour each grid chip by
`status` (green / amber / grey / **red for wrong** — the red is the new bit and it's the whole point),
and render `misconceptions` in a red callout underneath using the existing `.red-bg` variable.

**One design note.** Keep the 3-minute timer strictly client-side, and only call the API when the
student presses "check". Don't stream the marking — the student should see the result appear at once,
as a verdict, not as a slow trickle. It's a different psychological moment from the tutor.

**Cost:** ~2,000 in + 600 out ≈ **£0.005** per blurt on Haiku.

---

## 6. Feynman AI

Mechanically similar to Blurt, but the thing being judged is different, and this is where people usually
get it wrong by reusing the Blurt prompt.

**Blurt asks: did you remember it?** **Feynman asks: do you understand it?**

A blurt is scored on coverage. A Feynman explanation should be scored on whether a *beginner* would come
away with a correct model — which means jargon that isn't explained is a **fault**, not a hit. That's
the inversion, and the prompt has to say so explicitly or the model will drift back to coverage marking.

```
You are judging a student's attempt at the Feynman technique on AQA A-level Biology spec point
${topic.num}, "${topic.label}". They were asked to explain it out loud as if teaching a complete beginner.

Judge ONE thing: would a beginner who heard only this come away with a correct mental model?

- Technical terms used WITHOUT explanation are a fault, not a strength. "It's chemiosmosis" explains nothing.
- Reward: correct causal chains ("because… which means… so…"), good analogies, correct sequencing.
- Penalise: circular explanation ("photolysis is when photolysis happens"), missing causal steps,
  and any analogy that would leave the beginner with a wrong idea.
- Vagueness the student is hiding behind is the most useful thing you can find. Name it precisely:
  quote the phrase and say what question a beginner would still have.
- Do not reward length. A short, correct, well-sequenced explanation beats a long one.
```

Same structured-output approach, different schema:

```js
{
  understanding: 'solid' | 'partial' | 'surface',
  chain: [ { step: string, present: boolean, note: string } ],   // the causal chain the notes require
  jargon_unexplained: [ { term: string, beginner_would_ask: string } ],
  analogy_check: { used: boolean, quote: string, misleading: boolean, why: string },
  gaps: [ { quote: string, what_is_missing: string } ],
  next_step: string
}
```

**Keep the microphone.** The `SpeechRecognition` transcription already on the page is genuinely the
right input for this — explaining out loud is the technique. It's browser-native and free. Just be aware
Web Speech API is Chrome/Safari only; the typing fallback you already have is the answer for Firefox.

If you later want transcription that works everywhere, record with `MediaRecorder` and post the audio to
a `/api/transcribe` endpoint using a speech-to-text provider. That's a real cost increase and a real
latency increase — only worth it if Firefox users complain.

**Cost:** ~2,000 in + 700 out ≈ **£0.006** per attempt.

---

## 7. Build order

Don't do all three at once. In this order, each step is shippable on its own:

1. **`tools/extract-content.mjs`** — run it, commit `content/`. No user-facing change, but nothing else
   works without it. *(half a day)*
2. **`api/_ratelimit.js` + `api/_content.js`** — the shared plumbing. *(half a day)*
3. **Blurt AI.** Biggest quality jump, simplest endpoint (no streaming), and the structured-output
   pattern you'll reuse twice. Ship it behind a "✨ Try smart marking" toggle next to the existing
   checker so you can compare the two on real answers before switching over. *(1–2 days)*
4. **Feynman AI.** Same shape as Blurt, new schema and prompt. *(1 day)*
5. **Tutor AI.** Leave for last — it needs streaming and a chat UI, so it's the most frontend work,
   and the existing `tiers[]` fallback means it's the least broken as it stands. *(2–3 days)*

## 8. Things worth getting right early

**Cache identical requests.** Students blurt the same topic repeatedly. Hash `slug + topicKey + blurt`
and cache the marking for 24 hours in Upstash. Cheap, and repeat submissions come back instantly.

**Log the marking, anonymously.** Store `{slug, topicKey, points_missed[], timestamp}` with no student
text. After a few hundred blurts you'll know which points across the whole spec are most often missed —
which is the single most valuable thing this site could tell you about your own teaching, and it's free
once the endpoint exists.

**Keep the demos as the fallback.** If `/api/*` returns 429 or 500, silently drop back to the keyword
checker with a small "offline marking" note. The site should never show a student an error where a
working tool used to be.

**Don't add accounts.** The moment you store student work you're handling children's data and you need a
privacy policy, a retention policy, and probably a DPIA. The current "nothing is saved" promise on every
page is a genuine feature — keep it, and keep saying so.

**Set `maxDuration`.** Vercel's default function timeout is short. In `vercel.json`:

```json
"functions": { "api/*.js": { "maxDuration": 30 } }
```

---

## 9. Rough running cost

At Haiku pricing, assuming a student does ~10 tool interactions per session:

| Monthly active students | Interactions | Approx. cost |
|---|---|---|
| 100 | 1,000 | £4 |
| 1,000 | 10,000 | £40 |
| 10,000 | 100,000 | £400 |

Vercel's hobby tier covers the hosting; the functions are the only variable cost. If it ever gets to the
right-hand row, that's a good problem, and it's the point at which caching and a login for heavy users
start paying for themselves.
