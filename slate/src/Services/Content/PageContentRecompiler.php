<?php
declare(strict_types=1);

namespace Slate\Services\Content;

use Slate\Presentation\CompilationMetadata;
use Slate\Presentation\RenderContext;

final class PageContentRecompiler implements ContentRecompiler
{
    public function __construct(
        private readonly RevisionStore $revisions,
        private readonly CompilationStore $compilations,
        private readonly \Slate\Presentation\ContentCompiler $compiler,
        private readonly string $rendererVersion = '1.0.0',
    ) {}

    public function recompile(string $ownerType, int $ownerId): void
    {
        if ($ownerType !== ContentPageRepository::OWNER_TYPE) return;
        $revision = $this->revisions->published($ownerType, $ownerId);
        if ($revision === null) return;
        $document = RevisionStore::documentOf($revision);
        $metadata = CompilationMetadata::for($document, $this->rendererVersion, 'default', []);
        $html = $this->compiler->compile($document, RenderContext::for(function_exists('current_tenant_id') ? (int)current_tenant_id() : 1));
        $this->compilations->put($ownerType, $ownerId, (int)$revision['id'], $html, $metadata->fingerprint, $this->rendererVersion, 'default');
    }
}
