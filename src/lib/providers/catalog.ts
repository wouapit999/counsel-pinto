import type { ProviderId, ProviderSpec } from "./types";

/**
 * Providers, best-first.
 *
 * Only Gemini and Perplexity can retrieve live sources. The rest answer from
 * training data alone, which for a legal app means the answers age badly —
 * the UI disables the search toggle and the prompt is told to be franker about
 * currency when one of those is active.
 *
 * Model IDs drift. Every one of these is overridable through its `envModel`
 * variable, and a wrong ID surfaces as a clear "model not available" message
 * rather than a crash.
 */
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    envModel: "GEMINI_MODEL",
    defaultModel: "gemini-flash-latest",
    console: "https://aistudio.google.com/apikey",
    pricing: "Free tier, no card required.",
    free: true,
    supportsSearch: true,
    supportsReasoningEffort: false,
  },
  groq: {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    envModel: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile",
    console: "https://console.groq.com/keys",
    pricing: "Free tier, no card required. Very fast.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://api.groq.com/openai/v1",
  },
  cerebras: {
    id: "cerebras",
    label: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    envModel: "CEREBRAS_MODEL",
    defaultModel: "llama-3.3-70b",
    console: "https://cloud.cerebras.ai",
    pricing: "Free tier, no card required. Very fast.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://api.cerebras.ai/v1",
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    envKey: "MISTRAL_API_KEY",
    envModel: "MISTRAL_MODEL",
    defaultModel: "mistral-large-latest",
    console: "https://console.mistral.ai/api-keys",
    pricing: "Free experimental tier.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://api.mistral.ai/v1",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    envModel: "OPENROUTER_MODEL",
    // ":free" variants cost nothing but are rate-limited and rotate often.
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    console: "https://openrouter.ai/keys",
    pricing: "Free on \":free\" models; paid for the rest.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://openrouter.ai/api/v1",
  },
  github: {
    id: "github",
    label: "GitHub Models",
    envKey: "GITHUB_MODELS_TOKEN",
    envModel: "GITHUB_MODELS_MODEL",
    defaultModel: "openai/gpt-4o-mini",
    console: "https://github.com/settings/tokens",
    pricing: "Free with a GitHub account, rate-limited.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://models.github.ai/inference",
  },
  perplexity: {
    id: "perplexity",
    label: "Perplexity",
    envKey: "PERPLEXITY_API_KEY",
    envModel: "PERPLEXITY_MODEL",
    defaultModel: "sonar-pro",
    console: "https://www.perplexity.ai/settings/api",
    pricing: "Paid. Pro subscribers get a monthly API credit.",
    free: false,
    supportsSearch: true,
    supportsReasoningEffort: true,
    baseUrl: "https://api.perplexity.ai",
  },
};

/** Preference order when AI_PROVIDER is not set: searchers first, then free. */
export const PREFERENCE: ProviderId[] = [
  "gemini",
  "perplexity",
  "groq",
  "cerebras",
  "mistral",
  "openrouter",
  "github",
];
