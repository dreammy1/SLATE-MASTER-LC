// Temporary harness: exercises the REAL uploadAgentFiles (compiled by Next)
// against a mock cPanel, by adding a throwaway route that calls it directly.
import { NextRequest, NextResponse } from "next/server";
import { uploadAgentFiles } from "@/lib/agentUpload";

/**
 * POST /api/_selftest/agent-upload  { host, user, apiToken, remoteDir }
 * Throwaway verification route — drives the real upload path end to end.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const res = await uploadAgentFiles(
    { host: String(body.host || ""), user: String(body.user || "u"), apiToken: String(body.apiToken || "t") },
    String(body.remoteDir || "public_html/slate")
  );
  return NextResponse.json({ success: true, res });
}