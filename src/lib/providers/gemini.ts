import { GoogleGenAI, ThinkingLevel, type GroundingMetadata } from "@google/genai";
import type { EffortId, Source } from "@/lib/counsel";
import { hostOf } from "./util";
import type { Adapter } from "./types";

/**
 * thinkingLevel rather than thinkingBudget: budgets are model-dependent and
 * are rejected outright by Gemini 3.5 and newer, so a model bump would
 * otherwise break the app.
 */
const THINKING: Record<EffortId, ThinkingLevel> = {
  medium: ThinkingLevel.LOW,
  high: ThinkingLevel.MEDIUM,
  xhigh: ThinkingLevel.HIGH,
};

function collect(meta: GroundingMetadata | undefined, into: Map<string, Source>) {
  for (const chunk of meta?.groundingChunks ?? []) {
    const web = chunk.web;
    if (!web?.uri || into.has(web.uri)) continue;
    into.set(web.uri, {
      title: web.title || web.domain || hostOf(web.uri),
      url: web.uri,
      host: web.domain || hostOf(web.uri),
    });
  }
}

export const geminiAdapter: Adapter = async function* (spec, args) {
  const ai = new GoogleGenAI({ apiKey: spec.apiKey });

  const result = await ai.models.generateContentStream({
    model: spec.model,
    // Gemini names the assistant role "model".
    contents: args.turns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    config: {
      systemInstruction: args.system,
      ...(args.research ? { tools: [{ googleSearch: {} }] } : {}),
      thinkingConfig: { thinkingLevel: THINKING[args.effort] ?? ThinkingLevel.MEDIUM },
      maxOutputTokens: 16384,
      abortSignal: args.signal,
    },
  });

  const sources = new Map<string, Source>();
  let announced = false;
  let produced = false;

  for await (const chunk of result) {
    const meta = chunk.candidates?.[0]?.groundingMetadata;
    if (meta) {
      const before = sources.size;
      collect(meta, sources);
      if (!produced && sources.size > before && !announced) {
        announced = true;
        yield { type: "searching", active: true };
      }
    }

    const text = chunk.text;
    if (text) {
      if (announced) {
        announced = false;
        yield { type: "searching", active: false };
      }
      produced = true;
      yield { type: "text", text };
    }
  }

  if (announced) yield { type: "searching", active: false };
  if (sources.size > 0) yield { type: "sources", sources: [...sources.values()] };
  if (!produced) {
    yield {
      type: "notice",
      text: "The model returned nothing — usually a safety filter or an empty search result. Rephrase and try again.",
    };
  }
};
