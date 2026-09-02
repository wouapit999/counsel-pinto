/**
 * Web search that does not depend on the model provider.
 *
 * Models without native retrieval (most free tiers) get grounded answers by
 * running the search here and handing the results in as context. Two
 * backends, both with real free tiers and proper APIs — no scraping.
 */

export type SearchHit = {
  title: string;
  url: string;
  host: string;
  snippet: string;
};

export type SearchBackend = "tavily" | "brave";

export const SEARCH_BACKENDS: Record<
  SearchBackend,
  { label: string; envKey: string; console: string; pricing: string }
> = {
  tavily: {
    label: "Tavily",
    envKey: "TAVILY_API_KEY",
    console: "https://app.tavily.com",
    pricing: "Free tier (1,000 searches/month), no card.",
  },
  brave: {
    label: "Brave Search",
    envKey: "BRAVE_SEARCH_API_KEY",
    console: "https://api.search.brave.com",
    pricing: "Free tier (2,000 searches/month).",
  },
};

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Which backend is configured, if any. Tavily first — its results carry more text. */
export function searchBackend(): SearchBackend | null {
  if (process.env.TAVILY_API_KEY?.trim()) return "tavily";
  if (process.env.BRAVE_SEARCH_API_KEY?.trim()) return "brave";
  return null;
}

async function tavily(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: limit,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (data.results ?? [])
    .filter((r): r is { title?: string; url: string; content?: string } => !!r.url)
    .map((r) => ({
      title: r.title || hostOf(r.url),
      url: r.url,
      host: hostOf(r.url),
      snippet: (r.content ?? "").slice(0, 1200),
    }));
}

async function brave(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY ?? "",
    },
    signal,
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (data.web?.results ?? [])
    .filter((r): r is { title?: string; url: string; description?: string } => !!r.url)
    .map((r) => ({
      title: r.title || hostOf(r.url),
      url: r.url,
      host: hostOf(r.url),
      snippet: (r.description ?? "").slice(0, 1200),
    }));
}

export async function searchWeb(
  query: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const backend = searchBackend();
  if (!backend) return [];
  return backend === "tavily" ? tavily(query, limit, signal) : brave(query, limit, signal);
}

/** Gazettes, regulators, courts and ministries in the three jurisdictions. */
const OFFICIAL =
  /(\.gov\b|\.gouv\.|ohada\.(org|com)|beac\.int|cobac|gabac|bancomoc\.mz|\.gov\.mz|\.gov\.cm|journal-?officiel|legis|assemblee|assembleia|senat|tribunal|cour[.-]|court\.|ministere|ministerio|ministry|cemac)/i;

/**
 * Run several queries, merge, de-duplicate by URL, and float official
 * sources to the top. Legal answers should lean on gazettes and regulators,
 * not commentary.
 */
export async function searchMany(
  queries: string[],
  perQuery = 4,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const settled = await Promise.allSettled(
    queries.map((q) => searchWeb(q, perQuery, signal)),
  );
  const seen = new Map<string, SearchHit>();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const hit of r.value) if (!seen.has(hit.url)) seen.set(hit.url, hit);
  }
  return [...seen.values()].sort(
    (a, b) => Number(OFFICIAL.test(b.host)) - Number(OFFICIAL.test(a.host)),
  );
}

/** Render hits as a context block the model can cite from. */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map(
    (h, i) => `[${i + 1}] ${h.title} — ${h.host}\n${h.url}\n${h.snippet}`,
  );
  return `## Retrieved sources\n\nThese were retrieved by web search just now. Cite them by number, e.g. [2], wherever you rely on them. Never cite a number that is not in this list, and never invent a source.\n\n${lines.join("\n\n")}`;
}
