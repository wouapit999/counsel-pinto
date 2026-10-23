import type { EffortId, Source } from "@/lib/counsel";
import { hostOf } from "./util";
import type { Adapter, ResolvedProvider } from "./types";

/**
 * One adapter for every provider that speaks OpenAI's /chat/completions:
 * Groq, Cerebras, Mistral, OpenRouter, GitHub Models and Perplexity.
 *
 * Written against fetch rather than the openai SDK — the surface used here is
 * small, and it keeps a dependency out of the bundle.
 */

const REASONING: Record<EffortId, string> = {
  medium: "low",
  high: "medium",
  xhigh: "high",
};

type SearchResult = { title?: string; url?: string };

/** Groq's compound systems report what they ran in `executed_tools`. */
type ExecutedTool = {
  type?: string;
  output?: unknown;
  search_results?: { results?: SearchResult[] } | SearchResult[];
};

type Delta = { content?: string | null; executed_tools?: ExecutedTool[] };
type Choice = {
  delta?: Delta;
  message?: { content?: string; executed_tools?: ExecutedTool[] };
};

type Chunk = {
  choices?: Choice[];
  /** Perplexity: bare URLs. */
  citations?: string[];
  /** Perplexity: richer form, preferred when present. */
  search_results?: SearchResult[];
  /** OpenAI shape is an object; some gateways put a bare string here. */
  error?: { message?: string; code?: string | number } | string;
};

function errorText(e: Chunk["error"]): string | undefined {
  return typeof e === "string" ? e : e?.message;
}

/**
 * How long to wait for the first byte, and then between bytes. Shared public
 * endpoints (Pollinations) take 20–60s to start under load and sometimes
 * open a stream and never finish it; without a cap such a request would sit
 * for the function's whole lifetime instead of being retried.
 */
const FIRST_BYTE_MS = 70_000;
const IDLE_MS = 45_000;

/**
 * A failure that says nothing about the key, the model or the quota — the
 * provider was simply unable to answer this time. The chain retries these on
 * the same provider before moving on.
 */
export function transient(message: string, status?: number) {
  return Object.assign(new Error(message), { transient: true, status });
}

/** API root for this request: the keyed one when a key is present and the provider has one. */
function rootFor(spec: ResolvedProvider): string {
  return spec.apiKey && spec.keyedBaseUrl ? spec.keyedBaseUrl : spec.baseUrl;
}

function chatUrlFor(spec: ResolvedProvider): string {
  if (spec.apiKey && spec.keyedBaseUrl) return `${spec.keyedBaseUrl}/chat/completions`;
  return spec.chatUrl ?? `${spec.baseUrl}/chat/completions`;
}

function add(into: Map<string, Source>, url?: string, title?: string) {
  if (!url || into.has(url)) return;
  into.set(url, { title: title || hostOf(url), url, host: hostOf(url) });
}

/**
 * Providers disagree about where citations live, so check every shape we
 * know of. Anything unrecognised is ignored rather than guessed at — a
 * missing source chip is survivable, a fabricated one is not.
 */
function collect(chunk: Chunk, into: Map<string, Source>) {
  for (const r of chunk.search_results ?? []) add(into, r.url, r.title);
  for (const url of chunk.citations ?? []) add(into, url);

  for (const choice of chunk.choices ?? []) {
    const tools = choice.delta?.executed_tools ?? choice.message?.executed_tools ?? [];
    for (const tool of tools) {
      const raw = tool.search_results;
      const results = Array.isArray(raw) ? raw : (raw?.results ?? []);
      for (const r of results) add(into, r.url, r.title);
    }
  }
}

export const openAiCompatAdapter: Adapter = async function* (spec, args) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // A keyless provider gets no Authorization header at all — an empty
  // bearer is rejected by some servers, and a present key (paid tier) is sent.
  if (spec.apiKey) headers.Authorization = `Bearer ${spec.apiKey}`;
  // OpenRouter attributes traffic with these; harmless elsewhere.
  if (spec.id === "openrouter") {
    headers["HTTP-Referer"] = "https://counsel-pinto.vercel.app";
    headers["X-Title"] = "Counsel Pinto";
  }

  // One controller for both the caller's cancel and our own stall timer. A
  // stall is reported as a transient failure, never as the user's abort.
  const ctl = new AbortController();
  let stalled = false;
  const onAbort = () => ctl.abort();
  if (args.signal?.aborted) ctl.abort();
  else args.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctl.abort();
    }, ms);
  };
  const disarm = () => {
    if (timer) clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  };
  const stall = (what: string) =>
    transient(`${spec.label} ${what} — it is busy; the request will be retried.`);

  arm(FIRST_BYTE_MS);
  let res: Response;
  try {
    res = await fetch(chatUrlFor(spec), {
      method: "POST",
      headers,
      signal: ctl.signal,
      body: JSON.stringify({
        model: spec.model,
        messages: [
          { role: "system", content: args.system },
          ...args.turns.map((t) => ({ role: t.role, content: t.content })),
        ],
        // The plain-reply style sends what the portal widget sends and no
        // more: no stream flag, no max_tokens, no reasoning knob. The fewer
        // options a shared free lane has to honour, the fewer ways it fails.
        ...(spec.requestStyle === "json" ? {} : { stream: true, max_tokens: 8192 }),
        ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
        ...(spec.supportsReasoningEffort || spec.reasoningModels?.test(spec.model)
          ? { reasoning_effort: REASONING[args.effort] ?? "medium" }
          : {}),
      }),
    });
  } catch (err) {
    disarm();
    if (stalled) throw stall(`sent nothing for ${FIRST_BYTE_MS / 1000}s`);
    if (args.signal?.aborted) throw err;
    // DNS, TLS, reset — the provider was never reached. Retryable.
    throw transient(`${spec.label} could not be reached: ${(err as Error)?.message ?? String(err)}`);
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    disarm();
    let message = detail.slice(0, 400);
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* not JSON — the raw body is the best we have */
    }
    // Providers say how long to wait — Groq puts "try again in 7.5s" in the
    // body, others use a Retry-After header. Pass it up so the chain can wait
    // exactly that long instead of guessing.
    const header = Number(res.headers.get("retry-after"));
    const m = /try again in\s*([\d.]+)\s*(ms|s|m)\b/i.exec(detail);
    const fromBody = m
      ? Number(m[1]) * (m[2] === "ms" ? 1 : m[2] === "m" ? 60_000 : 1000)
      : NaN;
    const retryAfterMs = [header * 1000, fromBody].find((n) => Number.isFinite(n) && n > 0);
    throw Object.assign(new Error(message || `HTTP ${res.status}`), {
      status: res.status,
      retryAfterMs,
    });
  }

  const sources = new Map<string, Source>();
  let produced = false;
  let announced = spec.canSearch && args.research;
  if (announced) yield { type: "searching", active: true };

  // A gateway that ignores `stream: true` answers with one JSON document.
  // Read it as such rather than scanning it for "data:" lines and finding none.
  if (/application\/json/i.test(res.headers.get("content-type") ?? "")) {
    let body: Chunk;
    try {
      body = (await res.json()) as Chunk;
    } catch (err) {
      disarm();
      if (stalled) throw stall("stopped mid-response");
      throw err;
    }
    disarm();
    const msg = errorText(body.error);
    if (msg) throw transient(msg);
    collect(body, sources);
    const text = body.choices?.[0]?.message?.content ?? "";
    if (announced) yield { type: "searching", active: false };
    if (sources.size > 0) yield { type: "sources", sources: [...sources.values()] };
    if (!text) throw transient(`${spec.label} returned an empty response.`);
    yield { type: "text", text };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      arm(IDLE_MS);
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch (err) {
        if (stalled) {
          throw stall(produced ? "stopped mid-answer" : `went silent for ${IDLE_MS / 1000}s`);
        }
        throw err;
      }
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });

      // SSE frames are separated by a blank line, but many providers emit one
      // "data:" line per newline — splitting on newline handles both.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk: Chunk;
        try {
          chunk = JSON.parse(payload) as Chunk;
        } catch {
          continue; // partial frame; the next read completes it
        }

        // An error frame inside a 200 stream is the gateway's upstream
        // failing, so it is retryable — unless its wording says quota or key,
        // which the chain's classifier checks first.
        const msg = errorText(chunk.error);
        if (msg) throw transient(msg);

        collect(chunk, sources);

        const text = chunk.choices?.[0]?.delta?.content;
        if (text) {
          if (announced) {
            announced = false;
            yield { type: "searching", active: false };
          }
          produced = true;
          yield { type: "text", text };
        }
      }
    }
  } finally {
    disarm();
  }

  if (announced) yield { type: "searching", active: false };
  if (sources.size > 0) yield { type: "sources", sources: [...sources.values()] };
  // A stream that closed cleanly with no content is the provider failing
  // quietly — under load Pollinations does exactly this. Thrown, not shown,
  // so the chain retries it instead of leaving the user with a blank answer.
  if (!produced) throw transient(`${spec.label} returned an empty response.`);
};

/**
 * Which of a provider's models to use when the configured one is gone.
 * Strongest general-purpose families first; anything that is not a chat
 * model (embeddings, guards, vision, code, speech) is never chosen.
 */
const PREFERRED: RegExp[] = [
  /deepseek.*v4.*pro/i,
  /deepseek.*v3\.2/i,
  /deepseek.*v3\.1/i,
  /deepseek.*v3(?!.*coder)/i,
  /deepseek.*chat/i,
  /gpt-oss-120b/i,
  /llama.*3\.3.*70b/i,
  /nemotron.*(ultra|super|70b)/i,
  /llama.*405b/i,
  /qwen.*(235b|72b|3\.[5-9])/i,
  /kimi-k[2-9]/i,
  /mistral-large/i,
  /gemma-4/i,
  /minimax-m[2-9]/i,
  /llama.*70b/i,
  /deepseek/i,
  /llama/i,
];

const NOT_A_CHAT_MODEL =
  /embed|guard|safety|moderation|whisper|tts|speech|audio|vision|vlm|-vl-|rerank|coder|codestral|starcoder|codegemma|codellama|diffusion|detector|kosmos|fuyu|deplot|omni|reason2|calibration|robot|synthetic/i;

export function chooseModel(ids: string[], current?: string): string | null {
  const pool = ids.filter((id) => id !== current && !NOT_A_CHAT_MODEL.test(id));
  for (const re of PREFERRED) {
    const hit = pool.find((id) => re.test(id));
    if (hit) return hit;
  }
  return pool[0] ?? null;
}

/**
 * What this key can actually use. Called when a configured model ID is
 * rejected, so the chain can switch to something that exists.
 */
export async function listModels(spec: ResolvedProvider): Promise<string[]> {
  const res = await fetch(`${rootFor(spec)}/models`, {
    headers: spec.apiKey ? { Authorization: `Bearer ${spec.apiKey}` } : {},
  });
  if (!res.ok) return [];
  // OpenAI shape is {data:[{id}]}; Pollinations returns a bare [{name}].
  const json = (await res.json()) as
    | { data?: { id?: string }[] }
    | { id?: string; name?: string }[];
  const items = Array.isArray(json) ? json : (json.data ?? []);
  return items
    .map((m) => ("id" in m && m.id) || ("name" in m ? m.name : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}
