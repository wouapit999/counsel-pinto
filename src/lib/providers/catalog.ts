import type { ProviderId, ProviderSpec } from "./types";

/**
 * Providers, best-first.
 *
 * Search is what makes a legal answer checkable, and it is scarce among free
 * tiers. Groq's `compound` systems are the free option that has it: they run
 * web search server-side and report what they used. Everything else free here
 * answers from training data, in which case the prompt is switched to an
 * explicit no-web-access directive so the model does not invent citations.
 *
 * Model IDs drift. Every one is overridable through its `envModel` variable,
 * and a stale ID surfaces as "model not available", not a crash.
 */
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  groq: {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    envModel: "GROQ_MODEL",
    // llama-3.3-70b-versatile was retired from the free tier on 2026-08-16;
    // gpt-oss-120b is Groq's recommended general replacement. Set
    // GROQ_MODEL=groq/compound to turn search on instead.
    defaultModel: "openai/gpt-oss-120b",
    searchModels: /compound/i,
    // gpt-oss accepts reasoning_effort, so Analysis depth works on it.
    reasoningModels: /gpt-oss/i,
    console: "https://console.groq.com/keys",
    pricing: "Free tier, no card required. Very fast.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://api.groq.com/openai/v1",
    // gpt-oss-120b's free tier is ~8k tokens/minute, and the system prompt
    // alone is ~2.5k, so two requests in a minute can trip it. Keep each
    // request well inside the cap.
    requestBudget: 5500,
  },
  sambanova: {
    id: "sambanova",
    label: "SambaNova",
    envKey: "SAMBANOVA_API_KEY",
    envModel: "SAMBANOVA_MODEL",
    // Serves DeepSeek V3 on its free tier — the free way to get DeepSeek.
    defaultModel: "DeepSeek-V3-0324",
    console: "https://cloud.sambanova.ai/apis",
    pricing: "Free tier, no card. Fast.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://api.sambanova.ai/v1",
    requestBudget: 16000,
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    envKey: "NVIDIA_API_KEY",
    envModel: "NVIDIA_MODEL",
    defaultModel: "meta/llama-3.3-70b-instruct",
    console: "https://build.nvidia.com",
    pricing: "Free with an NVIDIA developer account, rate-limited.",
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    requestBudget: 16000,
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
    requestBudget: 24000,
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
    requestBudget: 30000,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    envModel: "OPENROUTER_MODEL",
    // ":free" variants cost nothing but are rate-limited and rotate often.
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    // The ":online" suffix adds web search, but it is billed per result.
    searchModels: /:online$/i,
    console: "https://openrouter.ai/keys",
    pricing: 'Free on ":free" models; paid for the rest.',
    free: true,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://openrouter.ai/api/v1",
    // ":free" models vary widely; assume the tighter end.
    requestBudget: 12000,
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
    // GitHub Models caps input around 8k on the free tier.
    requestBudget: 7000,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    envModel: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-chat",
    console: "https://platform.deepseek.com/api_keys",
    // Direct access needs a top-up. The free routes to DeepSeek models are
    // SambaNova above and OpenRouter's ":free" variants.
    pricing: "Paid but very cheap; needs a top-up. Free via SambaNova or OpenRouter instead.",
    free: false,
    supportsSearch: false,
    supportsReasoningEffort: false,
    baseUrl: "https://api.deepseek.com/v1",
    requestBudget: 60000,
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
    requestBudget: 60000,
  },
};

/**
 * Try order. Also the failover order: when one provider's free tier is
 * exhausted the request moves to the next. Free and capable first; paid last,
 * so a top-up is only spent once every free tier is out.
 */
export const PREFERENCE: ProviderId[] = [
  "groq",
  "sambanova",
  "nvidia",
  "cerebras",
  "mistral",
  "openrouter",
  "github",
  "perplexity",
  "deepseek",
];

/** Does this specific model retrieve live sources? */
export function modelCanSearch(spec: ProviderSpec, model: string): boolean {
  return spec.supportsSearch || (spec.searchModels?.test(model) ?? false);
}
