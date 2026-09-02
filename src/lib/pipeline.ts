import {
  CHUNK_DIRECTIVE,
  buildSystem,
  frameDocument,
  synthesisDirective,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
  type SearchMode,
  type Source,
  type TaskId,
} from "@/lib/counsel";
import {
  streamCompletion,
  type ResolvedProvider,
  type StreamEvent,
  type Turn,
} from "@/lib/providers";
import { formatHits, searchBackend, searchMany } from "@/lib/search";
import { chunkDocument, documentBudget, estimateTokens } from "@/lib/tokens";

/**
 * The work happens here: decide how the model gets at the web, fit the
 * request into whatever budget the provider's free tier allows, and if a
 * document is too long for one request, read it in parts and synthesise.
 *
 * The route stays thin; this is where "works on any API" is earned.
 */

export type AttachedDocument = { name: string; text: string };

export type PipelineEvent =
  | StreamEvent
  | {
      type: "meta";
      provider: string;
      model: string;
      search: SearchMode;
      parts: number;
    }
  | { type: "progress"; text: string; step?: number; total?: number };

export type PipelineArgs = {
  provider: ResolvedProvider;
  /** Conversation so far; the last turn is the user's current request. */
  turns: Turn[];
  documents: AttachedDocument[];
  task: TaskId;
  jurisdiction: JurisdictionId;
  language: LanguageId;
  effort: EffortId;
  research: boolean;
  signal?: AbortSignal;
};

type CallArgs = Parameters<typeof streamCompletion>[1];

/** Tokens held back for the model's answer and the provider's own overhead. */
const ANSWER_RESERVE = 2500;
/** Share of the budget the conversation history may occupy. */
const HISTORY_SHARE = 0.3;
/** Back-off schedule for rate limits, in ms. Free tiers reset per minute. */
const BACKOFF = [2000, 6000, 15000];

function budgetFor(provider: ResolvedProvider): number {
  const override = Number(process.env.AI_BUDGET_TOKENS);
  return Number.isFinite(override) && override > 0 ? override : provider.requestBudget;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
}

function isRateLimit(err: unknown): boolean {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  return (
    status === 429 || /rate.?limit|too many requests|RESOURCE_EXHAUSTED/i.test(String(err))
  );
}

/**
 * Run one provider call to completion, retrying on rate limits with back-off.
 * Yields progress so the UI can say why it is waiting rather than going quiet.
 */
async function* completeWithRetry(
  provider: ResolvedProvider,
  args: CallArgs,
  label: string,
): AsyncGenerator<PipelineEvent, { text: string; sources: Source[] }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      let text = "";
      let sources: Source[] = [];
      for await (const ev of streamCompletion(provider, args)) {
        if (ev.type === "text") text += ev.text;
        else if (ev.type === "sources") sources = ev.sources;
      }
      return { text, sources };
    } catch (err) {
      if (!isRateLimit(err) || attempt >= BACKOFF.length) throw err;
      const wait = BACKOFF[attempt];
      yield {
        type: "progress",
        text: `${provider.label} rate limit reached while ${label} — retrying in ${Math.round(wait / 1000)}s.`,
      };
      await sleep(wait, args.signal);
    }
  }
}

/** Stream the final answer, retrying on a rate limit only if nothing was emitted yet. */
async function* streamWithRetry(
  provider: ResolvedProvider,
  args: CallArgs,
  label: string,
): AsyncGenerator<PipelineEvent> {
  for (let attempt = 0; ; attempt += 1) {
    let emitted = false;
    try {
      for await (const ev of streamCompletion(provider, args)) {
        emitted = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (emitted || !isRateLimit(err) || attempt >= BACKOFF.length) throw err;
      const wait = BACKOFF[attempt];
      yield {
        type: "progress",
        text: `${provider.label} rate limit reached while ${label} — retrying in ${Math.round(wait / 1000)}s.`,
      };
      await sleep(wait, args.signal);
    }
  }
}

/** Keep the most recent turns that fit the history share of the budget. */
function trimHistory(turns: Turn[], maxTokens: number): Turn[] {
  const kept: Turn[] = [];
  let used = 0;
  // The last turn is the current request and is always kept.
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = estimateTokens(turns[i].content);
    if (kept.length > 0 && used + t > maxTokens) break;
    kept.unshift(turns[i]);
    used += t;
  }
  return kept;
}

/** Ask the model for the two or three searches it would run. Cheap and short. */
async function* deriveQueries(
  provider: ResolvedProvider,
  request: string,
  jurisdiction: JurisdictionId,
  signal?: AbortSignal,
): AsyncGenerator<PipelineEvent, string[]> {
  const where = jurisdiction === "auto" ? "Cameroon, Mozambique or CEMAC" : jurisdiction;
  const system = `You write web search queries for a legal researcher working on ${where} law. Reply with two or three queries, one per line, nothing else. Prefer queries that find the governing instrument, the regulator's current rule, or the current figure. Include the jurisdiction and, where useful, the name of the statute or Uniform Act.`;
  const result = yield* completeWithRetry(
    provider,
    {
      system,
      turns: [{ role: "user", content: request.slice(0, 4000) }],
      effort: "medium",
      research: false,
      signal,
    },
    "planning searches",
  );
  return result.text
    .split("\n")
    .map((l) => l.replace(/^[\s\-*\d.)]+/, "").replace(/^["']|["']$/g, "").trim())
    .filter((l) => l.length > 6 && l.length < 200)
    .slice(0, 3);
}

export async function* runPipeline(a: PipelineArgs): AsyncGenerator<PipelineEvent> {
  const { provider, signal } = a;
  const request = a.turns[a.turns.length - 1]?.content ?? "";

  // 1. Decide how the web gets involved.
  const backend = searchBackend();
  const search: SearchMode =
    a.research && provider.canSearch
      ? "native"
      : a.research && backend
        ? "provided"
        : "none";

  const system = buildSystem({
    jurisdiction: a.jurisdiction,
    language: a.language,
    search,
    task: a.task,
  });

  // 2. Budget.
  const budget = budgetFor(provider);
  const systemTokens = estimateTokens(system);
  const history = trimHistory(a.turns, Math.floor(budget * HISTORY_SHARE));
  const historyTokens = history.reduce((n, t) => n + estimateTokens(t.content), 0);
  const docBudget = documentBudget({
    requestBudget: budget,
    systemTokens,
    historyTokens,
    answerReserve: ANSWER_RESERVE,
  });

  // 3. External search, if that is the mode. Results are prepended to the
  //    request so the model reads them before the question.
  let retrieved = "";
  let retrievedSources: Source[] = [];
  if (search === "provided") {
    yield { type: "searching", active: true };
    yield { type: "progress", text: "Planning searches…" };
    let queries: string[] = [];
    try {
      queries = yield* deriveQueries(provider, request, a.jurisdiction, signal);
    } catch {
      queries = [];
    }
    if (queries.length === 0) queries = [request.slice(0, 200)];
    yield { type: "progress", text: `Searching: ${queries.join(" · ")}` };
    try {
      const hits = (await searchMany(queries, 4, signal)).slice(0, 8);
      retrieved = formatHits(hits);
      retrievedSources = hits.map((h) => ({ title: h.title, url: h.url, host: h.host }));
      if (hits.length === 0) {
        yield {
          type: "notice",
          text: "Web search returned nothing usable — check the search key if this keeps happening. The answer below is from the model's own knowledge and says what to verify.",
        };
      }
    } catch {
      yield {
        type: "notice",
        text: "Web search failed this time; the answer is from the model's own knowledge.",
      };
    }
    yield { type: "searching", active: false };
  }

  // 4. Documents: single pass if they fit, otherwise read in parts.
  const docs = a.documents.filter((d) => d.text.trim());
  const docTokens = docs.reduce((n, d) => n + estimateTokens(d.text), 0);
  const retrievedTokens = estimateTokens(retrieved);
  const singlePass = docTokens + retrievedTokens <= docBudget;

  const chunks = singlePass
    ? []
    : docs.flatMap((d) =>
        chunkDocument(d.text, Math.max(docBudget - retrievedTokens, 1200)).map((c) => ({
          name: d.name,
          ...c,
        })),
      );

  yield {
    type: "meta",
    provider: provider.label,
    model: provider.model,
    search,
    parts: singlePass ? (docs.length ? 1 : 0) : chunks.length,
  };

  const native = search === "native";

  // 5a. Everything fits: one streamed request.
  if (singlePass) {
    const framed = docs.map((d) => frameDocument(d.name, d.text)).join("\n\n");
    const last = [retrieved, framed, request].filter(Boolean).join("\n\n");
    const turns: Turn[] = [...history.slice(0, -1), { role: "user", content: last }];
    yield* streamWithRetry(
      provider,
      { system, turns, effort: a.effort, research: native, signal },
      "answering",
    );
    if (retrievedSources.length) yield { type: "sources", sources: retrievedSources };
    return;
  }

  // 5b. Map: read each part and take notes.
  const notes: string[] = [];
  for (const chunk of chunks) {
    yield {
      type: "progress",
      text: `Reading ${chunk.name}, part ${chunk.index + 1} of ${chunk.total}…`,
      step: notes.length + 1,
      total: chunks.length,
    };
    const partSystem = `${system}\n\n## This step\n\n${CHUNK_DIRECTIVE[a.task]}`;
    const content = [
      `The user's request, for context: ${request.slice(0, 2000)}`,
      frameDocument(chunk.name, chunk.text, { index: chunk.index, total: chunk.total }),
    ].join("\n\n");
    const result = yield* completeWithRetry(
      provider,
      {
        system: partSystem,
        turns: [{ role: "user", content }],
        effort: "medium",
        research: false,
        signal,
      },
      `reading part ${chunk.index + 1}`,
    );
    notes.push(
      `### Notes from ${chunk.name}, part ${chunk.index + 1} of ${chunk.total}\n\n${result.text.trim()}`,
    );
  }

  // 5c. Reduce: one streamed request over the notes.
  yield { type: "progress", text: "Bringing it together…" };
  const reduceSystem = `${system}\n\n## This step\n\n${synthesisDirective(a.task, chunks.length)}`;
  const last = [retrieved, notes.join("\n\n"), `---\n\n${request}`]
    .filter(Boolean)
    .join("\n\n");
  const turns: Turn[] = [...history.slice(0, -1), { role: "user", content: last }];
  yield* streamWithRetry(
    provider,
    { system: reduceSystem, turns, effort: a.effort, research: native, signal },
    "writing the answer",
  );
  if (retrievedSources.length) yield { type: "sources", sources: retrievedSources };
}
