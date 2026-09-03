import { SEARCH_BACKENDS, searchBackend } from "@/lib/search";
import { PREFERENCE, PROVIDERS, modelCanSearch } from "./catalog";
import { chooseModel, listModels, openAiCompatAdapter } from "./openaiCompat";
import type { Adapter, ProviderId, ProviderStatus, ResolvedProvider } from "./types";

export * from "./types";
export { PROVIDERS, PREFERENCE, modelCanSearch } from "./catalog";
export { describeError } from "./util";
export { listModels, chooseModel };

/**
 * Models discovered at runtime after the configured one was rejected. Kept
 * for the life of the instance so later requests skip the 404 round-trip.
 * An explicit env override always wins over a remembered discovery.
 */
const discovered = new Map<ProviderId, string>();

export function rememberModel(id: ProviderId, model: string) {
  discovered.set(id, model);
}

/** The provider suggested when nothing is configured yet. */
export const DEFAULT_PROVIDER: ProviderId = "groq";

/**
 * Providers that recently hit a rate limit, with the time the limit is
 * expected to have reset. Module-level, so it survives across requests on a
 * warm serverless instance; a cold start simply forgets, which is harmless.
 */
const cooldown = new Map<ProviderId, number>();

export function markExhausted(id: ProviderId, ms: number) {
  cooldown.set(id, Date.now() + ms);
}

function coolingDown(id: ProviderId): boolean {
  return (cooldown.get(id) ?? 0) > Date.now();
}

function keyFor(id: ProviderId): string | undefined {
  const value = process.env[PROVIDERS[id].envKey];
  return value && value.trim() ? value.trim() : undefined;
}

function resolve(id: ProviderId): ResolvedProvider | null {
  const apiKey = keyFor(id);
  if (!apiKey) return null;
  const spec = PROVIDERS[id];
  const model =
    process.env[spec.envModel]?.trim() || discovered.get(id) || spec.defaultModel;
  return { ...spec, apiKey, model, canSearch: modelCanSearch(spec, model) };
}

/** Every provider with a key, in try order. AI_PROVIDER moves one to the front. */
export function configuredProviders(): ProviderId[] {
  const pinned = process.env.AI_PROVIDER?.trim().toLowerCase() as ProviderId | undefined;
  const order =
    pinned && pinned in PROVIDERS ? [pinned, ...PREFERENCE.filter((p) => p !== pinned)] : PREFERENCE;
  return order.filter((id) => keyFor(id) !== undefined);
}

/**
 * The failover chain. Providers known to be rate-limited right now are moved
 * to the back rather than dropped — if everything is limited, the app still
 * has something to retry against after a wait.
 */
export function resolveProviders(): ResolvedProvider[] {
  const all = configuredProviders()
    .map(resolve)
    .filter((p): p is ResolvedProvider => p !== null);
  const ready = all.filter((p) => !coolingDown(p.id));
  const cooling = all.filter((p) => coolingDown(p.id));
  return [...ready, ...cooling];
}

/** The provider that will be tried first, or null when nothing is configured. */
export function resolveProvider(): ResolvedProvider | null {
  return resolveProviders()[0] ?? null;
}

/**
 * Every supported provider speaks OpenAI's /chat/completions, so one adapter
 * serves them all. If a provider with a native protocol is added, dispatch on
 * `provider.id` here.
 */
export const streamCompletion: Adapter = openAiCompatAdapter;

/** How this deployment can reach the web, given the active model. */
function searchStatus(active: ResolvedProvider | null): ProviderStatus["search"] {
  if (active?.canSearch) return { mode: "native", label: `${active.label} searches directly` };
  const backend = searchBackend();
  if (backend) return { mode: backend, label: `via ${SEARCH_BACKENDS[backend].label}` };
  return { mode: null, label: "no web access" };
}

/** Safe to send to the browser — contains no key material. */
export function providerStatus(): ProviderStatus {
  const chain = resolveProviders();
  const active = chain[0] ?? null;
  const search = searchStatus(active);

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
      search,
      chain: [],
    };
  }

  return {
    ready: true,
    id: active.id,
    label: active.label,
    model: active.model,
    // Either the model searches itself or we search for it — both count.
    supportsSearch: search.mode !== null,
    pricing: active.pricing,
    console: active.console,
    envKey: active.envKey,
    configured: chain.map((p) => p.id),
    search,
    chain: chain.map((p) => ({ id: p.id, label: p.label, model: p.model })),
  };
}
