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
  error?: { message?: string; code?: string | number };
};

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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${spec.apiKey}`,
  };
  // OpenRouter attributes traffic with these; harmless elsewhere.
  if (spec.id === "openrouter") {
    headers["HTTP-Referer"] = "https://counsel-pinto.vercel.app";
    headers["X-Title"] = "Counsel Pinto";
  }

  const res = await fetch(`${spec.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal: args.signal,
    body: JSON.stringify({
      model: spec.model,
      stream: true,
      max_tokens: 8192,
      messages: [
        { role: "system", content: args.system },
        ...args.turns.map((t) => ({ role: t.role, content: t.content })),
      ],
      ...(spec.supportsReasoningEffort || spec.reasoningModels?.test(spec.model)
        ? { reasoning_effort: REASONING[args.effort] ?? "medium" }
        : {}),
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

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

      if (chunk.error?.message) {
        throw new Error(chunk.error.message);
      }

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

  if (announced) yield { type: "searching", active: false };
  if (sources.size > 0) yield { type: "sources", sources: [...sources.values()] };
  if (!produced) {
    yield {
      type: "notice",
      text: `${spec.label} returned an empty response. Rephrase the question, or try a different model.`,
    };
  }
};

/**
 * What this key can actually use. Called when a configured model ID is
 * rejected, so the error can say what to switch to instead of just "no".
 */
export async function listModels(spec: ResolvedProvider): Promise<string[]> {
  const res = await fetch(`${spec.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${spec.apiKey}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: { id?: string }[] };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}
