import { PREFERENCE, PROVIDERS } from "./catalog";
import { geminiAdapter } from "./gemini";
import { openAiCompatAdapter } from "./openaiCompat";
import type { Adapter, ProviderId, ProviderStatus, ResolvedProvider } from "./types";

export * from "./types";
export { PROVIDERS, PREFERENCE } from "./catalog";
export { describeError } from "./util";

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
    return {
      ...spec,
      apiKey,
      model: process.env[spec.envModel]?.trim() || spec.defaultModel,
    };
  }
  return null;
}

export function adapterFor(id: ProviderId): Adapter {
  return id === "gemini" ? geminiAdapter : openAiCompatAdapter;
}

/** Safe to send to the browser — contains no key material. */
export function providerStatus(): ProviderStatus {
  const active = resolveProvider();
  const fallback = PROVIDERS.gemini;

  if (!active) {
    return {
      ready: false,
      id: fallback.id,
      label: fallback.label,
      model: fallback.defaultModel,
      supportsSearch: fallback.supportsSearch,
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
    supportsSearch: active.supportsSearch,
    pricing: active.pricing,
    console: active.console,
    envKey: active.envKey,
    configured: configuredProviders(),
  };
}
