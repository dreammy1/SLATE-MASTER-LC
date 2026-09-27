<?php
/**
 * Phase 2 editor migration — public route + dependency-invalidation wiring
 * added on top of the editor migration (PublicRouter -> PublicContentRoute,
 * DependencyInvalidationService -> PageContentRecompiler).
 *
 * Regression coverage for a real bug found before merging that work: both
 * PublicContentRoute::dispatch() and PageContentRecompiler::recompile() were
 * keyed to the owner_type literal 'page', while every content_pages revision
 * is actually stored under ContentPageRepository::OWNER_TYPE ('content_pages')
 * — so the public route 404'd every published page, and global-dependency
 * invalidation silently no-op'd, with no test catching either. Fixed by
 * routing both through the shared ContentPageRepository::OWNER_TYPE constant.
 */

declare(strict_types=1);

use Slate\Presentation\RenderContext;
use Slate\Services\Content\ContentPageRepository;
use Slate\Services\Content\ContentServiceFactory;

function ep2pub_probe(string $slug): array
{
    $cmd = escapeshellarg(PHP_BINARY) . ' '
         . escapeshellarg(dirname(__DIR__) . '/fixtures/public-page-probe.php') . ' '
         . escapeshellarg('public.php') . ' '
         . escapeshellarg('_path=' . $slug) . ' 2>/dev/null';
    $out = (string) shell_exec($cmd);
    preg_match('/^STATUS (\d+)\n/', $out, $m);
    return ['status' => (int) $m[1], 'body' => substr($out, strlen($m[0]))];
}

function ep2pub_make_page(string $slug): int
{
    return ContentServiceFactory::pageRepository()->create('page', 'Public route probe', $slug);
}

function ep2pub_cleanup(int $pageId): void
{
    Database::query('DELETE FROM content_dependencies WHERE owner_type = ? AND owner_id = ?', [ContentPageRepository::OWNER_TYPE, $pageId]);
    Database::query('DELETE FROM content_compilations WHERE owner_type = ? AND owner_id = ?', [ContentPageRepository::OWNER_TYPE, $pageId]);
    Database::query('DELETE FROM content_revisions WHERE owner_type = ? AND owner_id = ?', [ContentPageRepository::OWNER_TYPE, $pageId]);
    Database::query('DELETE FROM content_pages WHERE id = ?', [$pageId]);
}

unit('a published content page is served publicly at its slug', function () {
    $slug = 'ep2pub-' . bin2hex(random_bytes(4));
    $pageId = ep2pub_make_page($slug);
    try {
        $document = \Slate\Presentation\EditorStateSerializer::serialize([
            'document' => [['type' => 'heading', 'props' => ['text' => 'Published Public Page', 'level' => '1']]],
        ]);
        $document['type'] = 'page';
        $context = RenderContext::for(current_tenant_id(), RenderContext::SURFACE_PAGE);
        $publication = ContentServiceFactory::publicationService();
        $publication->save(ContentPageRepository::OWNER_TYPE, $pageId, $document, $context, '1');
        $publication->publish(ContentPageRepository::OWNER_TYPE, $pageId, $context, '1');
        ContentServiceFactory::pageRepository()->markPublished($pageId);

        $res = ep2pub_probe($slug);
        assert_eq(200, $res['status'], 'a published page must be reachable at its slug');
        assert_true(str_contains($res['body'], 'Published Public Page'), 'the response must contain the compiled block content');
    } finally {
        ep2pub_cleanup($pageId);
    }
});

unit('a draft-only (never published) page 404s publicly', function () {
    $slug = 'ep2pub-draft-' . bin2hex(random_bytes(4));
    $pageId = ep2pub_make_page($slug);
    try {
        $document = \Slate\Presentation\EditorStateSerializer::serialize([
            'document' => [['type' => 'heading', 'props' => ['text' => 'Draft Only', 'level' => '1']]],
        ]);
        $document['type'] = 'page';
        $context = RenderContext::for(current_tenant_id(), RenderContext::SURFACE_PAGE);
        ContentServiceFactory::publicationService()->save(ContentPageRepository::OWNER_TYPE, $pageId, $document, $context, '1');

        $res = ep2pub_probe($slug);
        assert_eq(404, $res['status'], 'a draft that was never published must not be publicly reachable');
    } finally {
        ep2pub_cleanup($pageId);
    }
});

unit('an unknown slug 404s without a fatal error', function () {
    $res = ep2pub_probe('ep2pub-does-not-exist-' . bin2hex(random_bytes(4)));
    assert_eq(404, $res['status']);
});

unit('PageContentRecompiler actually recompiles a content_pages owner (owner_type must match, not silently no-op)', function () {
    $slug = 'ep2pub-recompile-' . bin2hex(random_bytes(4));
    $pageId = ep2pub_make_page($slug);
    try {
        $document = \Slate\Presentation\EditorStateSerializer::serialize([
            'document' => [['type' => 'heading', 'props' => ['text' => 'Recompile Me', 'level' => '1']]],
        ]);
        $document['type'] = 'page';
        $context = RenderContext::for(current_tenant_id(), RenderContext::SURFACE_PAGE);
        $publication = ContentServiceFactory::publicationService();
        $publication->save(ContentPageRepository::OWNER_TYPE, $pageId, $document, $context, '1', ['global:probe-widget']);
        $publication->publish(ContentPageRepository::OWNER_TYPE, $pageId, $context, '1', ['global:probe-widget']);
        ContentServiceFactory::pageRepository()->markPublished($pageId);

        // Wipe the compilation artifact written by publish() so we can prove
        // recompile() itself writes a fresh one, rather than observing a stale
        // row left over from the publish step above.
        Database::query('DELETE FROM content_compilations WHERE owner_type = ? AND owner_id = ?', [ContentPageRepository::OWNER_TYPE, $pageId]);
        assert_eq(null, ContentServiceFactory::compilationStore()->latest(ContentPageRepository::OWNER_TYPE, $pageId), 'precondition: no compilation row left');

        $recompiled = ContentServiceFactory::invalidationService()->invalidate('global:probe-widget');
        assert_true($recompiled >= 1, 'invalidate() must find this page as a dependent');

        $fresh = ContentServiceFactory::compilationStore()->latest(ContentPageRepository::OWNER_TYPE, $pageId);
        assert_true($fresh !== null, 'PageContentRecompiler must actually write a compilation row for a content_pages owner, not silently return');
        assert_true(str_contains((string) $fresh['content_html'], 'Recompile Me'), 'the recompiled HTML must reflect the published document');
    } finally {
        ep2pub_cleanup($pageId);
    }
});
