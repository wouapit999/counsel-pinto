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
  chooseModel,
  describeError,
  listModels,
  markExhausted,
  modelCanSearch,
  rememberModel,
  streamCompletion,
  type ResolvedProvider,
  type StreamEvent,
  type Turn,
} from "@/lib/providers";
import { formatHits, searchBackend, searchMany } from "@/lib/search";
import { chunkDocument, documentBudget, estimateTokens } from "@/lib/tokens";

/**
 * The work happens here: get sources, fit the request into the budget the
 * free tiers allow, read long documents in parts — and when a provider runs
 * out, hand the request to the next one rather than fail.
 *
 * The route stays thin; this is where "never runs out" is earned.
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
      chain: string[];
    }
  /** Emitted when a provider is about to answer — the last one wins. */
  | { type: "provider"; label: string; model: string }
  | { type: "progress"; text: string; step?: number; total?: number };

export type PipelineArgs = {
  /** Failover chain, best first. Never empty. */
  providers: ResolvedProvider[];
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
type Attempt<T> = (p: ResolvedProvider) => AsyncGenerator<PipelineEvent, T>;

/** Tokens held back for the model's answer and the provider's own overhead. */
const ANSWER_RESERVE = 2500;
/** Share of the budget the conversation history may occupy. */
const HISTORY_SHARE = 0.3;
/** How long a rate-limited provider sits out. Free tiers reset per minute. */
const COOLDOWN_MS = 60_000;
/**
 * When every provider is limited at once: wait as long as the provider asked
 * for (clamped), then go round again — up to MAX_ROUNDS passes. With a single
 * provider this is what turns "rate limited" into "answered 40 seconds later"
 * rather than an error.
 */
const MAX_ROUNDS = 3;
const DEFAULT_WAIT_MS = 20_000;
const MIN_WAIT_MS = 5_000;
const MAX_WAIT_MS = 65_000;

function retryAfterOf(err: unknown): number {
  const v =
    typeof err === "object" && err !== null && "retryAfterMs" in err
      ? Number((err as { retryAfterMs?: unknown }).retryAfterMs)
      : NaN;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function budgetFor(provider: ResolvedProvider): number {
  const override = Number(process.env.AI_BUDGET_TOKENS);
  return Number.isFinite(override) && override > 0 ? override : provider.requestBudget;
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    // A signal that was aborted before we got here must not cost the full wait.
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

const isAbort = (err: unknown) => (err as Error)?.name === "AbortError";

type Failure = "rate" | "auth" | "model" | "credit" | "other";

function classify(err: unknown): Failure {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  if (status === 429 || /rate.?limit|too many requests|RESOURCE_EXHAUSTED/i.test(raw)) return "rate";
  if (status === 401 || status === 403 || /api key|unauthori[sz]ed|PERMISSION_DENIED|invalid.*token/i.test(raw)) return "auth";
  if (status === 404 || /not found|does not exist|unknown model|decommissioned|NOT_FOUND/i.test(raw)) return "model";
  if (status === 402 || /insufficient|credit|billing|payment/i.test(raw)) return "credit";
  return "other";
}

const FAILURE_LABEL: Record<Failure, string> = {
  rate: "rate limit",
  auth: "key rejected",
  model: "model not available",
  credit: "no credit",
  other: "error",
};

/** Wraps an error from an attempt that had already streamed output. */
export class PartialOutput extends Error {
  constructor(public readonly inner: unknown) {
    super("partial output");
  }
}

/**
 * Every provider in the chain failed. The message already names each one and
 * why, so the route must show it as-is rather than re-describe it.
 */
export class ChainExhausted extends Error {
  constructor(public readonly failures: string[]) {
    super(
      failures.length
        ? `Every configured provider failed.\n${failures.join("\n")}`
        : "No provider was available.",
    );
    this.name = "ChainExhausted";
  }
}

/**
 * Try each provider in turn until one completes the attempt.
 *
 * A rate limit moves straight to the next provider and puts the limited one
 * on cooldown; a rejected key, missing model or empty credit skips it for
 * this request. If every provider is rate-limited at once, wait and go round
 * once more. An attempt that already streamed output is never retried
 * elsewhere — the user would see two half-answers.
 */
export async function* withFailover<T>(
  providers: ResolvedProvider[],
  label: string,
  attempt: Attempt<T>,
  signal?: AbortSignal,
): AsyncGenerator<PipelineEvent, T> {
  const skipped = new Set<string>();
  // One line per provider, latest wins — three rounds of the same limit
  // should read as one failure, not three.
  const failures = new Map<string, string>();

  /** Providers whose model was swapped once already this request. */
  const substituted = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let sawRateLimit = false;
    let waitHint = 0;

    // A queue rather than a plain loop, so a provider whose model ID was
    // rejected can be put straight back at the front with a working one.
    const queue = providers.filter((p) => !skipped.has(p.id));
    while (queue.length > 0) {
      const p = queue.shift()!;
      try {
        return yield* attempt(p);
      } catch (err) {
        if (isAbort(err)) throw err;
        if (err instanceof PartialOutput) throw err.inner;

        const kind = classify(err);
        failures.set(p.label, `${p.label}: ${describeError(err, p.model, p.label)}`);

        if (kind === "rate") {
          sawRateLimit = true;
          waitHint = Math.max(waitHint, retryAfterOf(err));
          markExhausted(p.id, Math.max(COOLDOWN_MS, retryAfterOf(err)));
          yield {
            type: "progress",
            text:
              queue.length > 0
                ? `${p.label} hit its free-tier limit while ${label} — switching provider.`
                : `${p.label} hit its free-tier limit while ${label}.`,
          };
          continue;
        }

        if (kind === "model") {
          // Model IDs get retired without notice. Ask the provider what it
          // has now, pick the best fit, and try again at once.
          const ids = await listModels(p).catch(() => [] as string[]);
          const pick = substituted.has(p.id) ? null : chooseModel(ids, p.model);
          if (pick) {
            substituted.add(p.id);
            rememberModel(p.id, pick);
            yield {
              type: "notice",
              text: `${p.label} no longer offers "${p.model}" — using "${pick}" instead. Set ${p.envModel}=${pick} to make that permanent.`,
            };
            queue.unshift({ ...p, model: pick, canSearch: modelCanSearch(p, pick) });
            continue;
          }
          yield {
            type: "notice",
            text: ids.length
              ? `${p.label} does not offer "${p.model}" and nothing suitable was found among: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}. Set ${p.envModel} explicitly.`
              : `${p.label} does not offer "${p.model}". Set ${p.envModel} to a current model ID.`,
          };
        }

        skipped.add(p.id);
        yield {
          type: "progress",
          text: `${p.label} unavailable (${FAILURE_LABEL[kind]}) — trying the next provider.`,
        };
      }
    }

    const remaining = providers.filter((p) => !skipped.has(p.id));
    if (!sawRateLimit || remaining.length === 0 || round === MAX_ROUNDS - 1) break;
    const wait = Math.min(Math.max(waitHint || DEFAULT_WAIT_MS, MIN_WAIT_MS), MAX_WAIT_MS);
    yield {
      type: "progress",
      text:
        remaining.length === 1
          ? `${remaining[0].label} is rate-limited and it is the only provider configured — waiting ${Math.ceil(wait / 1000)}s for the limit to reset (add more provider keys to avoid this wait).`
          : `Every provider is rate-limited right now — waiting ${Math.ceil(wait / 1000)}s for limits to reset.`,
    };
    await sleep(wait, signal);
  }

  throw new ChainExhausted([...failures.values()]);
}

/** A non-streaming attempt: drain the stream and hand back the text. */
function complete(
  args: (p: ResolvedProvider) => CallArgs,
): Attempt<{ text: string; sources: Source[] }> {
  return async function* (p) {
    let text = "";
    let sources: Source[] = [];
    for await (const ev of streamCompletion(p, args(p))) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "sources") sources = ev.sources;
    }
    return { text, sources };
  };
}

/** A streaming attempt: pass events through; once text has flowed, no failover. */
function stream(args: (p: ResolvedProvider) => CallArgs): Attempt<void> {
  return async function* (p) {
    let emitted = false;
    yield { type: "provider", label: p.label, model: p.model };
    try {
      for await (const ev of streamCompletion(p, args(p))) {
        if (ev.type === "text") emitted = true;
        yield ev;
      }
    } catch (err) {
      throw emitted ? new PartialOutput(err) : err;
    }
  };
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

function parseQueries(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s\-*\d.)]+/, "").replace(/^["']|["']$/g, "").trim())
    .filter((l) => l.length > 6 && l.length < 200)
    .slice(0, 3);
}

export async function* runPipeline(a: PipelineArgs): AsyncGenerator<PipelineEvent> {
  const { providers, signal } = a;
  const request = a.turns[a.turns.length - 1]?.content ?? "";

  // 1. External retrieval first, whenever a search backend exists. It costs
  //    one small call, and it means a fallback provider without native search
  //    still answers from sources.
  let retrieved = "";
  let retrievedSources: Source[] = [];
  if (a.research && searchBackend()) {
    yield { type: "searching", active: true };
    yield { type: "progress", text: "Planning searches…" };
    const where = a.jurisdiction === "auto" ? "Cameroon, Mozambique or CEMAC" : a.jurisdiction;
    let queries: string[] = [];
    try {
      const planned = yield* withFailover(
        providers,
        "planning searches",
        complete(() => ({
          system: `You write web search queries for a legal researcher working on ${where} law. Reply with two or three queries, one per line, nothing else. Prefer queries that find the governing instrument, the regulator's current rule, or the current figure. Include the jurisdiction and, where useful, the name of the statute or Uniform Act.`,
          turns: [{ role: "user", content: request.slice(0, 4000) }],
          effort: "medium",
          research: false,
          signal,
        })),
        signal,
      );
      queries = parseQueries(planned.text);
    } catch (err) {
      if (isAbort(err)) throw err;
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
          text: "Web search returned nothing usable for this question; the answer is from the model's own knowledge and says what to verify.",
        };
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      yield {
        type: "notice",
        text: "Web search failed this time; the answer is from the model's own knowledge.",
      };
    }
    yield { type: "searching", active: false };
  }

  // 2. The system prompt depends on the provider: one that searches natively
  //    is told so; the others are told sources were provided, or that there
  //    is no web access at all. Rebuilt on every failover.
  const modeFor = (p: ResolvedProvider): SearchMode =>
    a.research && p.canSearch ? "native" : retrieved ? "provided" : "none";
  const systemFor = (p: ResolvedProvider) =>
    buildSystem({
      jurisdiction: a.jurisdiction,
      language: a.language,
      search: modeFor(p),
      task: a.task,
    });

  // 3. Budget: the tightest in the chain, so a chunk sized for the first
  //    provider still fits whichever one ends up answering.
  const budget = Math.min(...providers.map(budgetFor));
  const systemTokens = Math.max(...providers.map((p) => estimateTokens(systemFor(p))));
  const history = trimHistory(a.turns, Math.floor(budget * HISTORY_SHARE));
  const historyTokens = history.reduce((n, t) => n + estimateTokens(t.content), 0);
  const docBudget = documentBudget({
    requestBudget: budget,
    systemTokens,
    historyTokens,
    answerReserve: ANSWER_RESERVE,
  });

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

  const primary = providers[0];
  yield {
    type: "meta",
    provider: primary.label,
    model: primary.model,
    search: modeFor(primary),
    parts: singlePass ? (docs.length ? 1 : 0) : chunks.length,
    chain: providers.map((p) => p.label),
  };

  // 5a. Everything fits: one streamed request.
  if (singlePass) {
    const framed = docs.map((d) => frameDocument(d.name, d.text)).join("\n\n");
    const last = [retrieved, framed, request].filter(Boolean).join("\n\n");
    const turns: Turn[] = [...history.slice(0, -1), { role: "user", content: last }];
    yield* withFailover(
      providers,
      "answering",
      stream((p) => ({
        system: systemFor(p),
        turns,
        effort: a.effort,
        research: modeFor(p) === "native",
        signal,
      })),
      signal,
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
    const content = [
      `The user's request, for context: ${request.slice(0, 2000)}`,
      frameDocument(chunk.name, chunk.text, { index: chunk.index, total: chunk.total }),
    ].join("\n\n");
    const result = yield* withFailover(
      providers,
      `reading part ${chunk.index + 1}`,
      complete((p) => ({
        system: `${systemFor(p)}\n\n## This step\n\n${CHUNK_DIRECTIVE[a.task]}`,
        turns: [{ role: "user", content }],
        effort: "medium",
        research: false,
        signal,
      })),
      signal,
    );
    notes.push(
      `### Notes from ${chunk.name}, part ${chunk.index + 1} of ${chunk.total}\n\n${result.text.trim()}`,
    );
  }

  // 5c. Reduce: one streamed request over the notes.
  yield { type: "progress", text: "Bringing it together…" };
  const last = [retrieved, notes.join("\n\n"), `---\n\n${request}`].filter(Boolean).join("\n\n");
  const turns: Turn[] = [...history.slice(0, -1), { role: "user", content: last }];
  yield* withFailover(
    providers,
    "writing the answer",
    stream((p) => ({
      system: `${systemFor(p)}\n\n## This step\n\n${synthesisDirective(a.task, chunks.length)}`,
      turns,
      effort: a.effort,
      research: modeFor(p) === "native",
      signal,
    })),
    signal,
  );
  if (retrievedSources.length) yield { type: "sources", sources: retrievedSources };
}
