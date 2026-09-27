<?php
declare(strict_types=1);

namespace Slate\Services\Content;

use Slate\Presentation\RenderContext;

final class PublicContentRoute
{
    public static function dispatch(string $path): bool
    {
        $slug = trim($path, '/');
        if ($slug === '' || str_contains($slug, '?')) return false;
        $page = ContentServiceFactory::pageRepository()->findBySlug($slug);
        if ($page === null) return false;
        $revision = ContentServiceFactory::revisionStore()->published(ContentPageRepository::OWNER_TYPE, (int)$page['id']);
        if ($revision === null) return false;
        $result = (new PublicContentService(
            ContentServiceFactory::compilationStore(),
            ContentServiceFactory::pageContentCompiler(),
            ContentServiceFactory::RENDERER_VERSION,
        ))->render(
            ContentPageRepository::OWNER_TYPE,
            (int)$page['id'],
            (int)$revision['id'],
            RevisionStore::documentOf($revision),
            RenderContext::for(function_exists('current_tenant_id') ? (int)current_tenant_id() : 1),
            'default',
        );
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        header('X-Slate-Compilation: ' . ($result['cache_hit'] ? 'hit' : 'miss'));
        echo $result['html'];
        return true;
    }
}
