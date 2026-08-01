import { GoogleGenAI, ThinkingLevel, type GroundingMetadata } from "@google/genai";
import { NextRequest } from "next/server";
import {
  buildSystem,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
  type Source,
} from "@/lib/counsel";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * "…-latest" tracks the current Flash model, which is the one covered by the
 * free tier. Override with GEMINI_MODEL (e.g. gemini-pro-latest) if the
 * account has quota for something stronger.
 */
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

/**
 * Analysis depth. thinkingLevel rather than thinkingBudget: budgets are
 * model-dependent and are rejected outright by Gemini 3.5 and newer.
 */
const THINKING: Record<EffortId, ThinkingLevel> = {
  medium: ThinkingLevel.LOW,
  high: ThinkingLevel.MEDIUM,
  xhigh: ThinkingLevel.HIGH,
};

type ChatTurn = { role: "user" | "assistant"; content: string };

type ChatBody = {
  messages: ChatTurn[];
  jurisdiction: JurisdictionId;
  language: LanguageId;
  effort: EffortId;
  research?: boolean;
};

function line(obj: unknown) {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function collectSources(meta: GroundingMetadata | undefined, into: Map<string, Source>) {
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

function describeError(err: unknown): string {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  const raw = err instanceof Error ? err.message : String(err);

  if (status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(raw)) {
    return "The Gemini free tier's rate limit was hit. Wait a minute and try again, or lower the analysis depth.";
  }
  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(raw)) {
    return "Gemini rejected the API key. Check GEMINI_API_KEY, and that the Generative Language API is enabled for that project.";
  }
  if (status === 404 || /not found|NOT_FOUND/i.test(raw)) {
    return `The model "${MODEL}" is not available to this key. Set GEMINI_MODEL to one your account can use.`;
  }
  return raw || "Unexpected error.";
}

export async function POST(req: NextRequest) {
  if (!process.env.GEMINI_API_KEY) {
    return Response.json(
      {
        error:
          process.env.VERCEL === "1"
            ? "This deployment has no GEMINI_API_KEY configured. Add it to the Vercel project's environment variables and redeploy."
            : "GEMINI_API_KEY is not set. Copy .env.example to .env.local, add your key from aistudio.google.com/apikey, and restart the dev server.",
      },
      { status: 500 },
    );
  }

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  const turns = (body.messages ?? []).filter((m) => m.content?.trim());

  if (turns.length === 0 || turns[turns.length - 1].role !== "user") {
    return Response.json(
      { error: "The conversation must end with a user message." },
      { status: 400 },
    );
  }

  // Gemini names the assistant role "model".
  const contents = turns.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content.trim() }],
  }));

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const research = body.research !== false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sources = new Map<string, Source>();
      let announcedSearch = false;
      let produced = false;

      try {
        const result = await ai.models.generateContentStream({
          model: MODEL,
          contents,
          config: {
            systemInstruction: buildSystem({
              jurisdiction: body.jurisdiction ?? "auto",
              language: body.language ?? "auto",
            }),
            ...(research ? { tools: [{ googleSearch: {} }] } : {}),
            thinkingConfig: { thinkingLevel: THINKING[body.effort] ?? ThinkingLevel.MEDIUM },
            maxOutputTokens: 16384,
          },
        });

        for await (const chunk of result) {
          const meta = chunk.candidates?.[0]?.groundingMetadata;
          if (meta) {
            const before = sources.size;
            collectSources(meta, sources);
            // Grounding metadata appearing before any prose means it is still
            // searching; tell the UI so the bot can show it.
            if (!produced && sources.size > before && !announcedSearch) {
              announcedSearch = true;
              controller.enqueue(line({ type: "searching", active: true }));
            }
          }

          const text = chunk.text;
          if (text) {
            if (announcedSearch) {
              announcedSearch = false;
              controller.enqueue(line({ type: "searching", active: false }));
            }
            produced = true;
            controller.enqueue(line({ type: "text", text }));
          }
        }

        if (announcedSearch) {
          controller.enqueue(line({ type: "searching", active: false }));
        }

        if (sources.size > 0) {
          controller.enqueue(line({ type: "sources", sources: [...sources.values()] }));
        }

        if (!produced) {
          controller.enqueue(
            line({
              type: "notice",
              text: "The model returned nothing — this is usually a safety filter or an empty search result. Rephrase the question and try again.",
            }),
          );
        }

        controller.enqueue(line({ type: "done" }));
      } catch (err) {
        controller.enqueue(line({ type: "error", message: describeError(err) }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
