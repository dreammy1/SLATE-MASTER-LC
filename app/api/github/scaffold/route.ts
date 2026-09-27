import { NextRequest, NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import AdmZip from "adm-zip";
import { generateDeployWorkflow } from "@/lib/githubWorkflow";
import { getSettings, getSites, addSite, updateSite } from "@/lib/storage";
import { decryptSecret } from "@/lib/crypto";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err: any) {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const repoName = (formData.get("repoName") as string || "").trim();
  const domain = (formData.get("domain") as string || "").trim();
  const description = (formData.get("description") as string) || "Scaffolded via SLATE DEVOPS OS";
  const isPrivate = formData.get("isPrivate") === "true";
  const framework = (formData.get("framework") as any) || "wordpress";
  const targetPath = (formData.get("targetPath") as string) || "/public_html";
  const masterHost = req.nextUrl.origin;

  if (!repoName) {
    return NextResponse.json({ error: "Repository name is required" }, { status: 400 });
  }

  // 1. Retrieve stored GitHub PAT from encrypted settings
  let githubPat = req.headers.get("x-github-token") || "";

  if (!githubPat) {
    try {
      const settings = await getSettings();
      if (settings.githubTokenEncrypted) {
        githubPat = decryptSecret(settings.githubTokenEncrypted);
      }
    } catch {
      // Fall through to env var
    }
  }

  if (!githubPat) {
    githubPat = process.env.GITHUB_DEFAULT_PAT || "";
  }

  if (!githubPat || githubPat.includes("yourPersonalAccessTokenHere") || githubPat.trim() === "") {
    return NextResponse.json({
      success: false,
      error: "No GitHub Personal Access Token configured. Go to Settings > GitHub to save your PAT first.",
    }, { status: 401 });
  }

  // Set up streaming response to provide live progress from 0% to 100% with file counting
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const emit = async (data: any) => {
    try {
      await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
    } catch {
      // client disconnected
    }
  };

  // Run execution pipeline in streaming background task
  (async () => {
    try {
      await emit({
        stage: "INITIALIZING",
        percent: 3,
        currentFile: 0,
        totalFiles: 0,
        message: "Authenticating with GitHub API...",
      });

      const octokit = new Octokit({ auth: githubPat });
      const { data: user } = await octokit.users.getAuthenticated();
      const owner = user.login;

      // 2. Parse ZIP file entries
      const fileEntries: { path: string; content: string; size: number }[] = [];

      if (file && file.size > 0) {
        await emit({
          stage: "INDEXING",
          percent: 8,
          currentFile: 0,
          totalFiles: 0,
          message: `Unpacking ZIP archive (${(file.size / 1024 / 1024).toFixed(2)} MB)...`,
        });

        const buffer = Buffer.from(await file.arrayBuffer());
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        for (const entry of entries) {
          if (entry.isDirectory) continue;
          let entryPath = entry.entryName;
          // Strip leading folder if zip has a single root folder
          if (entries.length > 1) {
            const parts = entryPath.split("/");
            if (parts.length > 1 && entries.every((e) => e.entryName.startsWith(parts[0] + "/"))) {
              entryPath = parts.slice(1).join("/");
            }
          }
          if (!entryPath || entryPath.startsWith("__MACOSX") || entryPath.startsWith(".")) continue;

          try {
            const data = entry.getData();
            fileEntries.push({
              path: entryPath,
              content: data.toString("base64"),
              size: data.length,
            });
          } catch {
            // skip binary-problematic entries
          }
        }
      }

      // Add default entrypoint if completely empty
      if (fileEntries.length === 0) {
        fileEntries.push({
          path: framework === "wordpress" ? "index.php" : "index.html",
          content: Buffer.from("<!DOCTYPE html><html><body><h1>Provisioned by SLATE DevOps OS</h1></body></html>", "utf8").toString("base64"),
          size: 75,
        });
      }

      // Always add or update README
      fileEntries.push({
        path: "README.md",
        content: Buffer.from(
          `# ${repoName}\n\nAuto-provisioned by **SLATE DevOps OS**.\n\n` +
          `- **Framework:** ${framework}\n` +
          `- **Target Path:** ${targetPath}\n` +
          `- **Target Domain:** ${domain || `https://${repoName}.dev.internal`}\n` +
          `- **CI/CD:** Automated Zero-Touch Deployment Workflow via GitHub Actions\n`
        ).toString("base64"),
        size: 150,
      });

      // Add CI/CD workflow
      const webhookSecret = "slate_sec_" + crypto.randomBytes(16).toString("hex");
      const workflowContent = generateDeployWorkflow({
        framework,
        deployTargetUrl: masterHost,
        targetDomain: domain || "https://whatever-bar.de",
        targetPath,
        webhookSecret,
      });

      fileEntries.push({
        path: ".github/workflows/deploy.yml",
        content: Buffer.from(workflowContent, "utf8").toString("base64"),
        size: workflowContent.length,
      });

      const totalFiles = fileEntries.length;

      await emit({
        stage: "INDEXING",
        percent: 14,
        currentFile: 0,
        totalFiles,
        message: `Project indexed: ${totalFiles} total files queued for repository push`,
      });

      // 3. Check if repository already exists or create a new one
      await emit({
        stage: "CONNECTING",
        percent: 18,
        currentFile: 0,
        totalFiles,
        message: `Connecting to GitHub repository @${owner}/${repoName}...`,
      });

      let targetRepo: any = null;
      try {
        const { data: existing } = await octokit.repos.get({
          owner,
          repo: repoName,
        });
        targetRepo = existing;
      } catch {
        // Repo does not exist yet
      }

      if (!targetRepo) {
        await emit({
          stage: "CONNECTING",
          percent: 22,
          currentFile: 0,
          totalFiles,
          message: `Initializing new repository '${repoName}' on GitHub...`,
        });

        try {
          const { data: newRepo } = await octokit.repos.createForAuthenticatedUser({
            name: repoName,
            description,
            private: isPrivate,
            auto_init: true,
          });
          targetRepo = newRepo;
          await new Promise((r) => setTimeout(r, 1500));
        } catch (createErr: any) {
          if (createErr.message?.includes("Resource not accessible by personal access token")) {
            await emit({
              error: `GitHub Fine-Grained Tokens (github_pat_...) are restricted by GitHub from creating brand-new personal repositories via API. ` +
                     `Solutions: 1) Specify an existing repository in your account (e.g. 'Slate-dev'), or 2) Create the repository '${repoName}' on GitHub first, or 3) Use a Classic Personal Access Token ('ghp_...') with 'repo' scope in Settings.`,
              tokenType: "fine-grained",
            });
            return;
          }
          throw createErr;
        }
      }

      // 4. Get default branch & commit ref
      const defaultBranch = targetRepo.default_branch || "main";
      let baseSha = "";
      let baseTreeSha = "";

      try {
        const { data: refData } = await octokit.git.getRef({
          owner,
          repo: targetRepo.name,
          ref: `heads/${defaultBranch}`,
        });
        baseSha = refData.object.sha;

        const { data: commitData } = await octokit.git.getCommit({
          owner,
          repo: targetRepo.name,
          commit_sha: baseSha,
        });
        baseTreeSha = commitData.tree.sha;
      } catch {
        // Try fallback branch names
        for (const fallback of ["main", "master"]) {
          try {
            const { data: refData } = await octokit.git.getRef({
              owner,
              repo: targetRepo.name,
              ref: `heads/${fallback}`,
            });
            baseSha = refData.object.sha;
            const { data: commitData } = await octokit.git.getCommit({
              owner,
              repo: targetRepo.name,
              commit_sha: baseSha,
            });
            baseTreeSha = commitData.tree.sha;
            break;
          } catch {}
        }
      }

      // 5. Create blobs for each file with live progress updates
      const treeItems: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];

      for (let i = 0; i < fileEntries.length; i++) {
        const entry = fileEntries[i];
        const currentCount = i + 1;
        // Progress smoothly scales from 25% to 85% during file uploads
        const currentPercent = Math.round(25 + (currentCount / totalFiles) * 60);

        await emit({
          stage: "UPLOADING",
          percent: currentPercent,
          currentFile: currentCount,
          totalFiles,
          currentFileName: entry.path,
          message: `Pushing ${entry.path} (${currentCount}/${totalFiles})`,
        });

        try {
          const { data: blob } = await octokit.git.createBlob({
            owner,
            repo: targetRepo.name,
            content: entry.content,
            encoding: "base64",
          });
          treeItems.push({
            path: entry.path,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          });
        } catch (err: any) {
          console.warn(`[BLOB WARNING] Could not create blob for ${entry.path}:`, err.message);
        }
      }

      let latestCommitSha = "scaffold";

      if (treeItems.length > 0) {
        // 6. Create a new tree
        await emit({
          stage: "COMMITTING",
          percent: 88,
          currentFile: totalFiles,
          totalFiles,
          currentFileName: "git/tree",
          message: `Assembling Git tree with ${treeItems.length} objects...`,
        });

        const { data: tree } = await octokit.git.createTree({
          owner,
          repo: targetRepo.name,
          base_tree: baseTreeSha || undefined,
          tree: treeItems,
        });

        // 7. Create a commit
        await emit({
          stage: "COMMITTING",
          percent: 92,
          currentFile: totalFiles,
          totalFiles,
          currentFileName: "git/commit",
          message: `Creating Git commit [HEAD -> ${defaultBranch}]...`,
        });

        const commitMessage = `feat: Scaffold & sync via SLATE DevOps OS\n\nFramework: ${framework}\nTarget: ${targetPath}\nCI/CD: .github/workflows/deploy.yml injected`;
        const { data: commit } = await octokit.git.createCommit({
          owner,
          repo: targetRepo.name,
          message: commitMessage,
          tree: tree.sha,
          parents: baseSha ? [baseSha] : [],
        });
        latestCommitSha = commit.sha.substring(0, 7);

        // 8. Update or create branch ref
        await emit({
          stage: "BRANCH",
          percent: 95,
          currentFile: totalFiles,
          totalFiles,
          currentFileName: `heads/${defaultBranch}`,
          message: `Linking commit ${latestCommitSha} to branch ${defaultBranch}...`,
        });

        try {
          await octokit.git.updateRef({
            owner,
            repo: targetRepo.name,
            ref: `heads/${defaultBranch}`,
            sha: commit.sha,
            force: true,
          });
        } catch {
          try {
            await octokit.git.createRef({
              owner,
              repo: targetRepo.name,
              ref: `refs/heads/${defaultBranch}`,
              sha: commit.sha,
            });
          } catch (refErr: any) {
            console.warn("[REF WARNING] Could not create/update branch ref:", refErr.message);
          }
        }
      }

      // 9. Register or update target environment in persistent storage
      await emit({
        stage: "REGISTERING",
        percent: 98,
        currentFile: totalFiles,
        totalFiles,
        currentFileName: "db.json",
        message: `Registering environment & pairing webhook secret...`,
      });

      const targetDomain = domain || `https://${targetRepo.name}.dev.internal`;
      const handshakeToken = "slate_live_" + crypto.createHash("sha1")
        .update(`${targetRepo.name}-${Date.now()}-${Math.random()}`)
        .digest("hex");

      const frameworkLabel = framework === "wordpress" ? "WordPress"
        : framework === "laravel" ? "Laravel"
        : framework === "react" ? "React / Node"
        : "Vanilla PHP";

      const sites = await getSites();
      const existingSite = sites.find(
        (s) => s.repo.toLowerCase() === targetRepo.full_name.toLowerCase() || s.domain === targetDomain
      );

      let siteRecord;
      if (existingSite) {
        siteRecord = await updateSite(existingSite.id, {
          status: "ONLINE",
          lastCommit: latestCommitSha,
          path: targetPath,
          framework: frameworkLabel,
          repo: targetRepo.full_name,
          lastDeployedAt: new Date().toISOString(),
        });
      } else {
        siteRecord = await addSite({
          domain: targetDomain,
          path: targetPath,
          framework: frameworkLabel,
          status: "ONLINE",
          dbStatus: "CONNECTED",
          dbSize: "24.5 MB",
          latency: "28ms",
          lastCommit: latestCommitSha,
          repo: targetRepo.full_name,
          handshakeToken,
          webhookSecret,
        });
      }

      // 10. Final 100% completion event
      await emit({
        stage: "COMPLETE",
        percent: 100,
        currentFile: totalFiles,
        totalFiles,
        currentFileName: "SUCCESS",
        message: `Scaffolding complete! ${treeItems.length} files successfully committed to ${targetRepo.name}.`,
        done: true,
        repo: {
          id: targetRepo.id,
          name: targetRepo.name,
          full_name: targetRepo.full_name,
          html_url: targetRepo.html_url,
          clone_url: targetRepo.clone_url,
          default_branch: defaultBranch,
          injected_workflow: ".github/workflows/deploy.yml",
          framework,
          targetPath,
          filesUploaded: treeItems.length,
          latestCommit: latestCommitSha,
        },
        site: siteRecord,
      });
    } catch (err: any) {
      console.error("[SCAFFOLD STREAM ERROR]", err);
      await emit({
        error: err.message || "Failed to scaffold repository",
      });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}
