import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import {
  buildSystem,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
} from "@/lib/counsel";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = "claude-opus-5";

type ChatTurn = { role: "user" | "assistant"; content: string };

type ChatBody = {
  messages: ChatTurn[];
  jurisdiction: JurisdictionId;
  language: LanguageId;
  effort: EffortId;
};

function line(obj: unknown) {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
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

  const turns = (body.messages ?? [])
    .filter((m) => m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content.trim() }));

  if (turns.length === 0 || turns[turns.length - 1].role !== "user") {
    return Response.json(
      { error: "The conversation must end with a user message." },
      { status: 400 },
    );
  }

  const client = new Anthropic();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const messageStream = client.messages.stream({
          model: MODEL,
          max_tokens: 32000,
          output_config: { effort: body.effort ?? "high" },
          system: buildSystem({
            jurisdiction: body.jurisdiction ?? "auto",
            language: body.language ?? "auto",
          }),
          messages: turns,
        });

        for await (const event of messageStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(line({ type: "text", text: event.delta.text }));
          }
        }

        const final = await messageStream.finalMessage();

        if (final.stop_reason === "refusal") {
          controller.enqueue(
            line({
              type: "notice",
              text: "This request was declined by the model's safety systems. Rephrase it, or take it to a locally admitted lawyer.",
            }),
          );
        } else if (final.stop_reason === "max_tokens") {
          controller.enqueue(
            line({
              type: "notice",
              text: "The answer was cut off at the length limit. Ask a follow-up to continue.",
            }),
          );
        }

        controller.enqueue(
          line({
            type: "done",
            usage: {
              input: final.usage.input_tokens,
              output: final.usage.output_tokens,
              cacheRead: final.usage.cache_read_input_tokens ?? 0,
            },
          }),
        );
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
