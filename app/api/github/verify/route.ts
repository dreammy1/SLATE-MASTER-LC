import { NextRequest, NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";

export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    const octokit = new Octokit({ auth: token });
    const { data: user, headers } = await octokit.users.getAuthenticated();
    const scopes = (headers["x-oauth-scopes"] || "").split(",").map((s: string) => s.trim());

    return NextResponse.json({
      success: true,
      user: {
        login: user.login,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
      },
      scopes,
      scopesValid: true,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Invalid GitHub Token" }, { status: 401 });
  }
}
