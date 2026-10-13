import { NextRequest, NextResponse } from "next/server";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { resolveMasterOrigin } from "@/lib/masterOrigin";
import { saveVaultAsset } from "@/lib/vaultStorage";

function sanitizeSlug(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface WpPluginHeaders {
  name: string;
  version: string;
  description: string;
  author: string;
  textDomain: string;
}

function parseWpPluginHeader(content: string): WpPluginHeaders | null {
  const headerMatch = content.match(/\/\*[\s\S]*?Plugin\s+Name\s*:[\s\S]*?\*\//i);
  if (!headerMatch) return null;

  const block = headerMatch[0];
  const extract = (key: string): string => {
    const re = new RegExp(`${key}\\s*:\\s*([^\\r\\n]+)`, "i");
    const m = block.match(re);
    return m ? m[1].trim() : "";
  };

  const name = extract("Plugin Name");
  if (!name) return null;

  return {
    name,
    version: extract("Version") || "1.0.0",
    description: extract("Description") || "",
    author: extract("Author") || "",
    textDomain: extract("Text Domain") || "",
  };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file =
      (formData.get("file") as File | null) ||
      (formData.get("plugin_zip") as File | null) ||
      (formData.get("zip") as File | null);

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No plugin ZIP file provided in upload request." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let incomingZip: AdmZip;
    try {
      incomingZip = new AdmZip(buffer);
    } catch (err: any) {
      return NextResponse.json(
        { success: false, error: "Invalid ZIP archive: " + (err?.message || "cannot extract.") },
        { status: 400 }
      );
    }

    const entries = incomingZip.getEntries();
    if (!entries || entries.length === 0) {
      return NextResponse.json(
        { success: false, error: "The uploaded ZIP archive is empty." },
        { status: 400 }
      );
    }

    // Identify main plugin PHP file with WordPress header
    let mainEntry: AdmZip.IZipEntry | null = null;
    let mainHeaders: WpPluginHeaders | null = null;
    let topFolder = "";

    // Check if the ZIP has a common single top-level root directory
    const nonDirEntries = entries.filter((e) => !e.isDirectory);
    if (nonDirEntries.length > 0) {
      const firstEntryParts = nonDirEntries[0].entryName.replace(/\\/g, "/").split("/").filter(Boolean);
      if (firstEntryParts.length > 1) {
        const candidate = firstEntryParts[0];
        const allShareCandidate = nonDirEntries.every((e) => {
          const parts = e.entryName.replace(/\\/g, "/").split("/").filter(Boolean);
          return parts.length > 1 && parts[0] === candidate;
        });
        if (allShareCandidate) {
          topFolder = candidate;
        }
      }
    }

    // Sort PHP entries: shallowest paths first to prioritize the canonical root plugin file
    const phpEntries = entries
      .filter((e) => !e.isDirectory && e.entryName.replace(/\\/g, "/").endsWith(".php"))
      .sort((a, b) => {
        const depthA = a.entryName.replace(/\\/g, "/").split("/").length;
        const depthB = b.entryName.replace(/\\/g, "/").split("/").length;
        return depthA - depthB;
      });

    for (const entry of phpEntries) {
      const text = entry.getData().toString("utf8");
      const headers = parseWpPluginHeader(text);
      if (headers) {
        mainEntry = entry;
        mainHeaders = headers;
        break;
      }
    }

    if (!mainEntry || !mainHeaders) {
      return NextResponse.json(
        {
          success: false,
          error:
            "No WordPress plugin header found. Ensure the ZIP contains a main PHP file with '/* Plugin Name: ... */'.",
        },
        { status: 400 }
      );
    }

    // Determine canonical plugin slug
    let slug = sanitizeSlug(mainHeaders.textDomain);
    if (!slug && topFolder) {
      slug = sanitizeSlug(topFolder);
    }
    if (!slug) {
      const fileName = path.basename(mainEntry.entryName, ".php");
      slug = sanitizeSlug(fileName) || sanitizeSlug(mainHeaders.name);
    }

    // Determine Master origin URL
    const masterOriginRes = resolveMasterOrigin(req.url);
    const masterUrl =
      process.env.MASTER_ORIGIN ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      masterOriginRes.origin ||
      "http://localhost:3000";

    // Read SDK template files from lib/wpSdk/
    const wpSdkDir = path.join(process.cwd(), "lib", "wpSdk");
    const licenseClientPhpPath = path.join(wpSdkDir, "class-slate-wp-license.php");
    const licenseAdminPhpPath = path.join(wpSdkDir, "class-slate-wp-license-admin.php");

    let clientSdkCode = "";
    let adminSdkCode = "";

    try {
      clientSdkCode = await fs.promises.readFile(licenseClientPhpPath, "utf8");
      adminSdkCode = await fs.promises.readFile(licenseAdminPhpPath, "utf8");
    } catch (readErr: any) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to read WordPress Licensing SDK templates: " + readErr?.message,
        },
        { status: 500 }
      );
    }

    // Prepare destination ZIP
    const outZip = new AdmZip();

    // Determine target path of the main plugin entry
    const normalizedMainEntryPath = mainEntry.entryName.replace(/\\/g, "/");
    const targetMainPath = !topFolder
      ? `${slug}/${normalizedMainEntryPath.replace(/^\/+/, "")}`
      : normalizedMainEntryPath;
    const targetMainDir = path.posix.dirname(targetMainPath);
    const includesPrefix = `${targetMainDir}/includes/`;

    // Process all existing entries
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const relPath = entry.entryName.replace(/\\/g, "/");

      // Normalize into plugin folder if missing top folder
      let targetPath = relPath;
      if (!topFolder) {
        targetPath = `${slug}/${relPath.replace(/^\/+/, "")}`;
      }

      if (relPath === normalizedMainEntryPath) {
        let content = entry.getData().toString("utf8");

        // Inject bootstrap if not already present
        if (!content.includes("Slate_WP_License::init")) {
          const escapedName = mainHeaders.name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const escapedMasterUrl = masterUrl.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const bootstrapCode = `

// --- SLATE LICENSE SHIELD AUTO-INJECTED ---
if (!defined('ABSPATH')) {
    exit;
}
require_once plugin_dir_path(__FILE__) . 'includes/class-slate-wp-license.php';
Slate_WP_License::init(array(
    'slug'       => '${slug}',
    'name'       => '${escapedName}',
    'version'    => '${mainHeaders.version}',
    'master_url' => '${escapedMasterUrl}',
));
`;

          let insertIdx = -1;
          const headerEndMatch = content.match(/\/\*[\s\S]*?Plugin\s+Name\s*:[\s\S]*?\*\//i);
          if (headerEndMatch && headerEndMatch.index !== undefined) {
            insertIdx = headerEndMatch.index + headerEndMatch[0].length;
          }

          // If declare(strict_types=1); exists, it MUST remain the very first PHP statement
          const declareMatch = content.match(/declare\s*\([^)]*\)\s*;/i);
          if (declareMatch && declareMatch.index !== undefined) {
            const declareEnd = declareMatch.index + declareMatch[0].length;
            if (declareEnd > insertIdx) {
              insertIdx = declareEnd;
            }
          }

          if (insertIdx >= 0) {
            content = content.slice(0, insertIdx) + bootstrapCode + content.slice(insertIdx);
          } else {
            content += bootstrapCode;
          }
        }

        outZip.addFile(targetPath, Buffer.from(content, "utf8"));
      } else {
        outZip.addFile(targetPath, entry.getData());
      }
    }

    // Add SDK template files into includes/ directory relative to main plugin entry
    outZip.addFile(`${includesPrefix}class-slate-wp-license.php`, Buffer.from(clientSdkCode, "utf8"));
    outZip.addFile(`${includesPrefix}class-slate-wp-license-admin.php`, Buffer.from(adminSdkCode, "utf8"));

    // Generate vaulted distribution ZIP
    const vaultedZipBuffer = outZip.toBuffer();
    const vaultSha256 = crypto.createHash("sha256").update(vaultedZipBuffer).digest("hex");

    const safeVersion = mainHeaders.version.replace(/[^a-zA-Z0-9._-]/g, "");
    const fileName = `${slug}-v${safeVersion}.zip`;
    const assetPath = `vault/wp-plugins/${slug}/${fileName}`.replace(/\\/g, "/");

    // Save to disk and persistent KV
    await saveVaultAsset(assetPath, vaultedZipBuffer);

    return NextResponse.json({
      success: true,
      name: mainHeaders.name,
      slug,
      version: mainHeaders.version,
      description: mainHeaders.description,
      author: mainHeaders.author,
      assetPath,
      vaultSha256,
      fileSize: vaultedZipBuffer.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: "Upload failed: " + (err?.message || "unknown error") },
      { status: 500 }
    );
  }
}
