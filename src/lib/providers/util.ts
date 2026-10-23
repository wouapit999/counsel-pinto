export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Turn a provider failure into something a user can act on. */
export function describeError(err: unknown, model: string, label: string): string {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  const raw = err instanceof Error ? err.message : String(err);

  const retryAfterMs =
    typeof err === "object" && err !== null && "retryAfterMs" in err
      ? Number((err as { retryAfterMs?: unknown }).retryAfterMs)
      : NaN;
  if (status === 402 && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return `${label}'s free lane is in use — it allows one request every 30 seconds per address, and that address is shared. Waiting for the next slot; a free key from ${label} removes the limit.`;
  }
  if (status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED|too many requests/i.test(raw)) {
    return `${label}'s rate limit was hit. Wait a minute and try again, or lower the analysis depth.`;
  }
  if (
    status === 401 ||
    status === 403 ||
    /api key|PERMISSION_DENIED|UNAUTHENTICATED|unauthorized|invalid.*token/i.test(raw)
  ) {
    return `${label} rejected the API key. Check it is correct and still active.`;
  }
  if (status === 404 || /not found|NOT_FOUND|does not exist|unknown model|decommissioned/i.test(raw)) {
    return `The model "${model}" is not available on ${label}. Set its model environment variable to one your account can use.`;
  }
  if (status === 402 || /insufficient|credit|billing|payment/i.test(raw)) {
    return `${label} reports insufficient credit for this request.`;
  }
  if (
    (typeof err === "object" && err !== null && (err as { transient?: boolean }).transient) ||
    (status !== undefined && status >= 500) ||
    /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|timed out|empty response|interrupted/i.test(raw)
  ) {
    return `${label} did not deliver an answer — it is busy or briefly unreachable. Nothing is wrong with the setup; try again in a moment.`;
  }
  return raw || `${label} failed unexpectedly.`;
}
