<?php
/**
 * Slate — ContentServiceFactory: the composition root for admin/editor.php's
 * Phase 2 wiring.
 *
 * The Phase 2 application-service layer (ContentPublicationService,
 * PreviewService, RevisionStore, DocumentValidator, PageContentCompiler, ...)
 * is fully built and tested but, per docs/PHASE-2-STRUCTURED-REACT-BUILDER-
 * SCHEMA.md §18, deliberately ships with no composition-root wiring — "a
 * deployment/composition-root concern." This class is that concern, kept in one
 * place so admin/editor.php, admin/editor-preview.php, and admin/posts.php share
 * one construction path instead of each re-assembling the dependency graph.
 *
 * Pure assembly — no request-specific state is cached across calls; each method
 * builds a fresh instance (Repositories are cheap value objects over a shared
 * TenantContext, matching the pattern already used by every other Repository
 * subclass in this codebase).
 */

declare(strict_types=1);

namespace Slate\Services\Content;

use Slate\Presentation\BlockRegistryProjection;
use Slate\Presentation\FieldSchema;
use Slate\Presentation\Rendering\InMemoryBlockRegistry;
use Slate\Presentation\Rendering\LegacyBlockBridge;
use Slate\Presentation\Rendering\PageAssembler;
use Slate\Presentation\Rendering\PageContentCompiler;
use Slate\Presentation\Rendering\PageRenderer;
use Slate\Presentation\Templates\DocumentTemplate;
use Slate\Presentation\Templates\TemplateResolver;
use Slate\Tenancy\TenantContext;

final class ContentServiceFactory
{
    private static ?InMemoryBlockRegistry $registry = null;

    public const RENDERER_VERSION = '1.0.0';

    /** The live block registry — the 5 ported blocks (see LegacyBlockBridge). */
    public static function blockRegistry(): InMemoryBlockRegistry
    {
        if (self::$registry === null) {
            self::$registry = new InMemoryBlockRegistry();
            LegacyBlockBridge::register(self::$registry);
        }
        return self::$registry;
    }

    /**
     * The DocumentValidator-shaped registry: type-keyed {fields, defaults,
     * capabilities.nested, nestedKeys}. BlockRegistryProjection's own output is
     * a transport-safe *list* for the client palette and hardcodes
     * capabilities.nested=false, so it is not reused here directly — the
     * validator needs the raw per-type shape keyed by type.
     *
     * @return array<string,array<string,mixed>>
     */
    public static function validatorRegistry(): array
    {
        $out = [];
        foreach (self::blockRegistry()->all() as $block) {
            $schema = $block->schema();
            $out[$block->type()] = [
                'fields'       => $schema->fields(),
                'defaults'     => $schema->defaults(),
                'capabilities' => ['nested' => false],
                'nestedKeys'   => [],
            ];
        }
        return $out;
    }

    /** The transport-safe palette projection for the editor's block inserter. */
    public static function paletteProjection(): array
    {
        return BlockRegistryProjection::project(self::blockRegistry());
    }

    public static function pageContentCompiler(): PageContentCompiler
    {
        $templates = (new TemplateResolver())->register(new DocumentTemplate())->setFallback('document');
        $renderer = new PageRenderer(self::blockRegistry());
        return new PageContentCompiler(new PageAssembler($renderer, $templates));
    }

    public static function revisionStore(): RevisionStore
    {
        return new RevisionStore(new TenantContext());
    }

    public static function compilationStore(): CompilationStore
    {
        return new CompilationStore(new TenantContext());
    }

    public static function dependencyStore(): DependencyStore
    {
        return new DependencyStore(new TenantContext());
    }

    public static function pageRepository(): ContentPageRepository
    {
        return new ContentPageRepository(new TenantContext());
    }

    public static function publicationService(): ContentPublicationService
    {
        return new ContentPublicationService(
            self::revisionStore(),
            self::compilationStore(),
            self::dependencyStore(),
            self::pageContentCompiler(),
            self::validatorRegistry(),
            self::RENDERER_VERSION,
        );
    }

    public static function previewService(): PreviewService
    {
        return new PreviewService(self::pageContentCompiler(), self::validatorRegistry());
    }

    public static function invalidationService(): DependencyInvalidationService
    {
        return new DependencyInvalidationService(
            self::dependencyStore(),
            new PageContentRecompiler(self::revisionStore(), self::compilationStore(), self::pageContentCompiler(), self::RENDERER_VERSION),
        );
    }
}
