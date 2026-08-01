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
  return raw || `${label} failed unexpectedly.`;
}
