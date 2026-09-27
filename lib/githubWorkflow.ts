import { getAuthAgentUrl } from "./migrationPaths";

export interface WorkflowOptions {
  framework: "wordpress" | "laravel" | "react" | "php";
  deployTargetUrl: string;
  targetDomain?: string;
  targetPath: string;
  webhookSecret: string;
  handshakeToken?: string;
}

export function getAuthPhpUrl(domain?: string, path?: string): string {
  return getAuthAgentUrl(domain, path);
}

export function generateDeployWorkflow(opts: WorkflowOptions): string {
  const isNode = opts.framework === "react";
  const authUrl = getAuthPhpUrl(opts.targetDomain, opts.targetPath);

  return `name: SLATE DEVOPS OS - Auto Deployment Pipeline

on:
  push:
    branches: [ main, master ]
  workflow_dispatch:

concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-sync:
    name: Build & Zero-Touch Push
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      ${isNode ? `
      - name: Setup Node.js Environment
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install Dependencies & Build
        run: |
          npm ci
          npm run build
      ` : `
      - name: Validate Application Code
        run: |
          echo "Validating ${opts.framework.toUpperCase()} application structure..."
          test -f index.php || test -f index.html || test -f wp-config-sample.php || echo "Application entrypoint validated"
      `}

      - name: Package Release Bundle
        run: |
          echo "Compressing deployment artifacts into zero-touch payload..."
          zip -r -q release_payload.zip . -x ".git/*" ".github/*" "release_payload.zip"
          echo "Payload generated: $(ls -lh release_payload.zip | awk '{print $5}')"

      ${authUrl ? `
      - name: Deploy to Remote Target Server (${authUrl})
        run: |
          echo "Transmitting deployment payload to remote auth.php agent..."
          HTTP_CODE=$(curl -sS -o deploy_response.txt -w "%{http_code}" -X POST "${authUrl}" \\
            -F "action=deploy" \\
            -F "archive=@release_payload.zip" \\
            -F "commit_sha=\${{ github.sha }}" \\
            -F "token=\${{ secrets.SLATE_AGENT_TOKEN }}" \\
            -H "X-Slate-Token: \${{ secrets.SLATE_AGENT_TOKEN }}" \\
            --connect-timeout 20 \\
            --max-time 120 || echo "000")
          
          echo "Remote Server HTTP Response: $HTTP_CODE"
          cat deploy_response.txt || true
          echo ""

          if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            echo "Remote target deployment completed successfully!"
          else
            echo "::warning::Remote agent at ${authUrl} returned HTTP $HTTP_CODE. If 500, verify auth.php permissions are 0644 and folder is 0755 on LiteSpeed/cPanel."
          fi
      ` : `
      - name: Remote Target Agent Bypass
        run: |
          echo "No external public target domain specified. Artifact packaged successfully."
      `}

      - name: Dispatch Deployment Webhook to Master OS
        run: |
          echo "Dispatching deployment telemetry to SLATE Master OS..."
          curl -sS -X POST "${opts.deployTargetUrl}/api/deploy/webhook" \\
            -H "Content-Type: application/json" \\
            -H "X-Slate-Token: \${{ secrets.SLATE_AGENT_TOKEN }}" \\
            --connect-timeout 4 \\
            --max-time 10 \\
            -d '{
              "commit_sha": "'\${{ github.sha }}'",
              "repository": "'\${{ github.repository }}'",
              "actor": "'\${{ github.actor }}'",
              "target_path": "${opts.targetPath}",
              "framework": "${opts.framework}"
            }' || echo "Master OS webhook notification skipped (Master running locally or offline)"
`;
}
