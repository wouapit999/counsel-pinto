# Counsel Pinto

**Developed by Bouquet Innovation S.A**

An AI legal counsel web app for **Cameroon**, **Mozambique** and the **CEMAC region**, answering in English, French or Portuguese.

Every substantive answer comes back in a fixed structure: Short Answer → Legal Basis → Procedural Steps → Risks & Considerations → Recommended Action → Templates.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Google Gemini via `@google/genai`, streamed, with Grounding with Google Search

## Setup

Get a free API key at **https://aistudio.google.com/apikey** — no card required.

```bash
cp .env.example .env.local   # then add your GEMINI_API_KEY
npm install
npm run dev
```

Open http://localhost:3000.

The default model is `gemini-flash-latest`, which the free tier covers. Set `GEMINI_MODEL` to override it.

## What's where

| Path | Purpose |
| --- | --- |
| `src/lib/counsel.ts` | Persona, jurisdiction + language directives, starter questions, speech locales. Edit the prompt here. |
| `src/app/api/chat/route.ts` | Streaming endpoint. Model, Search grounding, thinking level, source collection, error mapping. |
| `src/lib/speech.ts` | Dictation and spoken replies, plus the markdown→speech reducer. |
| `src/components/CounselBot.tsx` | The animated assistant character and its states. |
| `src/app/page.tsx` | Chat UI: controls, markdown rendering, source chips, transcript export. |
| `src/app/globals.css` | Design tokens (light + dark), `.legal-prose` styling, bot animations. |

## Controls

- **Jurisdiction** — pins the answer to Cameroon, Mozambique or CEMAC, or lets the model infer it from the facts. The directive tells it, e.g., not to import OHADA rules into a Mozambican answer.
- **Reply language** — forces English, French or Portuguese, or mirrors whatever the user wrote in.
- **Analysis depth** — maps to Gemini's `thinkingLevel` (`LOW` / `MEDIUM` / `HIGH`). Higher is slower and more thorough. Deliberately *not* `thinkingBudget`: budgets are model-dependent and are rejected outright by Gemini 3.5 and newer, so a model bump would break the app.
- **Search the web** — on by default. Enables Grounding with Google Search so the model can check current figures and the status of named instruments against live sources, and cites what it consulted. Grounded requests consume free-tier quota faster; turn it off for questions about settled doctrine.
- **Read answers aloud** — speaks each reply through the browser's speech synthesis in the selected language.

## Voice

Dictation uses `SpeechRecognition`, which in practice means Chromium (Chrome, Edge). The mic button hides itself where the API is absent rather than offering a dead control, and the same applies to the read-aloud toggle. Locales are `en-US`, `fr-FR` and `pt-PT` — European Portuguese, since that is what Mozambique uses.

Markdown is reduced to speakable prose before synthesis (`toSpeech` in `src/lib/speech.ts`): tables, code fences, URLs and emphasis markers are stripped, and list items get sentence boundaries so they don't run together.

## The bot

`CounselBot` is an SVG character with five states — idle, listening, thinking, searching, speaking — driven from the page's state rather than animated blindly. It blinks on an irregular timer, pulses rings while listening, orbits a dot while researching, and moves its mouth while speaking. All of it is disabled under `prefers-reduced-motion`.

## Notes on the prompt

`BASE_PERSONA` in `src/lib/counsel.ts` leads the system instruction and should stay byte-stable, so Gemini's implicit prompt caching keeps hitting. The jurisdiction and language directives are appended *after* it for the same reason — flipping a selector then changes only the tail.

The persona instructs the model to summarise and cite legal provisions rather than reproduce them, to flag uncertainty and possible amendments rather than smooth over them, and to decline to predict how a specific court will rule.

## Limits

This ships legal *information*, not legal advice.

Web search materially improves currency, but it is retrieval, not verification: the model chooses the queries and reads the results, so a wrong or outdated page can still be relied on. The prompt tells it to prefer official and primary sources, to attribute figures to the source they came from, to flag disagreement between sources, and to say when it could not confirm something rather than filling the gap from memory. Treat the cited sources as the thing to check, not as proof the answer is right. For anything contentious or high-value, instruct a locally admitted lawyer.

The model cannot be fine-tuned from here — what makes it knowledgeable is the retrieval layer plus the instructions in `src/lib/counsel.ts`, and both are editable.

Conversations are stored in the browser's `localStorage` only; nothing is persisted server-side.

## Deployment

Hosted on Vercel. The one required environment variable is `GEMINI_API_KEY`:

```bash
vercel env add GEMINI_API_KEY production
```

Run it from the project root, and redeploy afterwards — environment variables are read at build time. Without it the app builds and renders, but every question returns a "key is not set" notice instead of an answer.

### Free-tier caveats

- Rate limits are per minute and per day. Hitting one surfaces as a "rate limit" notice in the UI, not a crash.
- Free-tier prompts and responses may be used by Google to improve their products. **Do not put privileged or client-identifying facts into this app while it runs on the free tier.** A paid tier changes those terms; check the current AI Studio terms before promising confidentiality to anyone.
- Google's Grounding with Google Search terms require displaying its Search Suggestions alongside grounded answers. This build shows the grounded source domains but not the rendered suggestion chips from `searchEntryPoint`; add them before any public launch.

---

© Bouquet Innovation S.A. Developed by Bouquet Innovation S.A.
