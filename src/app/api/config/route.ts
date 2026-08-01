import { providerStatus } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Capability report for the UI. Contains no key material. */
export async function GET() {
  return Response.json(providerStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
