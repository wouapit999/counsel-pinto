import { PREFERENCE, PROVIDERS, modelCanSearch } from "./catalog";
import { openAiCompatAdapter } from "./openaiCompat";
import type { Adapter, ProviderId, ProviderStatus, ResolvedProvider } from "./types";

export * from "./types";
export { PROVIDERS, PREFERENCE, modelCanSearch } from "./catalog";
export { describeError } from "./util";

/** The provider suggested when nothing is configured yet. */
export const DEFAULT_PROVIDER: ProviderId = "groq";

function keyFor(id: ProviderId): string | undefined {
  const value = process.env[PROVIDERS[id].envKey];
  return value && value.trim() ? value.trim() : undefined;
}

/** Every provider that has a key present. */
export function configuredProviders(): ProviderId[] {
  return PREFERENCE.filter((id) => keyFor(id) !== undefined);
}

/**
 * Which provider to use. AI_PROVIDER pins one explicitly; otherwise the first
 * configured provider in preference order wins, so adding a key is all it
 * takes to switch. Returns null when nothing is configured — the caller turns
 * that into setup guidance rather than an error.
 */
export function resolveProvider(): ResolvedProvider | null {
  const pinned = process.env.AI_PROVIDER?.trim().toLowerCase() as ProviderId | undefined;

  const candidates: ProviderId[] =
    pinned && pinned in PROVIDERS ? [pinned] : configuredProviders();

  for (const id of candidates) {
    const apiKey = keyFor(id);
    if (!apiKey) continue;
    const spec = PROVIDERS[id];
    const model = process.env[spec.envModel]?.trim() || spec.defaultModel;
    return { ...spec, apiKey, model, canSearch: modelCanSearch(spec, model) };
  }
  return null;
}

/**
 * Every supported provider speaks OpenAI's /chat/completions, so one adapter
 * serves them all. If a provider with a native protocol is added, dispatch on
 * `provider.id` here.
 */
export const streamCompletion: Adapter = openAiCompatAdapter;

/** Safe to send to the browser — contains no key material. */
export function providerStatus(): ProviderStatus {
  const active = resolveProvider();

  if (!active) {
    const fallback = PROVIDERS[DEFAULT_PROVIDER];
    return {
      ready: false,
      id: fallback.id,
      label: fallback.label,
      model: fallback.defaultModel,
      supportsSearch: false,
      pricing: fallback.pricing,
      console: fallback.console,
      envKey: fallback.envKey,
      configured: [],
    };
  }

  return {
    ready: true,
    id: active.id,
    label: active.label,
    model: active.model,
    supportsSearch: active.canSearch,
    pricing: active.pricing,
    console: active.console,
    envKey: active.envKey,
    configured: configuredProviders(),
  };
}
