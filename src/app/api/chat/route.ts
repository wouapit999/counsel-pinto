import Anthropic from "@anthropic-ai/sdk";
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

const MODEL = "claude-opus-5";

/** A long server-tool turn can pause; resume it a bounded number of times. */
const MAX_CONTINUATIONS = 4;

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

/** Pull citable web results out of a completed message. */
function collectSources(content: Anthropic.ContentBlock[], into: Map<string, Source>) {
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    // On error the API returns a single error object rather than a list.
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.type !== "web_search_result") continue;
      if (into.has(result.url)) continue;
      into.set(result.url, {
        title: result.title || hostOf(result.url),
        url: result.url,
        host: hostOf(result.url),
      });
    }
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error:
          process.env.VERCEL === "1"
            ? "This deployment has no ANTHROPIC_API_KEY configured. Add it to the Vercel project's environment variables and redeploy."
            : "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local, add your key, and restart the dev server.",
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

  const turns: Anthropic.MessageParam[] = (body.messages ?? [])
    .filter((m) => m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content.trim() }));

  if (turns.length === 0 || turns[turns.length - 1].role !== "user") {
    return Response.json(
      { error: "The conversation must end with a user message." },
      { status: 400 },
    );
  }

  const client = new Anthropic();
  const research = body.research !== false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sources = new Map<string, Source>();
      let searching = false;

      try {
        const working = [...turns];
        let continuations = 0;
        let stopReason: string | null = null;

        for (;;) {
          const messageStream = client.messages.stream({
            model: MODEL,
            max_tokens: 32000,
            output_config: { effort: body.effort ?? "high" },
            system: buildSystem({
              jurisdiction: body.jurisdiction ?? "auto",
              language: body.language ?? "auto",
            }),
            // Dynamic filtering is built into this tool version — do not also
            // declare code_execution, it confuses the model.
            ...(research
              ? {
                  tools: [
                    {
                      type: "web_search_20260209" as const,
                      name: "web_search" as const,
                      max_uses: 8,
                    },
                  ],
                }
              : {}),
            messages: working,
          });

          for await (const event of messageStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              if (searching) {
                searching = false;
                controller.enqueue(line({ type: "searching", active: false }));
              }
              controller.enqueue(line({ type: "text", text: event.delta.text }));
            } else if (
              event.type === "content_block_start" &&
              event.content_block.type === "server_tool_use" &&
              !searching
            ) {
              searching = true;
              controller.enqueue(line({ type: "searching", active: true }));
            }
          }

          const final = await messageStream.finalMessage();
          collectSources(final.content, sources);
          stopReason = final.stop_reason;

          // The server-side tool loop hit its iteration cap — resume it.
          if (final.stop_reason === "pause_turn" && continuations < MAX_CONTINUATIONS) {
            continuations += 1;
            working.push({ role: "assistant", content: final.content });
            continue;
          }
          break;
        }

        if (searching) {
          controller.enqueue(line({ type: "searching", active: false }));
        }

        if (sources.size > 0) {
          controller.enqueue(
            line({ type: "sources", sources: [...sources.values()] }),
          );
        }

        if (stopReason === "refusal") {
          controller.enqueue(
            line({
              type: "notice",
              text: "This request was declined by the model's safety systems. Rephrase it, or take it to a locally admitted lawyer.",
            }),
          );
        } else if (stopReason === "max_tokens") {
          controller.enqueue(
            line({
              type: "notice",
              text: "The answer was cut off at the length limit. Ask a follow-up to continue.",
            }),
          );
        } else if (stopReason === "pause_turn") {
          controller.enqueue(
            line({
              type: "notice",
              text: "Research was still running when the turn limit was reached. Ask a follow-up to continue.",
            }),
          );
        }

        controller.enqueue(line({ type: "done" }));
      } catch (err) {
        const message =
          err instanceof Anthropic.RateLimitError
            ? "Rate limited by the Claude API. Wait a moment and try again."
            : err instanceof Anthropic.AuthenticationError
              ? "The Claude API rejected the API key. Check ANTHROPIC_API_KEY."
              : err instanceof Anthropic.APIError
                ? `Claude API error (${err.status}): ${err.message}`
                : err instanceof Error
                  ? err.message
                  : "Unexpected error.";
        controller.enqueue(line({ type: "error", message }));
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
