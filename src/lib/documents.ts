import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Turn an uploaded contract into text the model can read.
 *
 * unpdf rather than pdf-parse: pdf-parse needs a worker thread and does not
 * survive Next's bundling on a serverless function, whereas unpdf ships a
 * serverless-safe build of PDF.js. mammoth reads .docx without LibreOffice.
 */

export type DocumentKind = "pdf" | "docx" | "text";

export type ExtractedDocument = {
  name: string;
  kind: DocumentKind;
  text: string;
  /** Pages for PDFs; absent for other kinds. */
  pages?: number;
  chars: number;
  /** Set when the PDF had no text layer — a scan that needs OCR. */
  warning?: string;
};

/** 4 MB — under Vercel's 4.5 MB serverless body limit with room for encoding. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

export function kindOf(name: string, mime: string): DocumentKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return "docx";
  }
  if (TEXT_TYPES.has(mime) || ["txt", "md", "markdown", "csv", "json"].includes(ext)) {
    return "text";
  }
  return null;
}

/** Collapse PDF extraction artefacts without destroying paragraph structure. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export async function extractDocument(
  name: string,
  mime: string,
  bytes: ArrayBuffer,
): Promise<ExtractedDocument> {
  const kind = kindOf(name, mime);
  if (!kind) {
    throw new Error(`Unsupported file type for "${name}". Use PDF, Word (.docx) or plain text.`);
  }

  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const clean = tidy(text);
    return {
      name,
      kind,
      text: clean,
      pages: totalPages,
      chars: clean.length,
      warning:
        clean.length < totalPages * 40
          ? "This PDF has little or no text layer — it is probably a scan. Run OCR on it first, or paste the text."
          : undefined,
    };
  }

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const clean = tidy(value);
    return { name, kind, text: clean, chars: clean.length };
  }

  const clean = tidy(new TextDecoder("utf-8").decode(bytes));
  return { name, kind, text: clean, chars: clean.length };
}
