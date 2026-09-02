/**
 * Token arithmetic without a tokenizer.
 *
 * Every provider tokenises differently, and shipping a tokenizer per model
 * would be heavy for what is only a budgeting decision. A conservative
 * characters-per-token ratio errs toward smaller chunks, which is the safe
 * direction: an over-estimate costs one extra round-trip, an under-estimate
 * costs a 413 mid-review.
 *
 * French and Portuguese legal text tokenises less efficiently than English
 * (accents, longer words), hence 3.5 rather than the usual 4.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

/**
 * Matches the start of a clause, article or section, in the three working
 * languages. Used to prefer splitting a contract at a boundary a lawyer
 * would recognise rather than mid-sentence.
 */
const CLAUSE_START =
  /^\s*(?:(?:article|artigo|clause|cláusula|section|secção|seção|chapitre|chapter|capítulo|titre|title|título|annex|annexe|anexo|schedule)\b|\d+(?:\.\d+)*[.)]?\s|[ivxlc]+[.)]\s|\([a-z0-9]+\)\s)/i;

export type Chunk = {
  index: number;
  total: number;
  text: string;
  /** Approximate token count of `text`. */
  tokens: number;
};

/**
 * Split a document into chunks that each fit `maxTokens`, cutting at clause
 * boundaries where possible and carrying `overlapTokens` of trailing context
 * into the next chunk so a clause split across two chunks is still read
 * whole at least once.
 */
export function chunkDocument(
  text: string,
  maxTokens: number,
  overlapTokens = Math.floor(maxTokens * 0.08),
): Chunk[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  if (estimateTokens(clean) <= maxTokens) {
    return [{ index: 0, total: 1, text: clean, tokens: estimateTokens(clean) }];
  }

  // Paragraph units; a clause heading is kept with what follows it so it
  // never gets orphaned at the tail of the previous chunk.
  const units = clean
    .split(/\n{2,}/)
    .flatMap((p) => splitOversized(p, maxTokens))
    .filter((u) => u.trim());

  const bodies: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    bodies.push(current.join("\n\n"));
    // Carry the tail forward as overlap.
    const carried: string[] = [];
    let carriedTokens = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const t = estimateTokens(current[i]);
      if (carriedTokens + t > overlapTokens) break;
      carried.unshift(current[i]);
      carriedTokens += t;
    }
    current = carried;
    currentTokens = carriedTokens;
  };

  for (const unit of units) {
    const t = estimateTokens(unit);
    const startsClause = CLAUSE_START.test(unit);
    // Prefer to break just before a clause heading once past 70% full.
    if (
      currentTokens + t > maxTokens ||
      (startsClause && currentTokens > maxTokens * 0.7 && current.length > 0)
    ) {
      flush();
    }
    current.push(unit);
    currentTokens += t;
  }
  if (current.length > 0) bodies.push(current.join("\n\n"));

  return bodies.map((body, index) => ({
    index,
    total: bodies.length,
    text: body,
    tokens: estimateTokens(body),
  }));
}

/** A single paragraph larger than the budget is cut at sentence ends. */
function splitOversized(paragraph: string, maxTokens: number): string[] {
  if (estimateTokens(paragraph) <= maxTokens) return [paragraph];
  const limit = tokensToChars(maxTokens);
  const sentences =
    paragraph.match(/[^.!?;]+[.!?;]+["')\]]*\s*|[^.!?;]+$/g) ?? [paragraph];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > limit && buf) {
      out.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  // A single sentence longer than the limit — hard cut, last resort.
  return out.flatMap((s) =>
    s.length <= limit ? [s] : (s.match(new RegExp(`.{1,${limit}}`, "gs")) ?? [s]),
  );
}

/**
 * How much of the request budget is left for a document after the system
 * prompt, the conversation and headroom for the answer are accounted for.
 */
export function documentBudget(opts: {
  requestBudget: number;
  systemTokens: number;
  historyTokens: number;
  answerReserve: number;
}): number {
  const left =
    opts.requestBudget - opts.systemTokens - opts.historyTokens - opts.answerReserve;
  // A floor, so a tight budget never produces absurdly many chunks.
  return Math.max(left, 1200);
}
