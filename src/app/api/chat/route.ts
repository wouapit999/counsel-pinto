import { NextRequest } from "next/server";
import {
  TASKS,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
  type TaskId,
} from "@/lib/counsel";
import { runPipeline, type AttachedDocument } from "@/lib/pipeline";
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
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
  task?: TaskId;
  documents?: AttachedDocument[];
};

function line(obj: unknown) {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

const TASK_IDS = new Set<string>(TASKS.map((t) => t.id));

export async function POST(req: NextRequest) {
  const provider = resolveProvider();

  if (!provider) {
    const d = PROVIDERS[DEFAULT_PROVIDER];
    return Response.json(
      {
        error:
          process.env.VERCEL === "1"
            ? `No AI provider is configured on this deployment. Add ${d.envKey} (free — ${d.console}) to the Vercel project's environment variables and redeploy.`
            : `No AI provider is configured. Copy .env.example to .env.local, add ${d.envKey} (free — ${d.console}), and restart the dev server.`,
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

  const documents = (body.documents ?? [])
    .filter((d) => typeof d?.name === "string" && typeof d?.text === "string")
    .map((d) => ({ name: d.name.slice(0, 200), text: d.text }));

  const task: TaskId = body.task && TASK_IDS.has(body.task) ? body.task : "consult";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const events = runPipeline({
          provider,
          turns,
          documents,
          task,
          jurisdiction: body.jurisdiction ?? "auto",
          language: body.language ?? "auto",
          effort: body.effort ?? "high",
          research: body.research !== false,
          signal: req.signal,
        });
        for await (const event of events) controller.enqueue(line(event));
        controller.enqueue(line({ type: "done" }));
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          controller.enqueue(
            line({
              type: "error",
              message: describeError(err, provider.model, provider.label),
            }),
          );
        }
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
