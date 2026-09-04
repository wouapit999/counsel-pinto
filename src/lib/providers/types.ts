import type { EffortId, Source } from "@/lib/counsel";

/** Every provider the app knows how to talk to. */
export type ProviderId =
  | "groq"
  | "sambanova"
  | "nvidia"
  | "cerebras"
  | "mistral"
  | "openrouter"
  | "github"
  | "deepseek"
  | "perplexity";

export type Turn = { role: "user" | "assistant"; content: string };

export type StreamArgs = {
  system: string;
  turns: Turn[];
  effort: EffortId;
  /** Only honoured when the provider can actually search. */
  research: boolean;
  signal?: AbortSignal;
};

/** What an adapter emits. The route serialises these straight to the client. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "searching"; active: boolean }
  | { type: "sources"; sources: Source[] }
  | { type: "notice"; text: string };

export type Adapter = (
  spec: ResolvedProvider,
  args: StreamArgs,
) => AsyncGenerator<StreamEvent>;

/** Static description of a provider — no secrets, safe to send to the client. */
export type ProviderSpec = {
  id: ProviderId;
  label: string;
  /** Environment variable holding the key. */
  envKey: string;
  /** Overrides the default model, e.g. GROQ_MODEL. */
  envModel: string;
  defaultModel: string;
  /** Where to get a key. */
  console: string;
  /** Honest one-liner about cost. */
  pricing: string;
  free: boolean;
  /** True when every model on this provider retrieves live sources. */
  supportsSearch: boolean;
  /**
   * Some providers only search on particular models — Groq's compound
   * systems, for instance. Capability is therefore a property of the
   * resolved model, not of the provider alone.
   */
  searchModels?: RegExp;
  /** Does every model on this provider accept OpenAI's `reasoning_effort`? */
  supportsReasoningEffort: boolean;
  /** Models that accept it when the provider as a whole does not. */
  reasoningModels?: RegExp;
  baseUrl: string;
  /**
   * Practical per-request input budget in tokens. Not the model's context
   * window — the free tier's tokens-per-minute cap usually binds first, and
   * blowing it mid-review returns a 429 rather than an answer. Overridable
   * with AI_BUDGET_TOKENS.
   */
  requestBudget: number;
};

export type ResolvedProvider = ProviderSpec & {
  apiKey: string;
  model: string;
  /** Whether *this* model can search. Use this, not `supportsSearch`. */
  canSearch: boolean;
};

/** Shape returned by /api/config — never includes the key itself. */
export type ProviderStatus = {
  ready: boolean;
  id: ProviderId;
  label: string;
  model: string;
  supportsSearch: boolean;
  pricing: string;
  console: string;
  envKey: string;
  /** Providers with a key present, so the UI can say what else is available. */
  configured: ProviderId[];
  /**
   * How answers can reach the web. `native` = the model searches itself;
   * `tavily`/`brave` = we search and hand results in; null = no web access.
   */
  search: { mode: "native" | "tavily" | "brave" | null; label: string };
  /**
   * Every configured provider, in the order the app will try them. A rate
   * limit on one hands the request to the next, so the chain is what
   * "never runs out" actually means.
   */
  chain: { id: ProviderId; label: string; model: string }[];
  /**
   * Which deployment answered. When a user reports "no provider configured"
   * this is what tells us whether they are on the wrong URL, on a Preview
   * build that cannot see Production variables, or truly keyless.
   */
  deployment: { url: string | null; env: string | null; commit: string | null };
  /** Every environment variable name the app looked for. Names only. */
  checked: string[];
};
