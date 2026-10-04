// Temporary harness: exercises the REAL uploadAgentFiles (compiled by Next)
// against a mock cPanel, by adding a throwaway route that calls it directly.
import { NextRequest, NextResponse } from "next/server";
import { uploadAgentFiles } from "@/lib/agentUpload";

/**
 * POST /api/_selftest/agent-upload  { host, user, apiToken, remoteDir }
 * Throwaway verification route — drives the real upload path end to end.
 */
export async function POST(req: NextRequest) {
  // This route makes the server open a connection to a caller-supplied host, so
  // it must never exist on a live deployment (it is also admin-only via
  // middleware, but a harness has no business being reachable at all).
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ success: false, error: "Not found." }, { status: 404 });
  }
  const body = await req.json().catch(() => ({} as any));
  const res = await uploadAgentFiles(
    { host: String(body.host || ""), user: String(body.user || "u"), apiToken: String(body.apiToken || "t") },
    String(body.remoteDir || "public_html/slate")
  );
  return NextResponse.json({ success: true, res });
}