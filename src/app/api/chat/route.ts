import { NextRequest } from "next/server";
import {
  buildSystem,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
} from "@/lib/counsel";
import {
  PROVIDERS,
  adapterFor,
  describeError,
  resolveProvider,
  type Turn,
} from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 300;

type ChatBody = {
  messages: Turn[];
  jurisdiction: JurisdictionId;
  language: LanguageId;
  effort: EffortId;
  research?: boolean;
};

function line(obj: unknown) {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(req: NextRequest) {
  const provider = resolveProvider();

  if (!provider) {
    const g = PROVIDERS.gemini;
    return Response.json(
      {
        error:
          process.env.VERCEL === "1"
            ? `No AI provider is configured on this deployment. Add ${g.envKey} (free — ${g.console}) to the Vercel project's environment variables and redeploy.`
            : `No AI provider is configured. Copy .env.example to .env.local, add ${g.envKey} (free — ${g.console}), and restart the dev server.`,
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

  // Asking for search on a provider that cannot search is not an error — it
  // just isn't done, and the prompt is told so it won't invent citations.
  const research = body.research !== false && provider.supportsSearch;

  const system = buildSystem({
    jurisdiction: body.jurisdiction ?? "auto",
    language: body.language ?? "auto",
    canSearch: research,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          line({
            type: "meta",
            provider: provider.label,
            model: provider.model,
            searched: research,
          }),
        );

        const events = adapterFor(provider.id)(provider, {
          system,
          turns,
          effort: body.effort ?? "high",
          research,
          signal: req.signal,
        });

        for await (const event of events) {
          controller.enqueue(line(event));
        }

        controller.enqueue(line({ type: "done" }));
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          controller.close();
          return;
        }
        controller.enqueue(
          line({
            type: "error",
            message: describeError(err, provider.model, provider.label),
          }),
        );
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
