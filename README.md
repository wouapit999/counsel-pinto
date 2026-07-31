# Counsel Pinto

**Developed by Bouquet Innovation S.A**

An AI legal counsel web app for **Cameroon**, **Mozambique** and the **CEMAC region**, answering in English, French or Portuguese.

Every substantive answer comes back in a fixed structure: Short Answer → Legal Basis → Procedural Steps → Risks & Considerations → Recommended Action → Templates.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Claude Opus 5 via the Anthropic TypeScript SDK, streamed

## Setup

```bash
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
npm install
npm run dev
```

Open http://localhost:3000.

## What's where

| Path | Purpose |
| --- | --- |
| `src/lib/counsel.ts` | Persona, jurisdiction + language directives, starter questions. Edit the prompt here. |
| `src/app/api/chat/route.ts` | Streaming endpoint. Model, token budget and error mapping live here. |
| `src/app/page.tsx` | Chat UI: jurisdiction/language/depth controls, markdown rendering, transcript export. |
| `src/app/globals.css` | Design tokens (light + dark) and the `.legal-prose` markdown styling. |

## Controls

- **Jurisdiction** — pins the answer to Cameroon, Mozambique or CEMAC, or lets the model infer it from the facts. The directive tells it, e.g., not to import OHADA rules into a Mozambican answer.
- **Reply language** — forces English, French or Portuguese, or mirrors whatever the user wrote in.
- **Analysis depth** — maps to Claude's `effort` parameter (`medium` / `high` / `xhigh`). Higher is slower and more thorough.

## Notes on the prompt

`BASE_PERSONA` in `src/lib/counsel.ts` is the cached prefix — it carries a `cache_control` breakpoint, so keep it byte-stable across requests. The jurisdiction and language directives are appended *after* that breakpoint precisely so flipping a selector doesn't invalidate the cache.

The persona instructs the model to summarise and cite legal provisions rather than reproduce them, to flag uncertainty and possible amendments rather than smooth over them, and to decline to predict how a specific court will rule.

## Limits

This ships legal *information*, not legal advice, and it has no retrieval layer — answers come from the model's training data, so recent amendments may be missed. The persona tells the model to say so and name the official source to verify against, but that is a mitigation, not a guarantee. For anything contentious or high-value, instruct a locally admitted lawyer.

Conversations are stored in the browser's `localStorage` only; nothing is persisted server-side.

## Deployment

Hosted on Vercel. The one required environment variable is `ANTHROPIC_API_KEY` — set it for Production, Preview and Development:

```bash
vercel env add ANTHROPIC_API_KEY production
```

Without it the app builds and renders, but every question returns a "key is not set" notice instead of an answer.

---

© Bouquet Innovation S.A. Developed by Bouquet Innovation S.A.
