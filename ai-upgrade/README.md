# ai-upgrade — starter code for the real AI tools

Nothing in this folder is live. It sits outside the deployed site on purpose: Vercel only turns files
in a top-level `api/` directory into functions, so while these live under `ai-upgrade/api/` they are
inert and cost nothing.

Read `../AI-TOOLS-GUIDE.md` first — it explains the design decisions. This folder is the code.

```
ai-upgrade/
├── tools/extract-content.mjs   # run this first — builds content/ from the notes pages
└── api/
    ├── _content.js             # loads content/<slug>.json; never trusts a client-supplied path
    ├── _ratelimit.js           # per-IP sliding window (Upstash) + body size guard
    ├── tutor.js                # streaming SSE answer, three explanation levels
    ├── blurt.js                # structured examiner-style marking of a free-recall attempt
    └── feynman.js              # structured judgement of an explain-to-a-beginner attempt
```

## To go live

```bash
node ai-upgrade/tools/extract-content.mjs    # writes content/
npm install @anthropic-ai/sdk @upstash/redis
mv ai-upgrade/api ./api                       # NOW it's a live Vercel function directory
```

These files are ES modules, so add `"type": "module"` to `package.json` (or rename them to `.mjs` —
Vercel routes `api/tutor.mjs` to `/api/tutor` either way).

Files starting with `_` are never routed by Vercel, which is why the two shared helpers are named
`_content.js` and `_ratelimit.js`. Keep that convention if you add more.

Set `ANTHROPIC_API_KEY` (and optionally `CLAUDE_MODEL`, `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`) in Vercel → Settings → Environment Variables, then deploy.

Test locally with `vercel dev` and:

```bash
curl -s localhost:3000/api/blurt -H 'Content-Type: application/json' -d '{
  "slug":"3-1-6-atp","topicKey":"hydrolysis",
  "blurt":"ATP hydrolase splits ATP into ADP and phosphate using water and this releases energy"
}' | jq
```

## Still to do (deliberately not written for you)

- The frontend wiring on each notes page — the guide has the fetch/stream snippets, but where the
  buttons go is a design call.
- Caching identical submissions (Upstash, 24h TTL, key on a hash of slug+topic+text).
- The anonymous "which points get missed most" log. Worth doing early; it's the most useful thing
  the endpoints can give you back.
