/*
 * One-shot codemod: migrate App Router route handlers to the Next 15 signature.
 *
 * WHY
 * ---
 * Next.js 15 changed the second argument of a dynamic route handler from a
 * plain object to a Promise, because the router streams the params and must not
 * block on them. `next build` enforces this via the generated RouteContext type
 * in .next/types, so every handler written for Next 14 fails to compile with:
 *
 *   Type '{ id: string }' is missing the following properties from type
 *   'Promise<any>': then, catch, finally, [Symbol.toStringTag]
 *
 * THE TRANSFORM
 * -------------
 * Rather than rewriting all 45 `params.id` use sites (easy to miss one), the
 * handler keeps its existing local name and gains a single await at the top of
 * its body. The rest of the body is untouched, which is what makes this safe to
 * run across a whole directory.
 *
 *   BEFORE  export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
 *             const site = await getSite(params.id);
 *
 *   AFTER   export async function GET(_req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
 *             const params = await p;
 *             const site = await getSite(params.id);
 *
 * A handler that takes the whole context (`ctx.params.id`) has no destructured
 * name to shadow, so it gets a plain `id` binding instead.
 *
 * SELF-CHECKING
 * -------------
 * The whole point of a codemod across 15 files is that a missed rewrite stays
 * invisible until the build fails on Render. So every handler whose type is
 * changed is counted, and every one must also gain its await. If those counts
 * differ, or if any synchronous `params: { x: string }` type survives, the
 * script reports the exact file and exits non-zero without writing anything.
 *
 * Idempotent: files already using `Promise<` are skipped, so re-running is safe.
 *
 * Run: node scripts/migrate-params-to-promise.mjs [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const DRY = process.argv.includes("--dry");

/** Every export async function. `[^)]*?` spans the multi-line signatures. */
const HANDLER = /export async function (GET|POST|PUT|PATCH|DELETE)\s*\(([^)]*)\)\s*\{/g;
/** A signature still carrying the old synchronous param type. */
const NEEDS_MIGRATION = /params:\s*\{\s*\w+:\s*string\s*\}/;

let filesChanged = 0;
let typesChanged = 0;
let awaitsInserted = 0;
const failures = [];

/** Migrate one signature's param type. Returns the new argument text. */
function migrateType(args) {
  // Destructured form: { params }: { params: { id: string } }
  const destructured = args.replace(
    /\{\s*params\s*\}\s*:\s*\{\s*params\s*:\s*\{\s*(\w+)\s*:\s*string\s*\}\s*\}/g,
    (_m, key) => `{ params: p }: { params: Promise<{ ${key}: string }> }`
  );
  if (destructured !== args) return destructured;

  // Context form: ctx: { params: { id: string } }
  return args.replace(
    /\b(\w+)\s*:\s*\{\s*params\s*:\s*\{\s*(\w+)\s*:\s*string\s*\}\s*\}/g,
    (_m, ctxName, key) => `${ctxName}: { params: Promise<{ ${key}: string }> }`
  );
}

for (const file of globSync("app/**/route.ts")) {
  const original = readFileSync(file, "utf8");
  if (!NEEDS_MIGRATION.test(original)) continue;

  let fileTypes = 0;
  let fileAwaits = 0;
  const unresolved = [];

  // Rebuild the file handler by handler so each signature and the body that
  // follows it are processed together, rather than by independent passes.
  let out = "";
  let cursor = 0;
  HANDLER.lastIndex = 0;
  let m;
  while ((m = HANDLER.exec(original)) !== null) {
    const [whole, name, args] = m;
    const newArgs = migrateType(args);

    if (newArgs === args) {
      // Not one of the handlers we migrate, or a shape we do not recognise.
      if (NEEDS_MIGRATION.test(args)) {
        unresolved.push(`${name} — signature not understood: ${args.replace(/\s+/g, " ").trim()}`);
      }
      continue;
    }

    fileTypes++;

    // The body of this handler runs to the next handler (or end of file).
    const bodyStart = m.index + whole.length;
    const next = /export async function (?:GET|POST|PUT|PATCH|DELETE)\s*\(/.exec(
      original.slice(bodyStart)
    );
    const bodyEnd = next ? bodyStart + next.index : original.length;
    let body = original.slice(bodyStart, bodyEnd);

    // A context-form handler has no destructured name to shadow.
    const usesCtx = /\bctx\s*:\s*\{\s*params\s*:\s*Promise</.test(newArgs);
    if (usesCtx) {
      body = body.replace(/\bctx\.params\.id\b/g, "id");
    }
    const binding = usesCtx ? "const id = (await ctx.params).id;" : "const params = await p;";
    if (!body.includes(binding)) {
      body = `${binding}\n${body}`;
      fileAwaits++;
    }

    out += original.slice(cursor, m.index);
      out += `export async function ${name}(${newArgs}) {`;
    // Keep the inserted binding on its own line; the source brace and the
    // first body statement are often on the same line.
    out += "\n" + body;
    cursor = bodyEnd;
  }
  out += original.slice(cursor);

  // The safety nets: nothing synchronous may survive, and every changed type
  // must have gained its await.
  const leftovers = (out.match(/params:\s*\{\s*\w+:\s*string\s*\}/g) || []).length;
  if (leftovers) {
    failures.push(`${file}: ${leftovers} synchronous param type(s) survived`);
    continue;
  }
  if (fileTypes !== fileAwaits) {
    failures.push(`${file}: ${fileTypes} type(s) changed but only ${fileAwaits} await(s) inserted`);
    continue;
  }
  if (unresolved.length) {
    for (const u of unresolved) failures.push(`${file}: ${u}`);
    continue;
  }

  typesChanged += fileTypes;
  awaitsInserted += fileAwaits;
  filesChanged++;

  const plural = fileTypes > 1 ? "s" : "";
  if (DRY) console.log(`would change: ${file} (${fileTypes} handler${plural})`);
  else {
    writeFileSync(file, out, "utf8");
    console.log(`migrated: ${file} (${fileTypes} handler${plural})`);
  }
}

console.log(
  `\n${DRY ? "[dry] " : ""}${filesChanged} file(s), ${typesChanged} param type(s), ${awaitsInserted} await(s) inserted.`
);

if (failures.length) {
  console.log("\nNothing was written. Needs a manual look:");
  for (const f of failures) console.log(`  ! ${f}`);
  process.exit(1);
}
