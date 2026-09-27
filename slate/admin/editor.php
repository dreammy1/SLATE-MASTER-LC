<?php
/**
 * Slate — Production Visual Page Editor
 *
 * Route: /admin/editor.php?id=<postId>  (edit existing)
 *        /admin/editor.php?type=page    (create new)
 *
 * Three-panel layout with DIRECT canvas rendering (no iframe).
 * Blocks render as real HTML in the canvas, with click-to-select,
 * drag-to-reorder, inline editing, and per-block controls.
 *
 * Phase 2 migration: persistence now goes through the DocumentSchema v1
 * application-service layer (ContentServiceFactory / ContentPublicationService /
 * PreviewService / RevisionStore) instead of the legacy, archived
 * ContentBuilderAPI — see docs/PHASE-2-STRUCTURED-REACT-BUILDER-SCHEMA.md and
 * the plan at .claude/plans (Phase 2 editor migration). The UI/JS below is
 * unchanged; only the PHP data layer and the AJAX handlers changed.
 */

declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

use Slate\Presentation\DocumentOperations;
use Slate\Presentation\DocumentValidator;
use Slate\Presentation\EditorStateSerializer;
use Slate\Presentation\RenderContext;
use Slate\Presentation\Rendering\PageRenderer;
use Slate\Services\Content\ContentServiceFactory;
use Slate\Services\Content\RevisionStore;

Auth::require();
Auth::requirePerm('content.edit');

// ── Feature flag: a kill switch for the Phase 2 path, not a legacy dual-path —
// the archived ContentBuilderAPI backend no longer has a live table to read
// from, so there is nothing working left to fall back to (see the plan).
if (Database::setting('editor_phase2_enabled') === '0') {
    $pageTitle  = 'Visual Editor';
    $currentNav = 'editor';
    require __DIR__ . '/partials/header.php';
    echo '<div class="card"><div class="card-body"><p>'
        . e(__('editor_unavailable', 'The visual editor is temporarily unavailable.'))
        . '</p></div></div>';
    require __DIR__ . '/partials/footer.php';
    exit;
}

$GLOBALS['SLATE_EDITOR_MODE'] = true;

if (!defined('CONTENT_PAGE_OWNER_TYPE')) {
    define('CONTENT_PAGE_OWNER_TYPE', \Slate\Services\Content\ContentPageRepository::OWNER_TYPE);
}

// ── Resolve post ─────────────────────────────────────────────
$pages  = ContentServiceFactory::pageRepository();
$postId = (int)($_GET['id'] ?? 0);
$type   = $_GET['type'] ?? 'page';
$post   = null;

if ($postId) {
    $post = $pages->find($postId);
    if (!$post) {
        http_response_code(404);
        die('Post not found.');
    }
    $type = $post['type'] ?? 'page';
} else {
    $type = preg_match('/^[a-z][a-z0-9_-]{0,31}$/', (string) $type) ? $type : 'page';
    $postId = $pages->create($type, 'Untitled ' . ucfirst($type), 'untitled-' . bin2hex(random_bytes(4)));
    header('Location: editor.php?id=' . $postId);
    exit;
}

$renderCtx     = RenderContext::for(current_tenant_id(), RenderContext::SURFACE_FRAGMENT);
$blockRenderer = new PageRenderer(ContentServiceFactory::blockRegistry());

// ── Load working draft (RevisionStore only — never a raw query) ──────────
$revisions = ContentServiceFactory::revisionStore();
$working   = $revisions->working(CONTENT_PAGE_OWNER_TYPE, $postId);
$layoutDoc = $working !== null ? RevisionStore::documentOf($working) : ['schema' => 1, 'type' => $type, 'template' => '', 'sections' => [], 'seo' => []];
// The editor's JS speaks a flat block array (one implicit section) — flatten
// the canonical document back for the existing UI, matching DocumentSchema's
// own legacy-upconversion contract in reverse.
$layout = [];
foreach (($layoutDoc['sections'] ?? []) as $section) {
    foreach (($section['blocks'] ?? []) as $b) {
        $layout[] = $b;
    }
}
$hasDraftChanges = $working !== null;

// ── Block registry for inserter (5 ported blocks — see LegacyBlockBridge) ──
$blocks = [];
foreach (ContentServiceFactory::paletteProjection() as $def) {
    $btype = $def['type'];
    $jsFields = [];
    foreach (($def['fields'] ?? []) as $f) {
        if (!is_array($f) || empty($f['key'])) continue;
        $entry = [
            'type'  => $f['type'] ?? 'text',
            'label' => $f['label'] ?? $f['key'],
        ];
        if (!empty($f['options']) && is_array($f['options'])) {
            $opts = [];
            foreach ($f['options'] as $opt) {
                if (is_array($opt) && isset($opt['v'])) {
                    $opts[(string)$opt['v']] = (string)($opt['l'] ?? $opt['v']);
                } elseif (is_string($opt)) {
                    $opts[$opt] = $opt;
                }
            }
            $entry['options'] = $opts;
        }
        $jsFields[$f['key']] = $entry;
    }
    $blocks[$btype] = [
        'type'     => $btype,
        'label'    => $def['label'] ?? ucfirst($btype),
        'icon'     => 'box',
        'category' => $def['category'] ?? 'Content',
        'fields'   => $jsFields,
        'defaults' => $def['defaults'] ?? [],
    ];
}

$mediaMap = []; // Phase 2: real media-key resolution is deferred (see plan) — no live resolver exists yet.

// ── Pre-render all blocks for initial canvas ─────────────────
$renderedBlocks = [];
foreach ($layout as $block) {
    if (!is_array($block)) continue;
    $renderedBlocks[] = $blockRenderer->renderBlock($block, $renderCtx);
}

// ── Theme tokens for canvas CSS ────────────────────────────── (no theme layer wired yet; empty is a safe no-op)
$themeTokens = [];

/**
 * Flatten a canonical schema-1 document's sections back to the flat block
 * array the editor's JS speaks (this editor has no multi-section UI — every
 * document it produces has exactly one implicit section, per DocumentSchema's
 * own legacy-upconversion contract).
 */
function slate_editor_flatten(array $document): array
{
    $out = [];
    foreach (($document['sections'] ?? []) as $section) {
        foreach (($section['blocks'] ?? []) as $b) {
            $out[] = $b;
        }
    }
    return $out;
}

/** Wrap the editor's posted flat layout array into a validated, canonical schema-1 document. */
function slate_editor_document_from_post(array $layoutArr, string $type): array
{
    $document = EditorStateSerializer::serialize(['document' => $layoutArr]);
    $document['type'] = $type;
    return $document;
}

function slate_editor_update_meta(\Slate\Services\Content\ContentPageRepository $pages, int $postId): void
{
    $title = trim($_POST['title'] ?? '');
    $slug  = trim($_POST['slug'] ?? '');
    if ($title !== '' || $slug !== '') {
        $pages->updateMeta($postId, ['title' => $title, 'slug' => $slug]);
    }
}

/** @param mixed $value @return list<string> */
function slate_editor_dependency_keys(mixed $value): array
{
    $found = [];
    $walk = function (mixed $node) use (&$walk, &$found): void {
        if (!is_array($node)) return;
        foreach (['$ref', 'savedAs'] as $key) {
            if (isset($node[$key]) && is_string($node[$key]) && preg_match('/^[a-z][a-z0-9-]{0,95}$/', $node[$key])) {
                $found['global:' . $node[$key]] = true;
            }
        }
        foreach ($node as $child) $walk($child);
    };
    $walk($value);
    $keys = array_keys($found);
    sort($keys, SORT_STRING);
    return $keys;
}

// ── AJAX handlers ────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !empty($_POST['_editor_action'])) {
    header('Content-Type: application/json');

    if (!csrf_verify()) {
        echo json_encode(['ok' => false, 'error' => 'CSRF failed']);
        exit;
    }

    $action = $_POST['_editor_action'];

    // ── Render a single block (AJAX) ─────────────────────────
    if ($action === 'render_block') {
        $blockJson = $_POST['block'] ?? '{}';
        $blockData = json_decode($blockJson, true);
        if (!is_array($blockData) || empty($blockData['type'])) {
            echo json_encode(['ok' => false, 'error' => 'Invalid block']);
            exit;
        }
        $html = $blockRenderer->renderBlock($blockData, $renderCtx);
        echo json_encode(['ok' => true, 'html' => $html]);
        exit;
    }

    // ── Render multiple blocks (batch) ───────────────────────
    if ($action === 'render_blocks') {
        $blocksJson = $_POST['blocks'] ?? '[]';
        $blocksArr = json_decode($blocksJson, true);
        if (!is_array($blocksArr)) $blocksArr = [];
        $results = [];
        foreach ($blocksArr as $b) {
            if (!is_array($b)) { $results[] = ''; continue; }
            $results[] = $blockRenderer->renderBlock($b, $renderCtx);
        }
        echo json_encode(['ok' => true, 'html' => $results]);
        exit;
    }

    if ($action === 'save_draft' || $action === 'publish') {
        if ($action === 'publish' && !Auth::can('content.publish')) {
            echo json_encode(['ok' => false, 'error' => 'No publish permission']);
            exit;
        }

        slate_editor_update_meta($pages, $postId);

        $layoutJson = $_POST['layout'] ?? '[]';
        $layoutArr  = json_decode($layoutJson, true);
        if (!is_array($layoutArr)) $layoutArr = [];

        try {
            $document = slate_editor_document_from_post($layoutArr, $type);
        } catch (\InvalidArgumentException $e) {
            echo json_encode(['ok' => false, 'error' => 'invalid_json', 'message' => $e->getMessage()]);
            exit;
        }

        $validated = DocumentValidator::validate($document, ContentServiceFactory::validatorRegistry());
        if (!$validated['valid']) {
            echo json_encode([
                'ok'     => false,
                'error'  => 'validation_failed',
                'errors' => $validated['errors'],
            ]);
            exit;
        }

        $publication = ContentServiceFactory::publicationService();
        $themeVersion = '1';
        $dependencyKeys = slate_editor_dependency_keys($validated['document']);
        try {
            if ($action === 'publish') {
                $publication->save(CONTENT_PAGE_OWNER_TYPE, $postId, $validated['document'], $renderCtx, $themeVersion, $dependencyKeys);
                $result = $publication->publish(CONTENT_PAGE_OWNER_TYPE, $postId, $renderCtx, $themeVersion, $dependencyKeys);
                if ($result === null) {
                    echo json_encode(['ok' => false, 'error' => 'nothing_to_publish']);
                    exit;
                }
                $pages->markPublished($postId);
                foreach ($dependencyKeys as $dependencyKey) {
                    ContentServiceFactory::invalidationService()->invalidate($dependencyKey);
                }
                echo json_encode(['ok' => true, 'action' => 'published']);
            } else {
                $publication->save(CONTENT_PAGE_OWNER_TYPE, $postId, $validated['document'], $renderCtx, $themeVersion, $dependencyKeys);
                echo json_encode(['ok' => true, 'action' => 'draft_saved']);
            }
        } catch (\Throwable $e) {
            echo json_encode(['ok' => false, 'error' => 'save_failed', 'message' => $e->getMessage()]);
        }
        exit;
    }

    // ── Immutable document operations (top-level blocks only) ────────────
    // Pure — validated but not persisted (no DB write). The client already
    // applied the same change locally for instant feedback; this call exists
    // to surface real, server-side DocumentOperations/DocumentValidator
    // feedback (e.g. a prop that fails validation) without changing what the
    // client treats as authoritative — that stays the Save Draft/Publish
    // round trip, so the existing undo/redo and nested-block (Columns/
    // Container) state machine is untouched.
    if (in_array($action, ['op_insert_block', 'op_move_block', 'op_update_block_props'], true)) {
        $layoutJson = $_POST['layout'] ?? '[]';
        $layoutArr  = json_decode($layoutJson, true);
        if (!is_array($layoutArr)) $layoutArr = [];

        try {
            $document = slate_editor_document_from_post($layoutArr, $type);
            $sectionId = $document['sections'][0]['id'] ?? 's1';

            if ($action === 'op_insert_block') {
                $block = json_decode($_POST['block'] ?? '{}', true);
                if (!is_array($block) || empty($block['type'])) {
                    throw new \InvalidArgumentException('Invalid block.');
                }
                $index = (int) ($_POST['index'] ?? 0);
                $document = DocumentOperations::insertBlock($document, $sectionId, $index, $block);
            } elseif ($action === 'op_move_block') {
                $fromIndex = (int) ($_POST['from_index'] ?? -1);
                $toIndex   = (int) ($_POST['to_index'] ?? -1);
                $document  = DocumentOperations::moveBlock($document, $sectionId, $fromIndex, $sectionId, $toIndex);
            } else {
                $index = (int) ($_POST['index'] ?? -1);
                $patch = json_decode($_POST['patch'] ?? '{}', true);
                if (!is_array($patch)) $patch = [];
                $document = DocumentOperations::updateBlockProps($document, $sectionId, $index, $patch);
            }

            $validated = DocumentValidator::validate($document, ContentServiceFactory::validatorRegistry());
            if (!$validated['valid']) {
                echo json_encode(['ok' => false, 'error' => 'validation_failed', 'errors' => $validated['errors']]);
                exit;
            }
            echo json_encode(['ok' => true, 'layout' => slate_editor_flatten($validated['document'])]);
        } catch (\InvalidArgumentException $e) {
            echo json_encode(['ok' => false, 'error' => 'invalid_operation', 'message' => $e->getMessage()]);
        }
        exit;
    }

    // ── Revision history / restore (RevisionStore only — never a raw UPDATE) ─
    if ($action === 'list_revisions') {
        $rows = $revisions->listForOwner(CONTENT_PAGE_OWNER_TYPE, $postId);
        $out = array_map(static fn (array $r) => [
            'id'         => (int) $r['id'],
            'revision'   => (int) $r['revision'],
            'status'     => $r['status'],
            'author_id'  => $r['author_id'] !== null ? (int) $r['author_id'] : null,
            'note'       => $r['note'],
            'created_at' => $r['created_at'],
        ], $rows);
        echo json_encode(['ok' => true, 'revisions' => $out]);
        exit;
    }

    if ($action === 'restore_revision') {
        $revisionId = (int) ($_POST['revision_id'] ?? 0);
        $target = $revisions->get($revisionId);
        // get() is not owner-scoped — a platform-wide id lookup — so the
        // caller must confirm the fetched row actually belongs to THIS post
        // before treating it as restorable (defense against cross-post
        // restore within the same tenant).
        if ($target === null || $target['owner_type'] !== CONTENT_PAGE_OWNER_TYPE || (int) $target['owner_id'] !== $postId) {
            echo json_encode(['ok' => false, 'error' => 'not_found']);
            exit;
        }
        $document = RevisionStore::documentOf($target);
        $validated = DocumentValidator::validate($document, ContentServiceFactory::validatorRegistry());
        if (!$validated['valid']) {
            echo json_encode(['ok' => false, 'error' => 'validation_failed', 'errors' => $validated['errors']]);
            exit;
        }
        try {
            ContentServiceFactory::publicationService()->save(CONTENT_PAGE_OWNER_TYPE, $postId, $validated['document'], $renderCtx, '1');
            echo json_encode(['ok' => true, 'action' => 'restored', 'layout' => slate_editor_flatten($validated['document'])]);
        } catch (\Throwable $e) {
            echo json_encode(['ok' => false, 'error' => 'restore_failed', 'message' => $e->getMessage()]);
        }
        exit;
    }

    echo json_encode(['ok' => false, 'error' => 'Unknown action']);
    exit;
}

// ── Page meta ────────────────────────────────────────────────
$pageTitle  = 'Visual Editor — ' . e($post['title'] ?? 'Untitled');
$currentNav = 'editor';
$editorMode = true;

$csrfToken = csrf_token();
$postJson  = json_encode([
    'id'        => $postId,
    'title'     => $post['title'] ?? '',
    'slug'      => $post['slug'] ?? '',
    'type'      => $type,
    'status'    => $post['status'] ?? 'draft',
    'layout'    => $layout,
    'hasDraft'  => $hasDraftChanges,
], JSON_HEX_TAG | JSON_HEX_APOS);

$blocksJson = json_encode($blocks, JSON_HEX_TAG | JSON_HEX_APOS);
$mediaJson  = json_encode($mediaMap, JSON_HEX_TAG | JSON_HEX_APOS);
$renderedJson = json_encode($renderedBlocks, JSON_HEX_TAG | JSON_HEX_APOS);

// Public CSS files to inline for canvas
$cssFiles = [
    'plugins/content-builder/assets/css/public.css',
    'plugins/small-business-kit/assets/css/sb.css',
    'plugins/forms/assets/css/public.css',
    'plugins/booking/assets/css/public.css',
];
$canvasCss = '';
foreach ($cssFiles as $rel) {
    $absPath = SLATE_ROOT . '/' . $rel;
    if (file_exists($absPath)) {
        $canvasCss .= file_get_contents($absPath) . "\n";
    }
}
// Add theme tokens as CSS custom properties
$tokenCss = ":root {\n";
foreach ($themeTokens as $name => $val) {
    if (!is_scalar($val)) continue;
    $prop = str_starts_with((string)$name, '--') ? (string)$name : '--' . (string)$name;
    $tokenCss .= "  " . e($prop) . ": " . e((string)$val) . ";\n";
}
$tokenCss .= "}\n";
$canvasCss = $tokenCss . $canvasCss;

$previewUrl = SLATE_URL . '/admin/editor-preview.php?id=' . $postId;
?>
<!DOCTYPE html>
<html lang="en" data-editor-mode>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= e($pageTitle) ?></title>
    <style>
    /* ═══════════════════════════════════════════════════════════
       Slate Visual Editor — Chrome Styles (dark admin shell)
       ═══════════════════════════════════════════════════════════ */
    :root {
        --ve-bg: #0f1117;
        --ve-surface: #181b23;
        --ve-border: #23272f;
        --ve-text: #e4e4e7;
        --ve-text-dim: #9ca3af;
        --ve-accent: #22c55e;
        --ve-accent-hover: #16a34a;
        --ve-danger: #ef4444;
        --ve-radius: 8px;
        --ve-panel-w: 260px;
        --ve-panel-right-w: 300px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--ve-bg); color: var(--ve-text); display: flex; flex-direction: column; }

    /* ── Topbar ─────────────────────────────────────────────── */
    .ve-topbar { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 52px;
                 background: var(--ve-surface); border-bottom: 1px solid var(--ve-border); flex-shrink: 0; z-index: 100; }
    .ve-topbar-left { display: flex; align-items: center; gap: 12px; }
    .ve-back { color: var(--ve-text-dim); text-decoration: none; font-size: 14px; display: flex; align-items: center; gap: 4px; }
    .ve-back:hover { color: var(--ve-text); }
    .ve-status-pill { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .ve-status-draft { background: #854d0e33; color: #fbbf24; }
    .ve-status-published { background: #16653433; color: #4ade80; }
    .ve-unsaved { font-size: 12px; color: #fbbf24; display: flex; align-items: center; gap: 4px; }
    .ve-unsaved::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #fbbf24; }
    .ve-title-input { background: transparent; border: none; color: var(--ve-text); font-size: 15px; font-weight: 600;
                      outline: none; min-width: 120px; max-width: 300px; text-align: center; flex: 1; }
    .ve-title-input:focus { box-shadow: 0 1px 0 var(--ve-accent); }
    .ve-topbar-center { flex: 1; display: flex; justify-content: center; align-items: center; }
    .ve-topbar-right { display: flex; align-items: center; gap: 8px; }
    .ve-device-group { display: flex; border: 1px solid var(--ve-border); border-radius: 6px; overflow: hidden; }
    .ve-device-btn { background: transparent; border: none; color: var(--ve-text-dim); padding: 6px 10px; cursor: pointer; font-size: 16px; }
    .ve-device-btn:hover { color: var(--ve-text); }
    .ve-device-btn.active { background: var(--ve-border); color: var(--ve-accent); }
    .ve-btn { padding: 7px 16px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s; }
    .ve-btn-ghost { background: transparent; color: var(--ve-text-dim); border: 1px solid var(--ve-border); }
    .ve-btn-ghost:hover { color: var(--ve-text); border-color: var(--ve-text-dim); }
    .ve-btn-primary { background: var(--ve-accent); color: #000; }
    .ve-btn-primary:hover { background: var(--ve-accent-hover); }
    .ve-btn-danger { background: #dc262622; color: var(--ve-danger); border: 1px solid var(--ve-danger)44; }
    .ve-btn-danger:hover { background: #dc262633; }

    /* ── Layout ─────────────────────────────────────────────── */
    .ve-layout { display: flex; flex: 1; overflow: hidden; min-width: 0; }

    /* ── Panels ─────────────────────────────────────────────── */
    .ve-panel { width: var(--ve-panel-w); background: var(--ve-surface); border-right: 1px solid var(--ve-border);
                display: flex; flex-direction: column; flex-shrink: 0; overflow-y: auto; }
    .ve-panel-right { width: var(--ve-panel-right-w); border-right: none; border-left: 1px solid var(--ve-border); }
    .ve-panel-tabs { display: flex; border-bottom: 1px solid var(--ve-border); }
    .ve-panel-tab { flex: 1; padding: 10px 0; text-align: center; font-size: 13px; font-weight: 500; cursor: pointer;
                    color: var(--ve-text-dim); border-bottom: 2px solid transparent; transition: all .15s; background: none; border-top: none; border-left: none; border-right: none; }
    .ve-panel-tab.active { color: var(--ve-accent); border-bottom-color: var(--ve-accent); }
    .ve-panel-content { padding: 12px; flex: 1; overflow-y: auto; display: none; }
    .ve-panel-content.active { display: block; }

    /* Block search */
    .ve-search { width: 100%; padding: 8px 12px; background: var(--ve-bg); border: 1px solid var(--ve-border);
                 border-radius: 6px; color: var(--ve-text); font-size: 13px; outline: none; margin-bottom: 12px; }
    .ve-search:focus { border-color: var(--ve-accent); }

    /* Block inserter grid */
    .ve-cat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
                    color: var(--ve-text-dim); margin: 12px 0 6px; }
    .ve-cat-label:first-child { margin-top: 0; }
    .ve-block-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
    .ve-block-item { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 4px;
                     background: var(--ve-bg); border: 1px solid var(--ve-border); border-radius: 6px; cursor: pointer;
                     color: var(--ve-text-dim); font-size: 11px; text-align: center; transition: all .15s; }
    .ve-block-item:hover { border-color: var(--ve-accent); color: var(--ve-text); background: #22c55e0a; }
    .ve-block-item svg { width: 24px; height: 24px; }

    /* Layers */
    .ve-layer { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 6px; cursor: pointer;
                font-size: 13px; color: var(--ve-text-dim); transition: all .12s; }
    .ve-layer:hover { background: #ffffff08; }
    .ve-layer.selected { background: var(--ve-accent)15; color: var(--ve-accent); }
    .ve-layer svg { width: 16px; height: 16px; flex-shrink: 0; }
    .ve-layer-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ve-layer-type { font-size: 11px; color: var(--ve-text-dim); }

    /* Inspector */
    .ve-field { margin-bottom: 14px; }
    .ve-field label { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
                      color: var(--ve-text-dim); margin-bottom: 4px; }
    .ve-field input, .ve-field select, .ve-field textarea { width: 100%; padding: 7px 10px; background: var(--ve-bg);
                      border: 1px solid var(--ve-border); border-radius: 6px; color: var(--ve-text); font-size: 13px; outline: none; }
    .ve-field input:focus, .ve-field select:focus, .ve-field textarea:focus { border-color: var(--ve-accent); }
    .ve-field textarea { resize: vertical; min-height: 60px; }
    .ve-inspector-title { font-size: 14px; font-weight: 600; padding: 12px; border-bottom: 1px solid var(--ve-border); color: var(--ve-text); }
    .ve-inspector-empty { padding: 40px 20px; text-align: center; color: var(--ve-text-dim); font-size: 13px; }

    /* ── Canvas area ────────────────────────────────────────── */
    .ve-canvas-wrap { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; background: #1a1d24;
                      display: flex; flex-direction: column; align-items: center; padding: 24px; }
    .ve-device-bar { width: 100%; display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 16px; flex-shrink: 0; }
    .ve-device-indicator { font-size: 11px; color: var(--ve-text-dim); font-variant-numeric: tabular-nums; letter-spacing: .02em; min-width: 60px; text-align: center; }
    .ve-custom-width-wrap { display: flex; align-items: center; gap: 4px; }
    .ve-custom-width-input { background: var(--ve-bg); border: 1px solid var(--ve-border); border-radius: 4px; color: var(--ve-text); font-size: 11px; padding: 2px 6px; width: 64px; outline: none; }
    .ve-custom-width-input:focus { border-color: var(--ve-accent); }
    .ve-canvas-frame { width: 100%; max-width: 100%; transition: max-width .3s cubic-bezier(.4,0,.2,1), box-shadow .3s ease, border-radius .3s ease; }
    .ve-canvas-frame.device-tablet {
        max-width: 768px;
        border: 10px solid #23272f;
        border-radius: 24px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
    }
    .ve-canvas-frame.device-mobile {
        max-width: 390px;
        border: 12px solid #23272f;
        border-radius: 36px;
        box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
    }
    .ve-canvas { background: #fff; min-height: 400px; overflow: hidden; position: relative; }
    .ve-canvas-frame.device-tablet .ve-canvas { border-radius: 14px; }
    .ve-canvas-frame.device-mobile .ve-canvas { border-radius: 24px; }

    /* ── Style Accordion ─────────────────────────────────────── */
    .ve-accordion { border: 1px solid var(--ve-border); border-radius: 6px; overflow: hidden; margin-bottom: 14px; }
    .ve-accordion-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;
                         cursor: pointer; background: var(--ve-bg); font-size: 12px; font-weight: 600;
                         text-transform: uppercase; letter-spacing: .06em; color: var(--ve-text-dim);
                         user-select: none; transition: color .15s; }
    .ve-accordion-head:hover { color: var(--ve-text); }
    .ve-accordion-head .ve-acc-arrow { font-size: 10px; transition: transform .2s; }
    .ve-accordion-head.open .ve-acc-arrow { transform: rotate(180deg); }
    .ve-accordion-body { padding: 10px 12px; display: none; border-top: 1px solid var(--ve-border); background: var(--ve-surface); }
    .ve-accordion-body.open { display: block; }

    /* color + hex row */
    .ve-color-row { display: flex; align-items: center; gap: 6px; }
    .ve-color-row input[type="color"] { width: 32px; height: 32px; border-radius: 4px; border: 1px solid var(--ve-border); background: none; padding: 1px; cursor: pointer; flex-shrink: 0; }
    .ve-color-row input[type="text"] { flex: 1; padding: 6px 8px; background: var(--ve-bg); border: 1px solid var(--ve-border); border-radius: 6px; color: var(--ve-text); font-size: 12px; font-family: monospace; outline: none; }
    .ve-color-row input[type="text"]:focus { border-color: var(--ve-accent); }

    /* alignment button group */
    .ve-btn-group { display: flex; border: 1px solid var(--ve-border); border-radius: 6px; overflow: hidden; }
    .ve-btn-group button { flex: 1; background: transparent; border: none; color: var(--ve-text-dim); padding: 7px 4px;
                           cursor: pointer; font-size: 15px; transition: all .12s; }
    .ve-btn-group button:hover { color: var(--ve-text); background: #ffffff0a; }
    .ve-btn-group button.active { background: var(--ve-accent)20; color: var(--ve-accent); }

    /* spacing inputs */
    .ve-spacing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .ve-spacing-grid .ve-field { margin-bottom: 0; }
    .ve-spacing-grid .ve-field label { font-size: 10px; }

    /* responsive visibility toggles */
    .ve-visibility-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }
    .ve-vis-btn { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 4px;
                  border: 1px solid var(--ve-border); border-radius: 6px; cursor: pointer; background: var(--ve-bg);
                  font-size: 10px; font-weight: 600; color: var(--ve-text-dim); transition: all .15s; text-transform: uppercase; }
    .ve-vis-btn svg { width: 18px; height: 18px; }
    .ve-vis-btn:hover { border-color: var(--ve-text-dim); color: var(--ve-text); }
    .ve-vis-btn.hidden-on { border-color: var(--ve-danger); color: var(--ve-danger); background: #ef444410; }
    .ve-vis-btn.hidden-on svg { opacity: .5; }

    /* ── Canvas block wrappers (Elementor style) ──────────── */
    .ve-block { position: relative; cursor: pointer; transition: outline .15s ease, box-shadow .15s ease; outline: 1.5px solid transparent; outline-offset: -1px; margin: 0; }
    .ve-block:hover { outline-color: #0073e6; }
    .ve-block.selected { outline: 2px solid #0073e6; z-index: 20; box-shadow: 0 0 0 1px #0073e640; }
    .ve-block.dragging { opacity: .35; outline: 2px dashed #0073e6; }

    /* Elementor floating top-center section bar */
    .ve-block-controls {
        display: none; position: absolute; top: 0; left: 50%; transform: translate(-50%, -50%);
        background: #0073e6; border-radius: 4px; padding: 2px 4px; gap: 2px; z-index: 50;
        box-shadow: 0 2px 10px rgba(0, 115, 230, 0.4), 0 1px 3px rgba(0,0,0,0.3);
        align-items: center; white-space: nowrap; user-select: none;
    }
    .ve-block:hover .ve-block-controls, .ve-block.selected .ve-block-controls { display: inline-flex; }
    .ve-block-controls button {
        background: none; border: none; color: #fff; cursor: pointer; padding: 3px 6px;
        font-size: 13px; border-radius: 3px; line-height: 1; display: flex; align-items: center; justify-content: center;
        transition: background .12s;
    }
    .ve-block-controls button:hover { background: rgba(255, 255, 255, 0.25); }
    .ve-block-controls .ve-handle-title {
        color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; cursor: grab;
        text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; gap: 4px;
    }
    .ve-block-controls .ve-handle-title:hover { background: rgba(255, 255, 255, 0.15); border-radius: 3px; }

    .ve-block-label { display: none; }
    .ve-block-inner { position: relative; pointer-events: none; min-height: 20px; }
    .ve-block-inner [contenteditable="true"] { outline: none; cursor: text; pointer-events: auto; }
    .ve-block-inner [contenteditable="true"]:focus { box-shadow: inset 0 0 0 1px #0073e660; border-radius: 2px; }
    .ve-block-inner a, .ve-block-inner button, .ve-block-inner input,
    .ve-block-inner select, .ve-block-inner textarea { pointer-events: none; }

    /* Interactive Column & Container slots (Elementor style) */
    .ve-block-inner [data-slot-action] { pointer-events: auto !important; }
    .ve-empty-col-placeholder, .ve-empty-container-placeholder {
        border: 2px dashed #0073e640; border-radius: 8px; padding: 24px 16px;
        min-height: 90px; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 6px; background: #f8fafc; cursor: pointer; transition: all .15s ease; user-select: none;
        margin: 4px; width: 100%; box-sizing: border-box;
    }
    .ve-empty-col-placeholder:hover, .ve-empty-container-placeholder:hover {
        border-color: #0073e6; background: #f0f7ff; box-shadow: 0 2px 10px rgba(0, 115, 230, 0.12);
    }
    .ve-slot-icon {
        width: 32px; height: 32px; border-radius: 50%; background: #0073e618; color: #0073e6;
        display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700;
    }
    .ve-slot-text { font-size: 12px; font-weight: 600; color: #1e293b; }
    .ve-slot-sub { font-size: 11px; color: #64748b; }
    .ve-slot-add-bar { display: flex; justify-content: center; padding: 8px 4px; }
    .ve-slot-mini-add-btn {
        background: #0073e614; color: #0073e6; border: 1px dashed #0073e660;
        border-radius: 4px; padding: 4px 12px; font-size: 11px; font-weight: 600;
        cursor: pointer; transition: all .12s;
    }
    .ve-slot-mini-add-btn:hover { background: #0073e6; color: #fff; border-style: solid; }
    .ve-slot-target { border-color: #0073e6 !important; background: #f0f7ff !important; box-shadow: 0 0 0 2px #0073e6 !important; }

    /* Elementor-style Add Section Box at bottom */
    .ve-el-add-section {
        margin: 40px auto; max-width: 680px; padding: 28px 20px; border: 2px dashed #0073e650;
        border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 12px; background: #fafbff; cursor: pointer; transition: all .2s ease; user-select: none;
    }
    .ve-el-add-section:hover { border-color: #0073e6; background: #f0f7ff; box-shadow: 0 4px 16px rgba(0,115,230,0.1); }
    .ve-el-add-section.hovering { border-color: #22c55e; background: #22c55e10; }
    .ve-el-add-btn {
        width: 46px; height: 46px; border-radius: 50%; background: #e23769; color: #fff;
        border: none; font-size: 26px; font-weight: 300; display: flex; align-items: center; justify-content: center;
        cursor: pointer; box-shadow: 0 4px 14px rgba(226, 55, 105, 0.4); transition: transform .15s, background .15s;
    }
    .ve-el-add-btn:hover { transform: scale(1.1); background: #d02657; }
    .ve-el-add-label { font-size: 13px; font-weight: 600; color: #64748b; letter-spacing: .02em; }

    /* Drop indicator */
    .ve-drop-indicator { height: 3px; background: var(--ve-accent); border-radius: 2px; margin: 0 16px; transition: opacity .1s; }
    .ve-drop-zone { height: 0; transition: height .15s; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .ve-drop-zone.active { height: 4px; }
    .ve-drop-zone.hovering { height: 40px; background: #22c55e10; border: 2px dashed #22c55e40; border-radius: 6px; margin: 4px 0; }

    /* Nested blocks (inside Columns / Flex Container) */
    .ve-nested-block { position: relative; outline: 1px dashed transparent; outline-offset: 1px; }
    .ve-nested-block:hover { outline-color: rgba(0,115,230,0.5); }
    .ve-nested-block.selected { outline: 2px solid #0073e6; }
    .ve-nested-controls {
        position: absolute; top: -15px; left: 0; z-index: 6;
        display: none; align-items: center; gap: 2px;
        background: #0073e6; color: #fff; border-radius: 4px 4px 0 0;
        padding: 2px 3px; font-size: 10px; line-height: 1; white-space: nowrap;
    }
    .ve-nested-block:hover > .ve-nested-controls,
    .ve-nested-block.selected > .ve-nested-controls { display: inline-flex; }
    .ve-nested-controls button {
        background: transparent; border: 0; color: #fff; cursor: pointer;
        font-size: 11px; padding: 1px 4px; border-radius: 3px; line-height: 1.4;
    }
    .ve-nested-controls button:hover { background: rgba(255,255,255,.25); }
    .ve-nested-label { display: inline-flex; align-items: center; padding: 0 2px; }
    .ve-nested-label svg { width: 11px; height: 11px; vertical-align: middle; }

    /* Add-block zone between blocks */
    .ve-add-between { height: 0; position: relative; overflow: visible; display: flex; justify-content: center; }
    .ve-add-between-btn { display: none; position: absolute; top: -12px; width: 24px; height: 24px; border-radius: 50%;
                          background: var(--ve-accent); color: #000; border: none; cursor: pointer; font-size: 16px; font-weight: 700;
                          line-height: 1; z-index: 15; box-shadow: 0 2px 8px #0003; }
    .ve-add-between:hover .ve-add-between-btn { display: flex; align-items: center; justify-content: center; }
    .ve-add-between::before { content: ''; position: absolute; top: -1px; left: 16px; right: 16px; height: 2px; background: transparent; transition: background .15s; }
    .ve-add-between:hover::before { background: var(--ve-accent); }

    /* Empty canvas state */
    .ve-empty-canvas { display: flex; flex-direction: column; align-items: center; justify-content: center;
                       min-height: 300px; color: #9ca3af; gap: 12px; padding: 48px; }
    .ve-empty-canvas svg { width: 48px; height: 48px; opacity: .4; }
    .ve-empty-canvas p { font-size: 14px; }
    .ve-add-block-btn { background: var(--ve-accent)18; color: var(--ve-accent); border: 1px dashed var(--ve-accent)50;
                        padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .ve-add-block-btn:hover { background: var(--ve-accent)28; border-color: var(--ve-accent); }

    /* Toast */
    .ve-toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; font-size: 13px;
                font-weight: 500; z-index: 9999; animation: veToast .3s ease; box-shadow: 0 8px 24px #0004; }
    .ve-toast-success { background: #16a34a; color: #fff; }
    .ve-toast-error { background: #dc2626; color: #fff; }
    @keyframes veToast { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    /* Saving overlay */
    .ve-saving { position: fixed; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, var(--ve-accent), #3b82f6, var(--ve-accent));
                 background-size: 200% auto; animation: veSaving 1s linear infinite; z-index: 9999; display: none; }
    .ve-saving.active { display: block; }
    @keyframes veSaving { 0% { background-position: 0 0; } 100% { background-position: 200% 0; } }
    </style>
    <link rel="stylesheet" href="<?= e(SLATE_URL) ?>/plugins/media-library/assets/css/picker.css">
</head>
<body>

<div class="ve-saving" id="savingBar"></div>

<!-- ── Topbar ────────────────────────────────────────────────── -->
<div class="ve-topbar">
    <div class="ve-topbar-left">
        <a class="ve-back" href="<?= e(SLATE_URL . '/admin/posts.php?type=' . urlencode($type)) ?>">← Back</a>
        <span class="ve-status-pill ve-status-<?= e($post['status'] ?? 'draft') ?>" id="statusPill">
            <?= e(strtoupper($post['status'] ?? 'draft')) ?>
        </span>
        <span class="ve-unsaved" id="unsavedDot" style="display:<?= $hasDraftChanges ? 'flex' : 'none' ?>">Unsaved changes</span>
    </div>

    <div class="ve-topbar-center">
        <input type="text" class="ve-title-input" id="titleInput"
               value="<?= e($post['title'] ?? 'Untitled') ?>" placeholder="Page title…">
    </div>

    <div class="ve-topbar-right">
        <div class="ve-device-group">
            <button class="ve-device-btn active" data-device="desktop" title="Desktop"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.6" y="4" width="18.8" height="12.6" rx="1.8"/><path d="M8.6 20.8h6.8"/><path d="M12 16.6v4.2"/></svg></button>
            <button class="ve-device-btn" data-device="tablet" title="Tablet"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.6" y="2.6" width="12.8" height="18.8" rx="2.2"/><path d="M11.4 18.6h1.2"/></svg></button>
            <button class="ve-device-btn" data-device="mobile" title="Mobile"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7.2" y="2.6" width="9.6" height="18.8" rx="2.2"/><path d="M11.4 18.2h1.2"/></svg></button>
        </div>
        <a href="<?= e($previewUrl) ?>" target="_blank" class="ve-btn ve-btn-ghost">Preview</a>
        <button class="ve-btn ve-btn-ghost" id="btnSave">Save Draft</button>
        <button class="ve-btn ve-btn-primary" id="btnPublish">Publish</button>
    </div>
</div>

<!-- ── Layout ────────────────────────────────────────────────── -->
<div class="ve-layout">

    <!-- Left panel: Block inserter + Layers -->
    <div class="ve-panel">
        <div class="ve-panel-tabs">
            <button class="ve-panel-tab active" data-tab="blocks">Blocks</button>
            <button class="ve-panel-tab" data-tab="layers">Layers</button>
        </div>
        <div class="ve-panel-content active" id="tabBlocks">
            <input type="text" class="ve-search" id="blockSearch" placeholder="Search blocks…">
            <div id="blockList"></div>
        </div>
        <div class="ve-panel-content" id="tabLayers">
            <div id="layerTree"></div>
        </div>
    </div>

    <!-- Center canvas -->
    <div class="ve-canvas-wrap">
        <div class="ve-device-bar">
            <span class="ve-device-indicator" id="deviceIndicator">Desktop</span>
            <div class="ve-custom-width-wrap">
                <input type="number" class="ve-custom-width-input" id="customWidthInput" placeholder="px" min="320" max="2560" title="Custom canvas width">
                <span style="font-size:11px;color:var(--ve-text-dim)">px</span>
            </div>
        </div>
        <div class="ve-canvas-frame" id="canvasFrame">
            <div class="ve-canvas cb-public" id="canvas">
                <!-- Blocks render here as real HTML -->
            </div>
        </div>
    </div>

    <!-- Right panel: Inspector + Page settings -->
    <div class="ve-panel ve-panel-right">
        <div class="ve-panel-tabs">
            <button class="ve-panel-tab active" data-tab="inspector">Inspector</button>
            <button class="ve-panel-tab" data-tab="page">Page</button>
            <button class="ve-panel-tab" data-tab="history">History</button>
        </div>
        <div class="ve-panel-content active" id="tabInspector">
            <div id="inspectorContent">
                <div class="ve-inspector-empty">Select a block to edit its properties</div>
            </div>
        </div>
        <div class="ve-panel-content" id="tabPage">
            <div class="ve-field">
                <label>Title</label>
                <input type="text" id="settingsTitle" value="<?= e($post['title'] ?? '') ?>">
            </div>
            <div class="ve-field">
                <label>Slug</label>
                <input type="text" id="settingsSlug" value="<?= e($post['slug'] ?? '') ?>">
            </div>
            <div class="ve-field">
                <label>Type</label>
                <input type="text" value="<?= e($type) ?>" disabled>
            </div>
            <div class="ve-field">
                <label>Status</label>
                <input type="text" id="settingsStatus" value="<?= e($post['status'] ?? 'draft') ?>" disabled>
            </div>
        </div>
        <div class="ve-panel-content" id="tabHistory">
            <div id="historyList"><div class="ve-inspector-empty">Loading…</div></div>
        </div>
    </div>

</div>

<!-- Canvas CSS (loaded from site theme + public.css) injected into a scoped style -->
<style id="canvasCss">
.ve-canvas.cb-public {
    /* Base resets for the canvas */
    font-family: var(--slate-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    line-height: 1.65;
    color: var(--slate-color-text, #1d2939);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}
/* Block-level style overrides applied by the editor */
.ve-block-style { display: block; }
/* Responsive visibility — mirrors canvas device breakpoints */
@media (min-width: 1025px)  { .ve-hide-desktop { display: none !important; } }
@media (min-width: 769px) and (max-width: 1024px) { .ve-hide-tablet  { display: none !important; } }
@media (max-width: 768px)   { .ve-hide-mobile  { display: none !important; } }
/* Editor preview device state mapping for CSS */
.device-mobile .cb-columns.cb-cols-stack { grid-template-columns: 1fr; }
<?= $canvasCss ?>
</style>

<script>
(function() {
    'use strict';

    const CSRF   = <?= json_encode($csrfToken) ?>;
    const POST   = <?= $postJson ?>;
    const BLOCKS = <?= $blocksJson ?>;
    const MEDIA  = <?= $mediaJson ?>;
    const RENDERED = <?= $renderedJson ?>;
    const SAVE_URL    = window.location.pathname;
    const PREVIEW_URL = <?= json_encode($previewUrl) ?>;

    // ── State ─────────────────────────────────────────────────
    let layout = JSON.parse(JSON.stringify(POST.layout || []));
    let selectedBlockIndex = -1;
    let selectedNestedPath = null; // null = top-level selection; else array of {slot:'col'|'children', col?:N, index:N} steps relative to layout[selectedBlockIndex].props
    let pendingInsertTarget = null; // {topIdx, path} — when set, the next insertBlock() splices into that nested slot instead of the top-level layout
    let isDirty = POST.hasDraft;
    let isSaving = false;
    let insertAtIndex = -1; // When set, next insertBlock() inserts here
    let dragSourceIdx = -1;

    // Undo/Redo stacks (stores layout + rendered snapshots)
    const undoStack = [];
    const redoStack = [];
    const MAX_UNDO = 40;
    function pushUndo() {
        undoStack.push({ layout: JSON.parse(JSON.stringify(layout)), rendered: [...RENDERED] });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
    }
    function undo() {
        if (!undoStack.length) return;
        redoStack.push({ layout: JSON.parse(JSON.stringify(layout)), rendered: [...RENDERED] });
        const snap = undoStack.pop();
        layout = snap.layout;
        RENDERED.length = 0;
        snap.rendered.forEach(r => RENDERED.push(r));
        selectedBlockIndex = -1;
        markDirty();
        rebuildCanvas();
        toast('Undo', 'success');
    }
    function redo() {
        if (!redoStack.length) return;
        undoStack.push({ layout: JSON.parse(JSON.stringify(layout)), rendered: [...RENDERED] });
        const snap = redoStack.pop();
        layout = snap.layout;
        RENDERED.length = 0;
        snap.rendered.forEach(r => RENDERED.push(r));
        selectedBlockIndex = -1;
        markDirty();
        rebuildCanvas();
        toast('Redo', 'success');
    }

    // Debounce helper
    let renderTimer = null;
    function debounceRender(blockIdx, delay = 350) {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(async () => {
            const html = await renderBlockServer(layout[blockIdx]);
            RENDERED[blockIdx] = html;
            const blockEl = document.querySelector('.ve-block[data-index="' + blockIdx + '"]');
            if (blockEl) {
                const inner = blockEl.querySelector('.ve-block-inner');
                if (inner) {
                    inner.innerHTML = html;
                    enableContentEditable(blockEl, blockIdx);
                    hydrateNestedBlocks(inner, layout[blockIdx], blockIdx, []);
                }
                applyBlockStyleToEl(blockEl, layout[blockIdx].style);
            }
        }, delay);
    }

    // Re-fetch a top-level block's full rendered HTML from the server and refresh its DOM + nested wiring.
    // Used for structural changes (insert/delete/move/duplicate) made to a NESTED block inside it.
    async function refreshTopLevelBlock(topIdx) {
        const html = await renderBlockServer(layout[topIdx]);
        RENDERED[topIdx] = html;
        const wrapper = document.querySelector('.ve-block[data-index="' + topIdx + '"]');
        if (wrapper) {
            const inner = wrapper.querySelector('.ve-block-inner');
            if (inner) {
                inner.innerHTML = html;
                enableContentEditable(wrapper, topIdx);
                hydrateNestedBlocks(inner, layout[topIdx], topIdx, []);
            }
            applyBlockStyleToEl(wrapper, layout[topIdx].style);
        }
    }

    // ── Nested block addressing (Columns / Flex Container children) ─────
    // A "step" is {slot:'col', col:N, index:N} or {slot:'children', index:N}.
    // A "path" is an ordered array of steps from the top-level block's props down to a target block.
    function getSlotArray(block, step) {
        if (!block || !block.props) return null;
        if (step.slot === 'col') {
            block.props.cols = block.props.cols || [];
            block.props.cols[step.col] = block.props.cols[step.col] || { blocks: [] };
            block.props.cols[step.col].blocks = block.props.cols[step.col].blocks || [];
            return block.props.cols[step.col].blocks;
        }
        if (step.slot === 'children') {
            block.props.children = block.props.children || [];
            return block.props.children;
        }
        return null;
    }
    // Resolve the array a PATH's final step refers to, by walking through all preceding
    // steps' blocks first. Used both to read an existing nested block's containing array
    // and to find where a brand-new block should be spliced in.
    function resolveSlotArrayForPath(topBlock, path) {
        if (!path || !path.length) return null;
        let block = topBlock;
        for (let i = 0; i < path.length - 1; i++) {
            const arr = getSlotArray(block, path[i]);
            if (!arr) return null;
            block = arr[path[i].index];
            if (!block) return null;
        }
        return getSlotArray(block, path[path.length - 1]);
    }
    function getSelectedParentInfo() {
        if (selectedBlockIndex < 0) return null;
        if (!selectedNestedPath || !selectedNestedPath.length) return { arr: layout, idx: selectedBlockIndex };
        const arr = resolveSlotArrayForPath(layout[selectedBlockIndex], selectedNestedPath);
        if (!arr) return null;
        return { arr, idx: selectedNestedPath[selectedNestedPath.length - 1].index };
    }
    function getSelectedBlock() {
        if (selectedBlockIndex < 0 || !layout[selectedBlockIndex]) return null;
        if (!selectedNestedPath || !selectedNestedPath.length) return layout[selectedBlockIndex];
        const info = getSelectedParentInfo();
        return info ? info.arr[info.idx] : null;
    }
    function nestedPathKey(path) { return JSON.stringify(path); }
    function getSelectedBlockEl() {
        if (selectedBlockIndex < 0) return null;
        const topEl = document.querySelector('.ve-block[data-index="' + selectedBlockIndex + '"]');
        if (!topEl) return null;
        if (!selectedNestedPath || !selectedNestedPath.length) return topEl;
        const key = nestedPathKey(selectedNestedPath);
        return Array.from(topEl.querySelectorAll('.ve-nested-block[data-nested-path]')).find(el => el.dataset.nestedPath === key) || null;
    }
    function selectNestedBlock(topIdx, path) {
        selectedBlockIndex = topIdx;
        selectedNestedPath = path;
        document.querySelectorAll('.ve-block, .ve-nested-block').forEach(el => el.classList.remove('selected'));
        const el = getSelectedBlockEl();
        if (el) el.classList.add('selected');
        renderLayers();
        renderInspector();
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    // Unified duplicate/move/delete for whichever block is currently selected, top-level or nested.
    function handleSelectedAction(action) {
        if (selectedBlockIndex < 0) return;
        if (!selectedNestedPath || !selectedNestedPath.length) {
            handleBlockAction(selectedBlockIndex, action);
            return;
        }
        const info = getSelectedParentInfo();
        if (!info) return;
        const { arr, idx } = info;
        const topIdx = selectedBlockIndex;
        const lastStep = selectedNestedPath[selectedNestedPath.length - 1];
        if (action === 'up' && idx > 0) {
            [arr[idx], arr[idx-1]] = [arr[idx-1], arr[idx]];
            selectedNestedPath = [...selectedNestedPath.slice(0, -1), { ...lastStep, index: idx - 1 }];
        } else if (action === 'down' && idx < arr.length - 1) {
            [arr[idx], arr[idx+1]] = [arr[idx+1], arr[idx]];
            selectedNestedPath = [...selectedNestedPath.slice(0, -1), { ...lastStep, index: idx + 1 }];
        } else if (action === 'dup') {
            const clone = JSON.parse(JSON.stringify(arr[idx]));
            arr.splice(idx + 1, 0, clone);
            selectedNestedPath = [...selectedNestedPath.slice(0, -1), { ...lastStep, index: idx + 1 }];
        } else if (action === 'delete') {
            arr.splice(idx, 1);
            selectedBlockIndex = -1;
            selectedNestedPath = null;
        } else {
            return;
        }
        markDirty();
        refreshTopLevelBlock(topIdx).then(() => { renderLayers(); renderInspector(); });
    }
    // Wire a "+ Add Widget" button or empty-slot placeholder to open the block picker for a slot.
    function wireSlotInsertTarget(el, getTarget) {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            pendingInsertTarget = getTarget();
            const blocksTab = document.querySelector('[data-tab="blocks"]');
            if (blocksTab && !blocksTab.classList.contains('active')) blocksTab.click();
        });
    }
    // Accept a block dragged in from the sidebar palette and insert it into a slot.
    function wireSlotDropTarget(el, getTarget) {
        el.addEventListener('dragover', (e) => {
            if (!Array.from(e.dataTransfer.types).includes('application/x-slate-block-type')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            el.classList.add('ve-slot-target');
        });
        el.addEventListener('dragleave', () => el.classList.remove('ve-slot-target'));
        el.addEventListener('drop', (e) => {
            if (!Array.from(e.dataTransfer.types).includes('application/x-slate-block-type')) return;
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('ve-slot-target');
            const type = e.dataTransfer.getData('application/x-slate-block-type');
            if (!type) return;
            pendingInsertTarget = getTarget();
            insertBlock(type);
        });
    }
    // One column / flex-container "slot": zips its rendered DOM children 1:1 against the
    // block's own JSON children array, wrapping each with selection/edit/reorder chrome, and
    // wires the slot's "+ Add Widget" affordance and sidebar-drop target.
    function hydrateSlot(slotEl, blocksArr, topIdx, basePath, makeStep) {
        const chromeSelector = '.ve-empty-col-placeholder, .ve-empty-container-placeholder, .ve-slot-add-bar';
        const kids = Array.from(slotEl.children);
        const contentEls = kids.filter(el => !el.matches(chromeSelector));
        const chromeEls = kids.filter(el => el.matches(chromeSelector));
        if (contentEls.length === blocksArr.length) {
            contentEls.forEach((el, i) => {
                wrapNestedBlock(el, blocksArr[i], topIdx, [...basePath, makeStep(i)]);
            });
        }
        chromeEls.forEach(chromeEl => {
            wireSlotInsertTarget(chromeEl, () => ({ topIdx, path: [...basePath, makeStep(blocksArr.length)] }));
        });
        wireSlotDropTarget(slotEl, () => ({ topIdx, path: [...basePath, makeStep(blocksArr.length)] }));
    }
    // Walks a rendered block's own DOM and, if it's a Columns or Flex Container block, hydrates
    // each of its slots. Called both for top-level blocks and recursively for nested ones, so
    // containers/columns nested inside other containers/columns work too.
    // rootEl.querySelector() only matches descendants — for a NESTED columns/container block,
    // rootEl IS the .cb-columns/.cb-container element itself (wrapNestedBlock doesn't add an
    // extra wrapper), so querySelector alone would miss it. Match self-or-descendant instead.
    function selfOrDescendant(rootEl, selector) {
        return rootEl.matches(selector) ? rootEl : rootEl.querySelector(selector);
    }
    function hydrateNestedBlocks(rootEl, block, topIdx, path) {
        if (!block || !block.type) return;
        if (block.type === 'columns') {
            const colsRoot = selfOrDescendant(rootEl, '.cb-columns');
            if (!colsRoot) return;
            const cols = (block.props && block.props.cols) || [];
            colsRoot.querySelectorAll(':scope > .cb-col[data-col-index]').forEach((colEl) => {
                const colIdx = parseInt(colEl.dataset.colIndex, 10);
                const blocksArr = (cols[colIdx] && cols[colIdx].blocks) || [];
                hydrateSlot(colEl, blocksArr, topIdx, path, (i) => ({ slot: 'col', col: colIdx, index: i }));
            });
        } else if (block.type === 'container') {
            const containerRoot = selfOrDescendant(rootEl, '.cb-container');
            if (!containerRoot) return;
            const children = (block.props && block.props.children) || [];
            hydrateSlot(containerRoot, children, topIdx, path, (i) => ({ slot: 'children', index: i }));
        }
    }
    // Wraps one nested block's already-rendered DOM element with selection + edit + reorder
    // chrome, mirroring what appendBlockToCanvas does for top-level blocks.
    function wrapNestedBlock(el, block, topIdx, path) {
        if (el.dataset.nestedHydrated === '1') return;
        el.dataset.nestedHydrated = '1';
        el.classList.add('ve-nested-block');
        el.dataset.nestedPath = nestedPathKey(path);

        // Recurse FIRST, while el's only children are still its server-rendered content —
        // this block may itself be a Columns / Flex Container. If we appended our own
        // .ve-nested-controls bar before recursing, hydrateSlot's child/blocksArr length
        // check below would count that bar as an extra "content" child and refuse to wrap
        // anything inside (a real bug seen with a Container nested inside a Column).
        hydrateNestedBlocks(el, block, topIdx, path);

        const def = BLOCKS[block.type] || {};
        const bar = document.createElement('div');
        bar.className = 've-nested-controls';
        bar.innerHTML =
            '<span class="ve-nested-label" title="' + escHtml(def.label || block.type) + '">' + blockIcon(block.type) + '</span>' +
            '<button type="button" data-naction="up" title="Move up">↑</button>' +
            '<button type="button" data-naction="down" title="Move down">↓</button>' +
            '<button type="button" data-naction="dup" title="Duplicate">⧉</button>' +
            '<button type="button" data-naction="delete" title="Delete">✕</button>';
        // For a heading/paragraph, el IS the contenteditable surface itself (see below), so this
        // bar ends up as a CHILD of editable content, not a separate sibling like top-level blocks
        // get. contentEditable=false keeps it an atomic, non-typable island; the 'input' handler
        // below additionally strips it out before saving, since a select-all-and-replace can still
        // pull it into the browser's edit — belt and suspenders.
        bar.contentEditable = 'false';
        el.appendChild(bar);

        bar.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                pushUndo();
                selectedBlockIndex = topIdx;
                selectedNestedPath = path;
                handleSelectedAction(btn.dataset.naction);
            });
        });

        el.addEventListener('click', (e) => {
            if (e.target.closest('.ve-nested-controls')) return;
            if (e.target.isContentEditable) return;
            e.stopPropagation();
            selectNestedBlock(topIdx, path);
        });

        if (block.type === 'heading' || block.type === 'paragraph') {
            const textEl = el.matches('.cb-heading, .cb-paragraph, h1, h2, h3, h4, h5, h6, p')
                ? el
                : el.querySelector('.cb-heading, .cb-paragraph, h1, h2, h3, h4, h5, h6, p');
            if (textEl) {
                textEl.contentEditable = 'true';
                textEl.style.pointerEvents = 'auto';
                textEl.addEventListener('focus', (e) => {
                    e.stopPropagation();
                    selectNestedBlock(topIdx, path);
                });
                textEl.addEventListener('input', () => {
                    const clone = textEl.cloneNode(true);
                    clone.querySelectorAll('.ve-nested-controls').forEach(n => n.remove());
                    block.props.text = clone.innerHTML;
                    markDirty();
                });
            }
        }
    }

    function enableContentEditable(blockEl, idx) {
        const type = layout[idx]?.type;
        if (type === 'heading' || type === 'paragraph') {
            const textEl = blockEl.querySelector('.ve-block-inner .cb-heading, .ve-block-inner .cb-paragraph, .ve-block-inner h1, .ve-block-inner h2, .ve-block-inner h3, .ve-block-inner h4, .ve-block-inner h5, .ve-block-inner h6, .ve-block-inner p');
            if (textEl) {
                textEl.contentEditable = 'true';
                textEl.style.pointerEvents = 'auto';
                textEl.addEventListener('input', () => {
                    layout[idx].props.text = textEl.innerHTML;
                    markDirty();
                });
            }
        }
    }

    // ── DOM refs ──────────────────────────────────────────────
    const $canvas       = document.getElementById('canvas');
    const $canvasFrame  = document.getElementById('canvasFrame');
    const $blockList    = document.getElementById('blockList');
    const $layerTree    = document.getElementById('layerTree');
    const $inspector    = document.getElementById('inspectorContent');
    const $titleInput   = document.getElementById('titleInput');
    const $settingsTitle= document.getElementById('settingsTitle');
    const $settingsSlug = document.getElementById('settingsSlug');
    const $statusPill   = document.getElementById('statusPill');
    const $unsavedDot   = document.getElementById('unsavedDot');
    const $savingBar    = document.getElementById('savingBar');
    const $searchInput  = document.getElementById('blockSearch');

    // ── Helpers ───────────────────────────────────────────────
    function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    function toast(msg, type = 'success') {
        const el = document.createElement('div');
        el.className = 've-toast ve-toast-' + type;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }
    function showSaving(on) {
        $savingBar.classList.toggle('active', on);
    }
    function markDirty() {
        isDirty = true;
        $unsavedDot.style.display = 'flex';
    }
    function updateStatusPill(status) {
        $statusPill.textContent = status.toUpperCase();
        $statusPill.className = 've-status-pill ve-status-' + status;
        document.getElementById('settingsStatus').value = status;
    }

    // ── Block icons ───────────────────────────────────────────
    const BLOCK_ICONS = {
        'heading':     '<path d="M4 12h16M4 4v16M20 4v16"/>',
        'paragraph':   '<path d="M13 4v16M17 4H9.5a4.5 4.5 0 000 9H13"/>',
        'image':       '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
        'button':      '<rect x="3" y="8" width="18" height="8" rx="3"/><path d="M8 12h8"/>',
        'columns':     '<rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/>',
        'html':        '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
        'react':       '<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>',
        'post-list':   '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
        'hero':        '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M8 10h8M10 14h4"/>',
        'icon-grid':   '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
        'image-grid':  '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
        'cta':         '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 10v4M10 12h4"/>',
        'testimonial': '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
        'rx-hero':     '<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 8h10M9 12h6M11 16h2"/>',
        'rx-marquee':  '<path d="M2 12h20M5 8h14M5 16h14"/>',
        'rx-story':    '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h8M8 14h4"/>',
        'rx-menu':     '<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="19" cy="6" r="1"/><circle cx="19" cy="12" r="1"/>',
        'rx-gallery':  '<rect x="2" y="4" width="6" height="6" rx="1"/><rect x="9" y="4" width="6" height="6" rx="1"/><rect x="16" y="4" width="6" height="6" rx="1"/><rect x="2" y="14" width="6" height="6" rx="1"/><rect x="9" y="14" width="6" height="6" rx="1"/>',
        'rx-reviews':  '<path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>',
        'rx-visit':    '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>',
        'spacer':      '<path d="M12 5v14M5 12h14" opacity=".3"/><path d="M3 5h18M3 19h18"/>',
        'divider':     '<path d="M3 12h18"/>',
        'container':   '<rect x="2" y="2" width="20" height="20" rx="2" stroke-dasharray="4 2"/>',
        'booking':     '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/><path d="M8 14h2v2H8z"/>',
        'form':        '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h8M8 14h5"/><rect x="8" y="17" width="8" height="2" rx="1"/>',
        'membership-plans':'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/>',
        'product-list':'<path d="M8 6h13M8 12h13M8 18h13"/><rect x="2" y="4" width="4" height="4" rx="1"/><rect x="2" y="10" width="4" height="4" rx="1"/><rect x="2" y="16" width="4" height="4" rx="1"/>',
        'shop':        '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/>',
        'sb-hero':     '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 9h10M9 13h6"/><rect x="9" y="16" width="6" height="2" rx="1"/>',
        'sb-page-hero':'<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M6 10h12M8 14h8"/>',
        'sb-feature-grid':'<rect x="2" y="2" width="9" height="9" rx="1"/><rect x="13" y="2" width="9" height="9" rx="1"/><rect x="2" y="13" width="9" height="9" rx="1"/><circle cx="6.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="6.5" r="1.5"/>',
        'sb-split':    '<rect x="2" y="3" width="9" height="18" rx="1"/><path d="M14 8h7M14 12h5M14 16h6"/>',
        'sb-quote-grid':'<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2-2-2H6c-1.25 0-2 .75-2 2v6c0 1 .76 2 2 2h2s-.04 1.95-2 3.5"/>',
        'sb-cta-band': '<rect x="1" y="8" width="22" height="8" rx="2"/><path d="M6 12h7M17 10v4"/>',
        'sb-contact-grid':'<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/>',
        'sb-survey-tabs':'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
        'sb-contact-panel':'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h4M7 11h10M7 15h6"/>',
        '_default':    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>',
    };
    function blockIcon(type) {
        const svg = BLOCK_ICONS[type] || BLOCK_ICONS['_default'];
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + svg + '</svg>';
    }

    // ── Block inserter ────────────────────────────────────────
    function renderBlockList(filter = '') {
        const cats = {};
        for (const [type, def] of Object.entries(BLOCKS)) {
            if (filter && !def.label.toLowerCase().includes(filter.toLowerCase())) continue;
            const cat = def.category || 'Common';
            if (!cats[cat]) cats[cat] = [];
            cats[cat].push({ type, label: def.label });
        }
        let html = '';
        for (const [cat, items] of Object.entries(cats)) {
            html += '<div class="ve-cat-label">' + cat + '</div><div class="ve-block-grid">';
            for (const item of items) {
                html += '<div class="ve-block-item" data-type="' + item.type + '" draggable="true">'
                    + blockIcon(item.type) + '<span>' + item.label + '</span></div>';
            }
            html += '</div>';
        }
        $blockList.innerHTML = html || '<div class="ve-inspector-empty">No blocks found</div>';

        // Click to insert
        $blockList.querySelectorAll('.ve-block-item').forEach(el => {
            el.addEventListener('click', () => insertBlock(el.dataset.type));
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/x-slate-block-type', el.dataset.type);
            });
        });
    }

    // ── Phase 2 document operations (top-level blocks only) ────
    // Fire-and-forget: routes the same change the client just applied locally
    // through DocumentOperations + DocumentValidator server-side, purely for
    // real validation feedback (e.g. a prop that fails a field constraint).
    // The response is never adopted back into `layout`/`RENDERED` — that would
    // require reconciling this editor's undo/redo and nested-block (Columns/
    // Container) addressing against a server round trip, which is out of
    // scope for this migration. Save Draft / Publish remain the authoritative
    // persistence path.
    async function postEditorOp(action, params, baseLayout) {
        try {
            const body = new URLSearchParams();
            body.append('_editor_action', action);
            body.append('_csrf', CSRF);
            body.append('layout', JSON.stringify(baseLayout || layout));
            for (const [k, v] of Object.entries(params)) {
                body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            }
            const res = await fetch(SAVE_URL + '?id=' + POST.id, { method: 'POST', body });
            const json = await res.json();
            if (!json.ok) {
                toast((json.errors && json.errors[0] && json.errors[0].message) || json.error || 'Validation warning', 'error');
            }
        } catch (e) { /* best-effort only */ }
    }

    // ── Insert block ──────────────────────────────────────────
    async function insertBlock(type) {
        const def = BLOCKS[type];
        if (!def) return;
        pushUndo();
        const block = { type, props: {} };
        if (def.defaults) {
            for (const [key, val] of Object.entries(def.defaults)) {
                block.props[key] = typeof val === 'object' ? JSON.parse(JSON.stringify(val)) : val;
            }
        }

        // Inserting into a Columns/Flex Container slot rather than the top-level layout?
        if (pendingInsertTarget) {
            const { topIdx, path } = pendingInsertTarget;
            pendingInsertTarget = null;
            const arr = resolveSlotArrayForPath(layout[topIdx], path);
            if (!arr) { toast('Could not add block here', 'error'); return; }
            const insertIdx = path[path.length - 1].index;
            arr.splice(insertIdx, 0, block);
            markDirty();
            await refreshTopLevelBlock(topIdx);
            selectNestedBlock(topIdx, path);
            return;
        }

        // Insert at specific position or append
        const layoutBefore = JSON.parse(JSON.stringify(layout));
        let idx;
        if (insertAtIndex >= 0 && insertAtIndex <= layout.length) {
            idx = insertAtIndex;
            layout.splice(idx, 0, block);
            insertAtIndex = -1;
        } else if (selectedBlockIndex >= 0) {
            // Insert after selected block
            idx = selectedBlockIndex + 1;
            layout.splice(idx, 0, block);
        } else {
            layout.push(block);
            idx = layout.length - 1;
        }
        markDirty();
        postEditorOp('op_insert_block', { index: idx, block }, layoutBefore);

        // Render via server
        const html = await renderBlockServer(block);
        RENDERED.splice(idx, 0, html);
        rebuildCanvas();
        selectBlock(idx);
    }

    // ── Server-side block rendering ───────────────────────────
    async function renderBlockServer(block) {
        try {
            const body = new URLSearchParams();
            body.append('_editor_action', 'render_block');
            body.append('_csrf', CSRF);
            body.append('block', JSON.stringify(block));
            const res = await fetch(SAVE_URL + '?id=' + POST.id, { method: 'POST', body });
            const json = await res.json();
            return json.ok ? json.html : '<div style="padding:16px;color:#ef4444;">Block render error</div>';
        } catch (e) {
            return '<div style="padding:16px;color:#ef4444;">Render failed</div>';
        }
    }

    // ── Apply block styles to canvas DOM element ──────────────
    function applyBlockStyleToEl(blockEl, s) {
        if (!blockEl) return;
        s = s || {};
        let styleStr = '';

        if (s.bgColor) {
            const op = (s.bgOpacity !== undefined ? s.bgOpacity : 100) / 100;
            let hex = String(s.bgColor).replace('#','');
            if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
            if (hex.length >= 6) {
                const r = parseInt(hex.slice(0,2),16);
                const g = parseInt(hex.slice(2,4),16);
                const b = parseInt(hex.slice(4,6),16);
                styleStr += 'background-color:rgba(' + r + ',' + g + ',' + b + ',' + op + ');';
            }
        }
        if (s.bgImage) {
            const url = String(s.bgImage).replace(/"/g, '&quot;');
            if (s.bgOverlay) {
                const ov = String(s.bgOverlay).replace(/"/g, '&quot;');
                styleStr += 'background-image:linear-gradient(' + ov + ',' + ov + '),url("' + url + '");';
            } else {
                styleStr += 'background-image:url("' + url + '");';
            }
            styleStr += 'background-size:cover;background-position:center;';
        }
        if (s.textColor) styleStr += 'color:' + s.textColor + ';';
        if (s.textAlign) styleStr += 'text-align:' + s.textAlign + ';';
        if (s.paddingTop !== '' && s.paddingTop !== undefined) styleStr += 'padding-top:' + parseInt(s.paddingTop) + 'px;';
        if (s.paddingBottom !== '' && s.paddingBottom !== undefined) styleStr += 'padding-bottom:' + parseInt(s.paddingBottom) + 'px;';
        if (s.paddingLeft !== '' && s.paddingLeft !== undefined) styleStr += 'padding-left:' + parseInt(s.paddingLeft) + 'px;';
        if (s.paddingRight !== '' && s.paddingRight !== undefined) styleStr += 'padding-right:' + parseInt(s.paddingRight) + 'px;';
        if (s.marginTop !== '' && s.marginTop !== undefined) styleStr += 'margin-top:' + parseInt(s.marginTop) + 'px;';
        if (s.marginBottom !== '' && s.marginBottom !== undefined) styleStr += 'margin-bottom:' + parseInt(s.marginBottom) + 'px;';
        if (s.borderRadius !== '' && s.borderRadius !== undefined) styleStr += 'border-radius:' + parseInt(s.borderRadius) + 'px;';
        if (s.maxWidth) styleStr += 'max-width:' + s.maxWidth + (isNaN(s.maxWidth) ? '' : 'px') + ';';

        const innerEl = blockEl.querySelector('.cb-block-wrapper') || blockEl.querySelector('.ve-block-inner') || blockEl;
        innerEl.style.cssText = innerEl.style.cssText.replace(/(?:background-color|background-image|background-size|background-position|color|text-align|padding[^:]*|margin[^:]*|border-radius|max-width)[^;]*;/g, '');
        if (styleStr) innerEl.setAttribute('style', (innerEl.getAttribute('style') || '') + styleStr);

        // visibility classes
        blockEl.classList.toggle('ve-hide-desktop', !!s.hideDesktop);
        blockEl.classList.toggle('ve-hide-tablet',  !!s.hideTablet);
        blockEl.classList.toggle('ve-hide-mobile',  !!s.hideMobile);

        if (s._prevCustomClass) blockEl.classList.remove(...s._prevCustomClass.split(' ').filter(Boolean));
        if (s.customClass) blockEl.classList.add(...s.customClass.split(' ').filter(Boolean));
        s._prevCustomClass = s.customClass;
    }

    // ── Elementor Add Section Box at bottom of Canvas ──────────
    function appendElementorAddSection() {
        const elBox = document.createElement('div');
        elBox.className = 've-el-add-section';
        elBox.innerHTML = '<button type="button" class="ve-el-add-btn" title="Add New Section">+</button><div class="ve-el-add-label">Drag widget here or click + to add section</div>';
        elBox.addEventListener('click', (e) => {
            e.stopPropagation();
            insertAtIndex = layout.length;
            const blocksTab = document.querySelector('[data-tab="blocks"]');
            if (blocksTab) blocksTab.click();
        });
        elBox.addEventListener('dragover', (e) => {
            if (!Array.from(e.dataTransfer.types).includes('application/x-slate-block-type')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            elBox.classList.add('hovering');
        });
        elBox.addEventListener('dragleave', () => elBox.classList.remove('hovering'));
        elBox.addEventListener('drop', (e) => {
            if (!Array.from(e.dataTransfer.types).includes('application/x-slate-block-type')) return;
            e.preventDefault();
            elBox.classList.remove('hovering');
            const type = e.dataTransfer.getData('application/x-slate-block-type');
            if (!type) return;
            insertAtIndex = layout.length;
            insertBlock(type);
        });
        $canvas.appendChild(elBox);
    }

    // ── Canvas rendering ──────────────────────────────────────
    function renderCanvas() {
        $canvas.innerHTML = '';
        if (!layout.length) {
            $canvas.innerHTML = '<div class="ve-empty-canvas">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>' +
                '<p>Your page is empty</p><p style="font-size:12px;opacity:.6">Click a block on the left to start building</p></div>';
            appendElementorAddSection();
            return;
        }
        layout.forEach((block, idx) => {
            const html = RENDERED[idx] || '<div style="padding:16px;color:#999;">Loading…</div>';
            appendBlockToCanvas(html, idx);
        });
        appendElementorAddSection();
    }

    function appendBlockToCanvas(html, idx) {
        const wrapper = document.createElement('div');
        wrapper.className = 've-block' + (idx === selectedBlockIndex ? ' selected' : '');
        wrapper.dataset.index = idx;
        wrapper.dataset.type = layout[idx]?.type || '';
        wrapper.draggable = true;

        const def = BLOCKS[layout[idx]?.type] || {};
        const typeName = def.label || layout[idx]?.type || 'Block';

        // Elementor floating top-center section bar
        wrapper.innerHTML = 
            '<div class="ve-block-controls">' +
            '<button type="button" data-action="add-above" title="Add block above">+</button>' +
            '<div class="ve-handle-title" title="Drag to reorder">⠿ ' + escHtml(typeName) + '</div>' +
            '<button type="button" data-action="up" title="Move up">↑</button>' +
            '<button type="button" data-action="down" title="Move down">↓</button>' +
            '<button type="button" data-action="dup" title="Duplicate">⧉</button>' +
            '<button type="button" data-action="delete" title="Delete">✕</button>' +
            '</div>' +
            '<div class="ve-block-inner">' + html + '</div>';

        // Apply saved block style immediately
        applyBlockStyleToEl(wrapper, layout[idx]?.style || {});

        // Enable contenteditable for text blocks
        const type = layout[idx]?.type;
        if (type === 'heading' || type === 'paragraph') {
            const textEl = wrapper.querySelector('.cb-heading, .cb-paragraph, h1, h2, h3, h4, h5, h6, p');
            if (textEl) {
                textEl.contentEditable = 'true';
                textEl.style.pointerEvents = 'auto';
                textEl.addEventListener('input', () => {
                    layout[idx].props.text = textEl.innerHTML;
                    markDirty();
                    renderLayers();
                });
                textEl.addEventListener('focus', () => {
                    selectBlock(parseInt(wrapper.dataset.index));
                });
            }
        }

        // Hydrate any Columns / Flex Container slots inside this block so their
        // contents become selectable/editable/re-orderable too.
        const wrapperInner = wrapper.querySelector('.ve-block-inner');
        if (wrapperInner) hydrateNestedBlocks(wrapperInner, layout[idx], idx, []);

        // Click to select
        wrapper.addEventListener('click', (e) => {
            if (e.target.closest('.ve-block-controls')) return;
            if (e.target.isContentEditable) return;
            selectBlock(parseInt(wrapper.dataset.index));
        });

        // Control buttons
        wrapper.querySelectorAll('.ve-block-controls button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                pushUndo();
                handleBlockAction(parseInt(wrapper.dataset.index), btn.dataset.action);
            });
        });

        // Drag events
        wrapper.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', wrapper.dataset.index);
            wrapper.classList.add('dragging');
            dragSourceIdx = parseInt(wrapper.dataset.index);
        });
        wrapper.addEventListener('dragend', () => {
            wrapper.classList.remove('dragging');
            dragSourceIdx = -1;
            document.querySelectorAll('.ve-drop-zone').forEach(z => z.classList.remove('hovering'));
        });

        $canvas.appendChild(wrapper);

        // Add-between zone after each block
        const addZone = document.createElement('div');
        addZone.className = 've-add-between';
        addZone.dataset.afterIndex = idx;
        addZone.innerHTML = '<button class="ve-add-between-btn" title="Add block here">+</button>';
        addZone.querySelector('.ve-add-between-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            insertAtIndex = parseInt(addZone.dataset.afterIndex) + 1;
            const blocksTab = document.querySelector('[data-tab="blocks"]');
            if (blocksTab && !blocksTab.classList.contains('active')) blocksTab.click();
        });

        // Drop zone for drag-and-drop
        addZone.classList.add('ve-drop-zone');
        addZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes('application/x-slate-block-type') ? 'copy' : 'move';
            addZone.classList.add('hovering');
        });
        addZone.addEventListener('dragleave', () => {
            addZone.classList.remove('hovering');
        });
        addZone.addEventListener('drop', (e) => {
            e.preventDefault();
            addZone.classList.remove('hovering');
            const newType = e.dataTransfer.getData('application/x-slate-block-type');
            if (newType) {
                insertAtIndex = parseInt(addZone.dataset.afterIndex) + 1;
                insertBlock(newType);
                return;
            }
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
            let toIdx = parseInt(addZone.dataset.afterIndex) + 1;
            if (isNaN(fromIdx) || fromIdx === toIdx || fromIdx + 1 === toIdx) return;
            pushUndo();
            const [moved] = layout.splice(fromIdx, 1);
            const [movedHtml] = RENDERED.splice(fromIdx, 1);
            if (fromIdx < toIdx) toIdx--;
            layout.splice(toIdx, 0, moved);
            RENDERED.splice(toIdx, 0, movedHtml);
            markDirty();
            selectedBlockIndex = toIdx;
            rebuildCanvas();
        });

        $canvas.appendChild(addZone);
    }

    function rebuildCanvas() {
        $canvas.innerHTML = '';
        if (!layout.length) {
            renderCanvas();
            return;
        }
        // Top drop zone
        const topZone = document.createElement('div');
        topZone.className = 've-add-between ve-drop-zone';
        topZone.dataset.afterIndex = -1;
        topZone.innerHTML = '<button class="ve-add-between-btn" title="Add block at top">+</button>';
        topZone.querySelector('.ve-add-between-btn').addEventListener('click', () => {
            insertAtIndex = 0;
            const blocksTab = document.querySelector('[data-tab="blocks"]');
            if (blocksTab && !blocksTab.classList.contains('active')) blocksTab.click();
        });
        topZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes('application/x-slate-block-type') ? 'copy' : 'move';
            topZone.classList.add('hovering');
        });
        topZone.addEventListener('dragleave', () => { topZone.classList.remove('hovering'); });
        topZone.addEventListener('drop', (e) => {
            e.preventDefault();
            topZone.classList.remove('hovering');
            const newType = e.dataTransfer.getData('application/x-slate-block-type');
            if (newType) {
                insertAtIndex = 0;
                insertBlock(newType);
                return;
            }
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
            if (isNaN(fromIdx) || fromIdx === 0) return;
            pushUndo();
            const [moved] = layout.splice(fromIdx, 1);
            const [movedHtml] = RENDERED.splice(fromIdx, 1);
            layout.splice(0, 0, moved);
            RENDERED.splice(0, 0, movedHtml);
            markDirty();
            selectedBlockIndex = 0;
            rebuildCanvas();
        });
        $canvas.appendChild(topZone);

        layout.forEach((block, idx) => {
            const html = RENDERED[idx] || '<div style="padding:16px;color:#999;">Loading…</div>';
            appendBlockToCanvas(html, idx);
        });
        appendElementorAddSection();
        renderLayers();
        renderInspector();
    }

    async function handleBlockAction(idx, action) {
        if (action === 'add-above') {
            insertAtIndex = idx;
            const blocksTab = document.querySelector('[data-tab="blocks"]');
            if (blocksTab) blocksTab.click();
            return;
        }
        if (action === 'up' && idx > 0) {
            const layoutBefore = JSON.parse(JSON.stringify(layout));
            [layout[idx], layout[idx-1]] = [layout[idx-1], layout[idx]];
            [RENDERED[idx], RENDERED[idx-1]] = [RENDERED[idx-1], RENDERED[idx]];
            selectedBlockIndex = idx - 1;
            postEditorOp('op_move_block', { from_index: idx, to_index: idx - 1 }, layoutBefore);
        } else if (action === 'down' && idx < layout.length - 1) {
            const layoutBefore = JSON.parse(JSON.stringify(layout));
            [layout[idx], layout[idx+1]] = [layout[idx+1], layout[idx]];
            [RENDERED[idx], RENDERED[idx+1]] = [RENDERED[idx+1], RENDERED[idx]];
            selectedBlockIndex = idx + 1;
            postEditorOp('op_move_block', { from_index: idx, to_index: idx + 1 }, layoutBefore);
        } else if (action === 'dup') {
            const clone = JSON.parse(JSON.stringify(layout[idx]));
            layout.splice(idx + 1, 0, clone);
            RENDERED.splice(idx + 1, 0, RENDERED[idx]);
            selectedBlockIndex = idx + 1;
        } else if (action === 'delete') {
            layout.splice(idx, 1);
            RENDERED.splice(idx, 1);
            if (selectedBlockIndex === idx) selectedBlockIndex = -1;
            else if (selectedBlockIndex > idx) selectedBlockIndex--;
        }
        markDirty();
        rebuildCanvas();
    }

    // ── Layers tree ───────────────────────────────────────────
    function renderLayers() {
        if (!layout.length) {
            $layerTree.innerHTML = '<div class="ve-inspector-empty">No blocks yet</div>';
            return;
        }
        let html = '';
        layout.forEach((block, i) => {
            const def = BLOCKS[block.type] || {};
            const label = block.props?.text
                ? stripTags(block.props.text).substring(0, 30)
                : (def.label || block.type);
            html += '<div class="ve-layer' + (i === selectedBlockIndex ? ' selected' : '') + '" data-index="' + i + '">'
                + blockIcon(block.type)
                + '<span class="ve-layer-label">' + escHtml(label) + '</span>'
                + '<span class="ve-layer-type">' + (def.label || block.type) + '</span>'
                + '</div>';
        });
        $layerTree.innerHTML = html;
        $layerTree.querySelectorAll('.ve-layer').forEach(el => {
            el.addEventListener('click', () => selectBlock(parseInt(el.dataset.index)));
        });
    }
    function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }
    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // ── Block selection ───────────────────────────────────────
    function selectBlock(idx) {
        selectedBlockIndex = idx;
        selectedNestedPath = null;
        // Highlight in canvas
        document.querySelectorAll('.ve-block, .ve-nested-block').forEach(el => {
            el.classList.remove('selected');
        });
        const topSel = document.querySelector('.ve-block[data-index="' + idx + '"]');
        if (topSel) topSel.classList.add('selected');
        renderLayers();
        renderInspector();
        // Scroll block into view
        if (topSel) topSel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ── Inspector ─────────────────────────────────────────────
    function renderInspector() {
        if (selectedBlockIndex < 0 || !getSelectedBlock()) {
            $inspector.innerHTML = '<div class="ve-inspector-empty">Select a block to edit its properties</div>';
            return;
        }
        const block = getSelectedBlock();
        const def = BLOCKS[block.type] || {};
        const defaults = def.defaults || {};
        const st = block.style || {};

        // ── Content fields accordion ───────────────────────────
        let contentFields = '';
        if (def.fields) {
            for (const [key, field] of Object.entries(def.fields)) {
                const val = block.props[key] ?? defaults[key] ?? '';
                contentFields += '<div class="ve-field"><label>' + escHtml(field.label || key) + '</label>';

                if (field.type === 'select' && field.options) {
                    contentFields += '<select data-key="' + key + '">';
                    for (const [optVal, optLabel] of Object.entries(field.options)) {
                        contentFields += '<option value="' + escHtml(optVal) + '"' + (String(val) === String(optVal) ? ' selected' : '') + '>'
                            + escHtml(optLabel) + '</option>';
                    }
                    contentFields += '</select>';
                } else if (field.type === 'textarea' || field.type === 'richtext') {
                    contentFields += '<textarea data-key="' + key + '">' + escHtml(String(val)) + '</textarea>';
                } else if (field.type === 'toggle' || field.type === 'checkbox') {
                    contentFields += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none;font-size:13px;font-weight:400">'
                        + '<input type="checkbox" data-key="' + key + '"' + (val ? ' checked' : '') + '> '
                        + escHtml(field.label || key) + '</label>';
                } else if (field.type === 'color') {
                    contentFields += '<div class="ve-color-row"><input type="color" data-key="' + key + '" value="' + escHtml(String(val || '#000000')) + '"><input type="text" data-key-hex="' + key + '" value="' + escHtml(String(val || '#000000')) + '" maxlength="9" placeholder="#rrggbb"></div>';
                } else if (field.type === 'number') {
                    contentFields += '<input type="number" data-key="' + key + '" value="' + escHtml(String(val)) + '">';
                } else if (field.type === 'image' || field.type === 'media') {
                    let previewUrl = val;
                    if (field.type === 'media' && val && typeof val === 'object' && val.key) {
                        previewUrl = (MEDIA || {})[val.key] || '';
                    }
                    contentFields += `
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            ${previewUrl ? `<img src="${escHtml(previewUrl)}" style="max-width:100%; border-radius:4px; max-height:120px; object-fit:contain; background:#111; border:1px solid rgba(255,255,255,0.1);">` : ''}
                            <div style="display:flex; gap:8px;">
                                <input type="text" data-key="${key}" value="${escHtml(field.type === 'media' ? (val && typeof val === 'object' ? val.key : val) : String(val))}" style="flex:1;">
                                <button type="button" class="cb-btn cb-btn-secondary" onclick="openMediaPicker(this, '${field.type}', '${key}')" style="padding:0 8px; font-size:12px; line-height:28px;">Select Media</button>
                            </div>
                        </div>`;
                } else if (field.type === 'repeater') {
                    const items = Array.isArray(val) ? val : [];
                    contentFields += '<div style="font-size:12px;color:var(--ve-text-dim)">' + items.length + ' items (edit in code view)</div>';
                } else {
                    contentFields += '<input type="text" data-key="' + key + '" value="' + escHtml(String(val)) + '">';
                }
                contentFields += '</div>';
            }
        }

        // ── Style accordion ────────────────────────────────────
        const align = st.textAlign || '';
        const bgColor = st.bgColor || '';
        const bgOpacity = st.bgOpacity !== undefined ? st.bgOpacity : 100;
        const bgImage = st.bgImage || '';
        const bgOverlay = st.bgOverlay || '';
        const textColor = st.textColor || '';
        const paddingTop = st.paddingTop !== undefined ? st.paddingTop : '';
        const paddingBottom = st.paddingBottom !== undefined ? st.paddingBottom : '';
        const paddingLeft = st.paddingLeft !== undefined ? st.paddingLeft : '';
        const paddingRight = st.paddingRight !== undefined ? st.paddingRight : '';
        const marginTop = st.marginTop !== undefined ? st.marginTop : '';
        const marginBottom = st.marginBottom !== undefined ? st.marginBottom : '';
        const borderRadius = st.borderRadius !== undefined ? st.borderRadius : '';
        const maxWidth = st.maxWidth || '';
        const customClass = st.customClass || '';
        const hideDesktop = st.hideDesktop || false;
        const hideTablet = st.hideTablet || false;
        const hideMobile = st.hideMobile || false;

        const styleAccordion = `
<div class="ve-accordion">
  <div class="ve-accordion-head open" id="styleHead"><span>⚙ Style</span><span class="ve-acc-arrow">▾</span></div>
  <div class="ve-accordion-body open" id="styleBody">

    <div class="ve-field">
      <label>Text Align</label>
      <div class="ve-btn-group" id="alignGroup">
        <button data-align="left"  title="Left"   class="${align==='left'?'active':''}">&#8676;</button>
        <button data-align="center" title="Center" class="${align==='center'?'active':''}">&#8660;</button>
        <button data-align="right" title="Right"  class="${align==='right'?'active':''}">&#8677;</button>
        <button data-align="justify" title="Justify" class="${align==='justify'?'active':''}">&#9643;</button>
      </div>
    </div>

    <div class="ve-field">
      <label>Background Color</label>
      <div class="ve-color-row">
        <input type="color" id="stBgColor" value="${bgColor || '#ffffff'}">
        <input type="text" id="stBgColorHex" value="${bgColor}" placeholder="#rrggbb" maxlength="9">
        <input type="number" id="stBgOpacity" value="${bgOpacity}" min="0" max="100" style="width:56px;flex-shrink:0" title="Opacity %"> <span style="font-size:11px;color:var(--ve-text-dim)">%</span>
      </div>
    </div>

    <div class="ve-field">
      <label>Background Image URL</label>
      <div style="display:flex; gap:8px;">
        <input type="text" id="stBgImage" value="${escHtml(bgImage)}" placeholder="https://..." style="flex:1;">
        <button type="button" class="cb-btn cb-btn-secondary" onclick="openMediaPicker(this, 'image', 'stBgImage')" style="padding:0 8px; font-size:12px; line-height:28px;">Select Media</button>
      </div>
    </div>
    
    <div class="ve-field">
      <label>Image Overlay (rgba or hex)</label>
      <input type="text" id="stBgOverlay" value="${escHtml(bgOverlay)}" placeholder="rgba(0,0,0,0.5)">
    </div>

    <div class="ve-field">
      <label>Text Color</label>
      <div class="ve-color-row">
        <input type="color" id="stTextColor" value="${textColor || '#000000'}">
        <input type="text" id="stTextColorHex" value="${textColor}" placeholder="inherit" maxlength="9">
      </div>
    </div>

    <div class="ve-field">
      <label>Padding (px)</label>
      <div class="ve-spacing-grid">
        <div class="ve-field"><label>Top</label><input type="number" id="stPT" value="${paddingTop}" placeholder="0" min="0"></div>
        <div class="ve-field"><label>Bottom</label><input type="number" id="stPB" value="${paddingBottom}" placeholder="0" min="0"></div>
        <div class="ve-field"><label>Left</label><input type="number" id="stPL" value="${paddingLeft}" placeholder="0" min="0"></div>
        <div class="ve-field"><label>Right</label><input type="number" id="stPR" value="${paddingRight}" placeholder="0" min="0"></div>
      </div>
    </div>

    <div class="ve-field">
      <label>Margin (px)</label>
      <div class="ve-spacing-grid">
        <div class="ve-field"><label>Top</label><input type="number" id="stMT" value="${marginTop}" placeholder="0"></div>
        <div class="ve-field"><label>Bottom</label><input type="number" id="stMB" value="${marginBottom}" placeholder="0"></div>
      </div>
    </div>

    <div class="ve-spacing-grid" style="margin-bottom:14px">
      <div class="ve-field"><label>Border Radius</label><input type="number" id="stBR" value="${borderRadius}" placeholder="0" min="0"></div>
      <div class="ve-field"><label>Max-width</label><input type="text" id="stMW" value="${maxWidth}" placeholder="100%"></div>
    </div>

    <div class="ve-field">
      <label>Custom CSS Class</label>
      <input type="text" id="stClass" value="${escHtml(customClass)}" placeholder="my-class another-class">
    </div>

    <div class="ve-field">
      <label>Hide On</label>
      <div class="ve-visibility-grid">
        <button class="ve-vis-btn ${hideDesktop?'hidden-on':''}" id="visDesktop" title="Hide on Desktop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>Desktop
        </button>
        <button class="ve-vis-btn ${hideTablet?'hidden-on':''}" id="visTablet" title="Hide on Tablet">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/></svg>Tablet
        </button>
        <button class="ve-vis-btn ${hideMobile?'hidden-on':''}" id="visMobile" title="Hide on Mobile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>Mobile
        </button>
      </div>
    </div>
  </div>
</div>`;

        // ── Assemble inspector ─────────────────────────────────
        let html = '<div class="ve-inspector-title">' + escHtml(def.label || block.type) + '</div>'
            + '<div style="padding:12px">';
        if (contentFields) html += contentFields;
        html += styleAccordion;
        html += '<div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--ve-border);display:flex;gap:6px">'
            + '<button class="ve-btn ve-btn-ghost" style="flex:1" id="inspDup">Duplicate</button>'
            + '<button class="ve-btn ve-btn-danger" style="flex:1" id="inspDel">Delete</button>'
            + '</div></div>';

        $inspector.innerHTML = html;

        // ── Wire up Duplicate / Delete ─────────────────────────
        document.getElementById('inspDup').addEventListener('click', () => {
            pushUndo(); handleSelectedAction('dup');
        });
        document.getElementById('inspDel').addEventListener('click', () => {
            pushUndo(); handleSelectedAction('delete');
        });

        // ── Content field changes → debounced server re-render ─
        $inspector.querySelectorAll('[data-key]').forEach(input => {
            const evtType = (input.type === 'checkbox') ? 'change' : 'input';
            input.addEventListener(evtType, () => {
                const key = input.dataset.key;
                let val = input.type === 'checkbox' ? input.checked : input.value;
                if (input.type === 'number') val = parseFloat(val) || 0;
                const isTopLevel = !selectedNestedPath || !selectedNestedPath.length;
                const layoutBefore = isTopLevel ? JSON.parse(JSON.stringify(layout)) : null;
                getSelectedBlock().props[key] = val;
                // sync color picker ↔ hex text
                const hexSib = $inspector.querySelector('[data-key-hex="' + key + '"]');
                if (hexSib && input.type === 'color') hexSib.value = val;
                markDirty();
                if (isTopLevel) {
                    postEditorOp('op_update_block_props', { index: selectedBlockIndex, patch: { [key]: val } }, layoutBefore);
                }
                debounceRender(selectedBlockIndex, 350);
            });
        });
        // Hex text → color picker sync
        $inspector.querySelectorAll('[data-key-hex]').forEach(input => {
            input.addEventListener('input', () => {
                const key = input.dataset.keyHex;
                const picker = $inspector.querySelector('[data-key="' + key + '"][type="color"]');
                if (picker && /^#[0-9a-f]{6}$/i.test(input.value)) {
                    picker.value = input.value;
                    getSelectedBlock().props[key] = input.value;
                    markDirty();
                    debounceRender(selectedBlockIndex, 600);
                }
            });
        });

        // ── Accordion toggle ───────────────────────────────────
        document.getElementById('styleHead').addEventListener('click', () => {
            const head = document.getElementById('styleHead');
            const body = document.getElementById('styleBody');
            head.classList.toggle('open');
            body.classList.toggle('open');
        });

        // ── Style changes → instant canvas apply (no server call) ─
        function applyStyle() {
            const sel = getSelectedBlock();
            if (!sel) return;
            sel.style = sel.style || {};
            const blockEl = getSelectedBlockEl();
            applyBlockStyleToEl(blockEl, sel.style);
            markDirty();
        }

        // Alignment buttons
        document.getElementById('alignGroup').querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('alignGroup').querySelectorAll('button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                getSelectedBlock().style = getSelectedBlock().style || {};
                getSelectedBlock().style.textAlign = btn.dataset.align;
                applyStyle();
            });
        });

        // BG color
        function bindColorPair(pickerId, hexId, styleKey) {
            const picker = document.getElementById(pickerId);
            const hexInput = document.getElementById(hexId);
            if (!picker || !hexInput) return;
            const sync = (val) => {
                getSelectedBlock().style = getSelectedBlock().style || {};
                getSelectedBlock().style[styleKey] = val;
                if (/^#[0-9a-f]{3,8}$/i.test(val)) {
                    picker.value = val.length <= 7 ? val : val.slice(0,7);
                    hexInput.value = val;
                }
                applyStyle();
            };
            picker.addEventListener('input', () => sync(picker.value));
            hexInput.addEventListener('input', () => sync(hexInput.value));
        }
        bindColorPair('stBgColor', 'stBgColorHex', 'bgColor');
        bindColorPair('stTextColor', 'stTextColorHex', 'textColor');

        // BG Image & Overlay
        const stBgImage = document.getElementById('stBgImage');
        if (stBgImage) stBgImage.addEventListener('input', () => {
            getSelectedBlock().style = getSelectedBlock().style || {};
            getSelectedBlock().style.bgImage = stBgImage.value;
            applyStyle();
        });
        const stBgOverlay = document.getElementById('stBgOverlay');
        if (stBgOverlay) stBgOverlay.addEventListener('input', () => {
            getSelectedBlock().style = getSelectedBlock().style || {};
            getSelectedBlock().style.bgOverlay = stBgOverlay.value;
            applyStyle();
        });

        // BG Opacity
        const stBgOpacity = document.getElementById('stBgOpacity');
        if (stBgOpacity) stBgOpacity.addEventListener('input', () => {
            getSelectedBlock().style = getSelectedBlock().style || {};
            getSelectedBlock().style.bgOpacity = parseInt(stBgOpacity.value) || 100;
            applyStyle();
        });

        // Spacing
        function bindNum(id, styleKey) {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', () => {
                getSelectedBlock().style = getSelectedBlock().style || {};
                getSelectedBlock().style[styleKey] = el.value === '' ? '' : parseInt(el.value);
                applyStyle();
            });
        }
        bindNum('stPT','paddingTop'); bindNum('stPB','paddingBottom');
        bindNum('stPL','paddingLeft'); bindNum('stPR','paddingRight');
        bindNum('stMT','marginTop'); bindNum('stMB','marginBottom');
        bindNum('stBR','borderRadius');

        // Max width & custom class
        const stMW = document.getElementById('stMW');
        if (stMW) stMW.addEventListener('input', () => {
            getSelectedBlock().style = getSelectedBlock().style || {};
            getSelectedBlock().style.maxWidth = stMW.value;
            applyStyle();
        });
        const stClass = document.getElementById('stClass');
        if (stClass) stClass.addEventListener('input', () => {
            getSelectedBlock().style = getSelectedBlock().style || {};
            getSelectedBlock().style.customClass = stClass.value;
            applyStyle();
        });

        // Visibility toggles
        ['Desktop','Tablet','Mobile'].forEach(dev => {
            const btn = document.getElementById('vis' + dev);
            if (!btn) return;
            btn.addEventListener('click', () => {
                getSelectedBlock().style = getSelectedBlock().style || {};
                const key = 'hide' + dev;
                getSelectedBlock().style[key] = !getSelectedBlock().style[key];
                btn.classList.toggle('hidden-on', !!getSelectedBlock().style[key]);
                applyStyle();
            });
        });

        // Apply any existing styles immediately
        applyStyle();
    }

    // ── Panel tabs ────────────────────────────────────────────
    document.querySelectorAll('.ve-panel-tabs').forEach(tabBar => {
        const panel = tabBar.parentElement;
        tabBar.querySelectorAll('.ve-panel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                tabBar.querySelectorAll('.ve-panel-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                panel.querySelectorAll('.ve-panel-content').forEach(c => c.classList.remove('active'));
                const target = document.getElementById('tab' + capitalize(tab.dataset.tab));
                if (target) target.classList.add('active');
                if (tab.dataset.tab === 'history') loadHistory();
            });
        });
    });

    // ── Revision history (RevisionStore only, via list_revisions/restore_revision) ─
    async function loadHistory() {
        const $list = document.getElementById('historyList');
        $list.innerHTML = '<div class="ve-inspector-empty">Loading…</div>';
        try {
            const body = new URLSearchParams();
            body.append('_editor_action', 'list_revisions');
            body.append('_csrf', CSRF);
            const res = await fetch(SAVE_URL + '?id=' + POST.id, { method: 'POST', body });
            const json = await res.json();
            if (!json.ok || !json.revisions.length) {
                $list.innerHTML = '<div class="ve-inspector-empty">No revisions yet — Save Draft to create one.</div>';
                return;
            }
            $list.innerHTML = json.revisions.map(r =>
                '<div class="ve-layer" style="cursor:default">'
                + '<span class="ve-layer-label">#' + r.revision + ' · ' + escHtml(r.status) + '</span>'
                + '<span class="ve-layer-type">' + escHtml(r.created_at) + '</span>'
                + '<button type="button" class="ve-btn ve-btn-ghost" data-restore="' + r.id + '" style="padding:2px 8px;font-size:11px">Restore</button>'
                + '</div>'
            ).join('');
            $list.querySelectorAll('[data-restore]').forEach(btn => {
                btn.addEventListener('click', () => restoreRevision(parseInt(btn.dataset.restore, 10)));
            });
        } catch (e) {
            $list.innerHTML = '<div class="ve-inspector-empty">Failed to load history.</div>';
        }
    }

    async function restoreRevision(revisionId) {
        if (!confirm('Restore this revision? This becomes the new working draft (does not overwrite history).')) return;
        try {
            const body = new URLSearchParams();
            body.append('_editor_action', 'restore_revision');
            body.append('_csrf', CSRF);
            body.append('revision_id', String(revisionId));
            const res = await fetch(SAVE_URL + '?id=' + POST.id, { method: 'POST', body });
            const json = await res.json();
            if (!json.ok) { toast(json.error || 'Restore failed', 'error'); return; }
            pushUndo();
            layout = json.layout;
            RENDERED.length = 0;
            const rendered = await Promise.all(layout.map(b => renderBlockServer(b)));
            rendered.forEach(h => RENDERED.push(h));
            selectedBlockIndex = -1;
            selectedNestedPath = null;
            isDirty = false;
            $unsavedDot.style.display = 'none';
            rebuildCanvas();
            loadHistory();
            toast('Revision restored', 'success');
        } catch (e) {
            toast('Restore failed', 'error');
        }
    }

    // ── Device switcher ───────────────────────────────────────
    const $deviceIndicator = document.getElementById('deviceIndicator');
    const $customWidthInput = document.getElementById('customWidthInput');
    const DEVICE_LABELS = { desktop: 'Desktop', tablet: 'Tablet · 768px', mobile: 'Mobile · 390px' };

    function setDevice(device, customPx) {
        $canvasFrame.className = 've-canvas-frame';
        if (device !== 'desktop') $canvasFrame.classList.add('device-' + device);
        if (customPx) {
            $canvasFrame.style.maxWidth = customPx + 'px';
            $deviceIndicator.textContent = customPx + 'px';
        } else {
            $canvasFrame.style.maxWidth = '';
            $deviceIndicator.textContent = DEVICE_LABELS[device] || device;
        }
    }

    document.querySelectorAll('.ve-device-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ve-device-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            $customWidthInput.value = '';
            setDevice(btn.dataset.device);
        });
    });

    $customWidthInput.addEventListener('input', () => {
        const px = parseInt($customWidthInput.value);
        if (px >= 320) {
            document.querySelectorAll('.ve-device-btn').forEach(b => b.classList.remove('active'));
            setDevice('desktop', px);
        }
    });
    $customWidthInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') $customWidthInput.blur();
    });

    // ── Title sync ────────────────────────────────────────────
    $titleInput.addEventListener('input', () => {
        $settingsTitle.value = $titleInput.value;
        markDirty();
    });
    $settingsTitle.addEventListener('input', () => {
        $titleInput.value = $settingsTitle.value;
        markDirty();
    });
    $settingsSlug.addEventListener('input', () => markDirty());

    // ── Search ────────────────────────────────────────────────
    $searchInput.addEventListener('input', () => {
        renderBlockList($searchInput.value);
    });

    // ── Save / Publish ────────────────────────────────────────
    async function doAction(action, extra = {}) {
        if (isSaving) return;
        isSaving = true;
        showSaving(true);

        const body = new URLSearchParams();
        body.append('_editor_action', action);
        body.append('_csrf', CSRF);
        body.append('layout', JSON.stringify(layout));
        body.append('title', $titleInput.value);
        body.append('slug', $settingsSlug.value);
        for (const [k,v] of Object.entries(extra)) body.append(k, v);

        try {
            const res = await fetch(SAVE_URL + '?id=' + POST.id, { method: 'POST', body });
            const json = await res.json();
            if (json.ok) {
                if (action === 'save_draft') {
                    toast('Draft saved', 'success');
                    isDirty = false;
                    $unsavedDot.style.display = 'none';
                } else if (action === 'publish') {
                    toast('Published!', 'success');
                    isDirty = false;
                    $unsavedDot.style.display = 'none';
                    updateStatusPill('published');
                } else if (action === 'revert') {
                    toast('Reverted to published', 'success');
                    isDirty = false;
                    $unsavedDot.style.display = 'none';
                    window.location.reload();
                }
            } else {
                toast(json.error || 'Failed', 'error');
            }
        } catch (err) {
            toast('Network error', 'error');
        } finally {
            isSaving = false;
            showSaving(false);
        }
    }

    document.getElementById('btnSave').addEventListener('click', () => doAction('save_draft'));
    document.getElementById('btnPublish').addEventListener('click', () => doAction('publish'));

    // Ctrl+S / Cmd+S to save, Ctrl+Z undo, Ctrl+Shift+Z redo, Delete, Escape, Arrows
    document.addEventListener('keydown', (e) => {
        const isInput = e.target.matches('input, textarea, select, [contenteditable="true"]');

        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            doAction('save_draft');
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            redo();
            return;
        }
        // Skip block-action shortcuts if user is typing in an input
        if (isInput) return;

        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBlockIndex >= 0) {
            e.preventDefault();
            pushUndo();
            handleSelectedAction('delete');
            return;
        }
        if (e.key === 'Escape') {
            selectedBlockIndex = -1;
            selectedNestedPath = null;
            document.querySelectorAll('.ve-block, .ve-nested-block').forEach(el => el.classList.remove('selected'));
            renderInspector();
            renderLayers();
            return;
        }
        if (e.key === 'ArrowUp' && selectedBlockIndex > 0) {
            e.preventDefault();
            selectBlock(selectedBlockIndex - 1);
            return;
        }
        if (e.key === 'ArrowDown' && selectedBlockIndex < layout.length - 1) {
            e.preventDefault();
            selectBlock(selectedBlockIndex + 1);
            return;
        }
        // D to duplicate
        if (e.key === 'd' && selectedBlockIndex >= 0) {
            e.preventDefault();
            pushUndo();
            handleSelectedAction('dup');
        }
    });

    // Unsaved changes warning
    window.addEventListener('beforeunload', (e) => {
        if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // Click outside canvas deselects
    $canvas.addEventListener('click', (e) => {
        if (e.target === $canvas) {
            selectedBlockIndex = -1;
            selectedNestedPath = null;
            document.querySelectorAll('.ve-block, .ve-nested-block').forEach(el => el.classList.remove('selected'));
            renderInspector();
            renderLayers();
        }
    });

    // ── Init ──────────────────────────────────────────────────
    renderBlockList();
    renderCanvas();
    renderLayers();

    // Export openMediaPicker to window
    window.openMediaPicker = function(btn, type, key) {
        if (!window.MediaPicker) {
            alert('Media Library plugin not active or picker.js not loaded.');
            return;
        }
        window.MediaPicker.open({
            mode: 'single',
            onPick: function (path, item) {
                let finalVal = path;
                if (type === 'media') {
                    const id = item && item.id ? parseInt(item.id, 10) : 0;
                    if (!id) {
                        alert("That item has no media id, so it cannot be referenced by key.");
                        return;
                    }
                    finalVal = { key: "media:" + id };
                    MEDIA[finalVal.key] = (item && item.url) || path || "";
                } else {
                    finalVal = (item && item.url) || path || "";
                }

                if (key === 'stBgImage') {
                    const input = document.getElementById('stBgImage');
                    if (input) {
                        input.value = typeof finalVal === 'object' ? finalVal.key : finalVal;
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                    }
                } else if (selectedBlockIndex > -1 && getSelectedBlock()) {
                    getSelectedBlock().props = getSelectedBlock().props || {};
                    getSelectedBlock().props[key] = finalVal;
                    markDirty();
                    renderInspector();
                    debounceRender(selectedBlockIndex);
                }
            }
        });
    };

})();
</script>
<script src="<?= e(SLATE_URL) ?>/plugins/media-library/assets/js/picker.js"></script>
</body>
</html>
