import { NextRequest } from "next/server";
import { MAX_UPLOAD_BYTES, extractDocument, kindOf } from "@/lib/documents";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Multipart upload → extracted text. The text goes back to the browser and is
 * sent along with the question; nothing is stored server-side.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected a multipart file upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file was attached." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `"${file.name}" is over the 4 MB limit. Split it, or paste the relevant part.` },
      { status: 413 },
    );
  }
  if (!kindOf(file.name, file.type)) {
    return Response.json(
      { error: `"${file.name}" is not a supported type. Use PDF, Word (.docx) or plain text.` },
      { status: 415 },
    );
  }

  try {
    const doc = await extractDocument(file.name, file.type, await file.arrayBuffer());
    if (!doc.text) {
      return Response.json(
        { error: doc.warning ?? `No readable text was found in "${file.name}".` },
        { status: 422 },
      );
    }
    return Response.json(doc);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : `Could not read "${file.name}".` },
      { status: 500 },
    );
  }
}
