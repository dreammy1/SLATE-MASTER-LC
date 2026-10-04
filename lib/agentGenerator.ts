import fs from "fs/promises";
import path from "path";

export interface AgentTemplateContext {
  orderId?: string;
  siteId?: string;
  domain: string;
  remotePath: string;
  handshakeToken: string;
  clientName?: string;
  framework?: string;
  exportedAt?: string;
}

export interface AgentGeneratorOptions {
  filename?: string;
  templatePath?: string;
}

/**
 * Service responsible for generating customized auth.php agent files
 * with injected metadata and security configurations.
 * (Single Responsibility & Dependency Inversion)
 */
export class AgentGeneratorService {
  private static defaultTemplatePath = path.join(
    process.cwd(),
    "public",
    "auth.php",
  );

  /**
   * Generates header banner comments based on the provided execution context.
   */
  public static buildHeaderComment(context: AgentTemplateContext): string {
    const timestamp = context.exportedAt || new Date().toISOString();
    const cleanPath = context.remotePath || "/public_html";
    const clientName = context.clientName || "Client";

    return `/**
 * ============================================================================
 * SLATE DEVOPS OS — CLIENT REMOTE AGENT SCRIPT
 * ============================================================================
 * Target Domain  : ${context.domain}
 * Remote Path    : ${cleanPath}
 * Handshake Token: ${context.handshakeToken}
 * Client Name    : ${clientName}
 * Framework      : ${context.framework || "Slate"}
${context.orderId ? ` * Order ID       : ${context.orderId}\n` : ""}${context.siteId ? ` * Site ID        : ${context.siteId}\n` : ""} * Exported At    : ${timestamp}
 * 
 * INSTRUCTIONS:
 * 1. Upload this file directly to: ${cleanPath}/auth.php
 * 2. Ensure permissions: 0644 (directory permissions 0755)
 * 3. Keep this file in place for automated deployment and health probes.
 * ============================================================================
 */\n`;
  }

  /**
   * Injects header comments into PHP script source code.
   */
  public static injectHeader(
    rawPhpContent: string,
    headerComment: string,
  ): string {
    if (rawPhpContent.startsWith("<?php")) {
      return rawPhpContent.replace("<?php\n", `<?php\n${headerComment}`);
    }
    return `<?php\n${headerComment}` + rawPhpContent;
  }

  /**
   * Reads the base auth.php template and compiles it with context.
   */
  public static async generateAgentScript(
    context: AgentTemplateContext,
    customTemplatePath?: string,
  ): Promise<string> {
    const sourcePath = customTemplatePath || this.defaultTemplatePath;
    const baseContent = await fs.readFile(sourcePath, "utf-8");
    const header = this.buildHeaderComment(context);
    return this.injectHeader(baseContent, header);
  }

  /**
   * Builds standardized HTTP attachment response headers for file downloads.
   */
  public static buildAttachmentHeaders(filename = "auth.php"): HeadersInit {
    return {
      "Content-Type": "application/x-php; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    };
  }
}
