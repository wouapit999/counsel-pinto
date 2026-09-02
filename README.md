# Counsel Pinto

**Developed by Bouquet Innovation S.A**

An AI legal counsel web app for **Cameroon**, **Mozambique** and the **CEMAC region**, answering in English, French or Portuguese.

Five kinds of work, chosen from the sidebar:

| Task | What you get |
| --- | --- |
| **Consultation** | Short Answer → Legal Basis → Procedural Steps → Risks → Recommended Action → Templates |
| **Review & redline** | Attach a contract. Clause-by-clause: risk level, the issue, the original text quoted, proposed replacement with ~~deletions~~ and **insertions** marked, and the legal basis. Then missing provisions and a negotiating position. |
| **Draft** | A contract, clause, letter, notice or resolution in the jurisdiction's conventions, with placeholders and drafting notes. |
| **Legal opinion** | Question presented → short answer → facts assumed → analysis → conclusion → qualifications. |
| **Filing / submission** | The document to lodge, an **annex of every provision relied on**, and the procedure — where, fees, deadlines, attachments. |

Any answer can be opened in Word with one click. Documents go in as PDF, Word or text, up to 4 MB.

### Long documents on small budgets

Free tiers cap tokens per minute well below a model's context window — Groq's 70B model allows roughly 12k tokens a minute against a 128k window. A 30-page contract does not fit. So each provider carries a `requestBudget`, and a document that exceeds it is read in parts: each part is analysed against the task, then a final pass synthesises the notes into the deliverable. Progress is streamed ("Reading contract.pdf, part 3 of 7…"), rate limits are retried with back-off, and parts are cut at clause boundaries with overlap so nothing is read half. Set `AI_BUDGET_TOKENS` to raise the budget on a paid tier.

### Web search on any model

Searching used to depend on the model being able to search. Now it doesn't: set a free `TAVILY_API_KEY` (or `BRAVE_SEARCH_API_KEY`) and every model gets grounded answers — the app asks the model what to search for, runs the searches, floats official sources (gazettes, regulators, courts) to the top, hands the results in as numbered context, and shows them as source chips. Models that search natively (Groq compound, Perplexity) still do so themselves.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Pluggable model provider — six supported, five of them free, no vendor SDK

## Setup

Pick a provider from the table below, set its key, and run:

```bash
cp .env.example .env.local   # then set one key
npm install
npm run dev
```

Open http://localhost:3000. If no key is set the app still runs and tells you what to add — it doesn't error.

## Providers

| Provider | Free? | Web search | Key |
| --- | --- | --- | --- |
| **Groq** | Yes, no card | **Yes, on `compound` models** | console.groq.com/keys |
| Cerebras | Yes, no card | No | cloud.cerebras.ai |
| Mistral | Free experimental tier | No | console.mistral.ai/api-keys |
| OpenRouter | Only on `:free` models | Only on `:online` models (billed) | openrouter.ai/keys |
| GitHub Models | Yes, rate-limited | No | github.com/settings/tokens |
| Perplexity | Paid | Yes | perplexity.ai/settings/api |

**Groq is the one to use**, and if the answers need to be current, set `GROQ_MODEL` to a compound model. Those run web search server-side and report what they used, which is the only way to get free *and* sourced. The default (`llama-3.3-70b-versatile`) is the safer starting point but answers from training data alone.

Search capability is a property of the **model**, not the provider — `src/lib/providers/catalog.ts` matches it per model, so switching `GROQ_MODEL` to a compound system enables the search toggle automatically.

### How the provider is chosen

The app uses the first provider it finds a key for, in the order in the table. Set `AI_PROVIDER` to pin one explicitly when several keys are present. Every model ID is overridable — `GROQ_MODEL`, `MISTRAL_MODEL`, and so on — because model IDs are retired regularly; a stale one surfaces as "model not available on X", not a crash.

All six speak OpenAI's `/chat/completions`, so there is one adapter and no vendor SDK. Citations arrive in three different shapes (Perplexity's `citations` and `search_results`, Groq's `executed_tools`); `openaiCompat.ts` reads all of them and ignores anything it doesn't recognise, because a missing source chip is survivable and an invented one is not.

### When a model cannot search

Search-less models answer from training data, which for law means figures and instrument statuses may be out of date. The app handles this rather than pretending otherwise:

- the **Search the web** toggle is disabled, with the reason shown
- the system prompt is switched to an explicit no-web-access directive telling the model never to imply it looked something up, never to emit a URL, and to name the registry or regulator to verify against instead

That second point matters most: without it, a model told it has a search tool will cheerfully invent citations.

## What's where

| Path | Purpose |
| --- | --- |
| `src/lib/counsel.ts` | Persona, jurisdiction + language directives, starter questions, speech locales. Edit the prompt here. |
| `src/lib/providers/` | Provider layer: `catalog.ts` lists them, `openaiCompat.ts` is the single adapter, `index.ts` resolves the active one from env. |
| `src/app/api/chat/route.ts` | Streaming endpoint. Thin — picks the provider and forwards its events. |
| `src/app/api/config/route.ts` | Capability report for the UI (active provider, model, can it search). Never returns key material. |
| `src/lib/speech.ts` | Dictation and spoken replies, plus the markdown→speech reducer. |
| `src/components/CounselBot.tsx` | The animated assistant character and its states. |
| `src/app/page.tsx` | Chat UI: controls, markdown rendering, source chips, transcript export. |
| `src/app/globals.css` | Design tokens (light + dark), `.legal-prose` styling, bot animations. |

## Controls

- **Jurisdiction** — pins the answer to Cameroon, Mozambique or CEMAC, or lets the model infer it from the facts. The directive tells it, e.g., not to import OHADA rules into a Mozambican answer.
- **Reply language** — forces English, French or Portuguese, or mirrors whatever the user wrote in.
- **Analysis depth** — maps to `reasoning_effort` on providers that accept it (currently Perplexity). Others ignore it.
- **Search the web** — on by default where the active model supports it. Lets the model check current figures and the status of named instruments against live sources, and cite what it consulted. Searches consume free-tier quota faster; turn it off for questions about settled doctrine. Disabled automatically, with the reason shown, on models that cannot search.
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

Hosted on Vercel. Set one provider key — `GROQ_API_KEY` unless you have a reason to differ. Either paste it into the project's Environment Variables page in the dashboard, or:

```bash
vercel env add GROQ_API_KEY production
```

Redeploy afterwards — environment variables are read at build time. Without a key the app builds and renders, and shows setup guidance instead of failing.

### Free-tier caveats

- Rate limits are per minute and per day. Hitting one surfaces as a "rate limit" notice in the UI, not a crash.
- **Free tiers commonly reserve the right to use prompts and responses to improve the provider's products.** Do not put privileged or client-identifying facts into this app while it runs on one, and read the specific provider's current terms before promising confidentiality to anyone.
- Every free model here is materially smaller than a frontier model. On OHADA, CEMAC and Mozambican law specifically, check the first few answers against a source you trust before letting anyone else use it.

---

© Bouquet Innovation S.A. Developed by Bouquet Innovation S.A.
