<?php
/**
 * Slate — LegacyBlockBridge: registers a minimal, representative set of native
 * Slate\Presentation\Block implementations for admin/editor.php's Phase 2
 * migration.
 *
 * The archived content-builder plugin (archive/plugins/content-builder/) shipped
 * ~25 block types as array-defined blocks with a `tpl` PHP template, rendered by
 * its own Renderer::renderBlock(). That plugin no longer exists in plugins/, and
 * neither the old array-based BlockRegistry nor the new Slate\Presentation\
 * BlockRegistry has any live block registered anywhere in the app. Porting all
 * ~25 is out of scope for this migration (tracked as deferred, see the plan);
 * this bridge ports exactly 5 representative types — heading, paragraph, image,
 * button, hero — enough to prove the full validate/save/preview/publish/restore
 * pipeline with real, renderable content.
 *
 * Each render closure is a faithful, direct port of the corresponding archived
 * template (archive/plugins/content-builder/lib/blocks/{type}.php) — all five
 * were already pure functions of props -> HTML with no DB/ContentBuilderAPI
 * dependency — so output markup matches what the existing canvas CSS
 * (plugins/content-builder/assets/css/public.css, still inlined by
 * admin/editor.php) already styles. CallbackBlock is the existing adapter this
 * repo already ships for exactly this bridging purpose (see its own docblock).
 *
 * Pure registration — no DB, no side effects beyond populating the registry
 * instance handed in.
 */

declare(strict_types=1);

namespace Slate\Presentation\Rendering;

use Slate\Presentation\FieldSchema;
use Slate\Presentation\RenderContext;

final class LegacyBlockBridge
{
    public static function register(InMemoryBlockRegistry $registry): void
    {
        $registry->register(new CallbackBlock(
            'heading',
            FieldSchema::of(
                [
                    ['key' => 'text', 'type' => 'text', 'label' => 'Text'],
                    ['key' => 'level', 'type' => 'select', 'label' => 'Level', 'options' => [
                        ['v' => '1', 'l' => 'H1'], ['v' => '2', 'l' => 'H2'],
                        ['v' => '3', 'l' => 'H3'], ['v' => '4', 'l' => 'H4'],
                    ]],
                ],
                ['text' => 'Heading', 'level' => '2'],
            ),
            static function (array $props, RenderContext $ctx): string {
                $lvl = max(1, min(6, (int) ($props['level'] ?? 2)));
                return sprintf('<h%1$d class="cb-heading">%2$s</h%1$d>', $lvl, \e((string) ($props['text'] ?? '')));
            },
        ));

        $registry->register(new CallbackBlock(
            'paragraph',
            FieldSchema::of(
                [['key' => 'text', 'type' => 'textarea', 'label' => 'Text']],
                ['text' => 'Write something…'],
            ),
            static function (array $props, RenderContext $ctx): string {
                return '<p class="cb-paragraph">' . nl2br(\e((string) ($props['text'] ?? ''))) . '</p>';
            },
        ));

        $registry->register(new CallbackBlock(
            'image',
            FieldSchema::of(
                [
                    ['key' => 'media', 'type' => 'media', 'label' => 'Image'],
                    ['key' => 'width', 'type' => 'select', 'label' => 'Width', 'options' => [
                        ['v' => 'full', 'l' => 'Full'], ['v' => 'wide', 'l' => 'Wide'], ['v' => 'normal', 'l' => 'Normal'],
                    ]],
                ],
                ['width' => 'full'],
            ),
            static function (array $props, RenderContext $ctx): string {
                $media = is_array($props['media'] ?? null) ? $props['media'] : null;
                $url = self::resolveMediaUrl($media);
                if ($url === '') {
                    return '';
                }
                $wv = (string) ($props['width'] ?? 'full');
                $w = in_array($wv, ['full', 'wide', 'normal'], true) ? $wv : 'full';
                $alt = (string) ($media['alt'] ?? '');
                $style = '';
                $focal = $media['focal'] ?? null;
                if (is_array($focal) && count($focal) === 2) {
                    $style = sprintf(' style="object-position:%.2F%% %.2F%%"', (float) $focal[0] * 100, (float) $focal[1] * 100);
                }
                return sprintf(
                    '<figure class="cb-image cb-image-%s"><img src="%s" alt="%s" loading="lazy"%s></figure>',
                    \e($w),
                    \e(\slate_safe_url($url)),
                    \e($alt),
                    $style,
                );
            },
        ));

        $registry->register(new CallbackBlock(
            'button',
            FieldSchema::of(
                [
                    ['key' => 'text', 'type' => 'text', 'label' => 'Label'],
                    ['key' => 'href', 'type' => 'url', 'label' => 'Link URL'],
                    ['key' => 'style', 'type' => 'select', 'label' => 'Style', 'options' => [
                        ['v' => 'primary', 'l' => 'Primary'], ['v' => 'secondary', 'l' => 'Secondary'],
                    ]],
                ],
                ['text' => 'Click me', 'href' => '#', 'style' => 'primary'],
            ),
            static function (array $props, RenderContext $ctx): string {
                $st = (($props['style'] ?? 'primary') === 'secondary') ? 'btn-secondary' : 'btn-primary';
                return sprintf(
                    '<p class="cb-button"><a class="btn %s" href="%s">%s</a></p>',
                    $st,
                    \e(\slate_safe_url((string) ($props['href'] ?? '#'))),
                    \e((string) ($props['text'] ?? 'Button')),
                );
            },
        ));

        $registry->register(new CallbackBlock(
            'hero',
            FieldSchema::of(
                [
                    ['key' => 'pad', 'type' => 'select', 'label' => 'Section spacing', 'options' => [
                        ['v' => 'compact', 'l' => 'Compact'], ['v' => 'normal', 'l' => 'Normal'], ['v' => 'spacious', 'l' => 'Spacious'],
                    ]],
                    ['key' => 'layout', 'type' => 'select', 'label' => 'Layout', 'options' => [
                        ['v' => 'split', 'l' => 'Split (image + text)'], ['v' => 'banner', 'l' => 'Banner (text over image)'],
                    ]],
                    ['key' => 'eyebrow', 'type' => 'text', 'label' => 'Eyebrow'],
                    ['key' => 'heading', 'type' => 'text', 'label' => 'Heading'],
                    ['key' => 'subheading', 'type' => 'textarea', 'label' => 'Subheading'],
                    ['key' => 'btnText', 'type' => 'text', 'label' => 'Button label'],
                    ['key' => 'btnHref', 'type' => 'url', 'label' => 'Button link'],
                    ['key' => 'btn2Text', 'type' => 'text', 'label' => 'Second button label'],
                    ['key' => 'btn2Href', 'type' => 'url', 'label' => 'Second button link'],
                    ['key' => 'media', 'type' => 'media', 'label' => 'Image'],
                    ['key' => 'mediaSide', 'type' => 'select', 'label' => 'Image side', 'options' => [
                        ['v' => 'left', 'l' => 'Left'], ['v' => 'right', 'l' => 'Right'],
                    ]],
                    ['key' => 'overlay', 'type' => 'select', 'label' => 'Image darkness', 'options' => [
                        ['v' => 'light', 'l' => 'Light'], ['v' => 'medium', 'l' => 'Medium'], ['v' => 'dark', 'l' => 'Dark'],
                    ]],
                    ['key' => 'height', 'type' => 'select', 'label' => 'Height', 'options' => [
                        ['v' => 'normal', 'l' => 'Normal'], ['v' => 'tall', 'l' => 'Tall'], ['v' => 'short', 'l' => 'Short'],
                    ]],
                ],
                [
                    'pad' => 'normal', 'layout' => 'split', 'eyebrow' => '', 'heading' => 'Your big headline',
                    'subheading' => 'A short supporting sentence that sells the idea.',
                    'btnText' => 'Get started', 'btnHref' => '#', 'btn2Text' => '', 'btn2Href' => '',
                    'mediaSide' => 'left', 'overlay' => 'medium', 'height' => 'normal',
                ],
            ),
            static function (array $props, RenderContext $ctx): string {
                return self::renderHero($props);
            },
        ));

        self::registerArchivedFallbacks($registry);
    }

    /**
     * Keep archived content portable even when a specialized renderer is not
     * available in the active application. These contracts deliberately expose
     * only safe text fields; richer blocks can be upgraded without changing the
     * stored type or document shape later.
     */
    private static function registerArchivedFallbacks(InMemoryBlockRegistry $registry): void
    {
        foreach (['columns', 'container', 'cta', 'divider', 'html', 'icon-grid', 'image-grid', 'post-list', 'spacer', 'testimonial', 'react', 'rx-gallery', 'rx-hero', 'rx-marquee', 'rx-menu', 'rx-reviews', 'rx-story', 'rx-visit'] as $type) {
            $registry->register(new CallbackBlock(
                $type,
                FieldSchema::of([
                    ['key' => 'heading', 'type' => 'text', 'label' => 'Heading'],
                    ['key' => 'content', 'type' => 'textarea', 'label' => 'Content'],
                ], ['heading' => ucfirst(str_replace('-', ' ', $type)), 'content' => '']),
                static function (array $props, RenderContext $ctx) use ($type): string {
                    $heading = trim((string) ($props['heading'] ?? ''));
                    $content = trim((string) ($props['content'] ?? ''));
                    $html = '<div class="cb-legacy-' . \e($type) . '">';
                    if ($heading !== '') $html .= '<h2>' . \e($heading) . '</h2>';
                    if ($content !== '') $html .= '<p>' . nl2br(\e($content)) . '</p>';
                    return $html . '</div>';
                },
            ));
        }
    }

    /** @param array<string,mixed>|null $media */
    private static function resolveMediaUrl(?array $media): string
    {
        $key = trim((string) ($media['key'] ?? ''));
        if ($key === '') {
            return '';
        }
        // Logical key -> a path under uploads/, never an arbitrary host or an
        // escape from it (Phase 2 spec §8: "must not permit path traversal").
        $key = ltrim($key, '/');
        if ($key === '' || str_contains($key, '..') || str_contains($key, "\0")) {
            return '';
        }
        $base = defined('SLATE_URL') ? \SLATE_URL : '';
        return rtrim($base, '/') . '/uploads/' . $key;
    }

    /** @param array<string,mixed> $props */
    private static function renderHero(array $props): string
    {
        $layout = (string) ($props['layout'] ?? 'banner');
        $layout = in_array($layout, ['split', 'banner'], true) ? $layout : 'banner';
        $overlay = (string) ($props['overlay'] ?? 'medium');
        $overlay = in_array($overlay, ['light', 'medium', 'dark'], true) ? $overlay : 'medium';
        $height = (string) ($props['height'] ?? 'normal');
        $height = in_array($height, ['short', 'normal', 'tall'], true) ? $height : 'normal';
        $mediaSide = (($props['mediaSide'] ?? 'left') === 'right') ? 'right' : 'left';
        $pad = (string) ($props['pad'] ?? 'normal');
        $pad = in_array($pad, ['compact', 'normal', 'spacious'], true) ? $pad : 'normal';

        $media = is_array($props['media'] ?? null) ? $props['media'] : null;
        $imageUrl = self::resolveMediaUrl($media);
        $hasImg = $imageUrl !== '';

        $eyebrow = (string) ($props['eyebrow'] ?? '');
        $heading = (string) ($props['heading'] ?? '');
        $subheading = (string) ($props['subheading'] ?? '');
        $btnText = (string) ($props['btnText'] ?? '');
        $btnHref = (string) ($props['btnHref'] ?? '#');
        $btn2Text = (string) ($props['btn2Text'] ?? '');
        $btn2Href = (string) ($props['btn2Href'] ?? '#');

        $actions = '<div class="cb-hero-actions">';
        if ($btnText !== '') {
            $actions .= sprintf('<a class="cb-btn cb-btn-primary" href="%s">%s</a>', \e(\slate_safe_url($btnHref)), \e($btnText));
        }
        if ($btn2Text !== '') {
            $extra = ($hasImg && $layout === 'banner') ? ' style="color:#fff;box-shadow:inset 0 0 0 1.5px #fff"' : '';
            $actions .= sprintf('<a class="cb-btn cb-btn-outline" href="%s"%s>%s</a>', \e(\slate_safe_url($btn2Href)), $extra, \e($btn2Text));
        }
        $actions .= '</div>';

        $eyebrowHtml = $eyebrow !== '' ? '<span class="cb-eyebrow">' . \e($eyebrow) . '</span>' : '';
        $headingHtml = $heading !== '' ? '<h1 class="cb-hero-title">' . \e($heading) . '</h1>' : '';
        $subHtml = $subheading !== '' ? '<p class="cb-hero-sub">' . \e($subheading) . '</p>' : '';

        if ($layout === 'split' && $hasImg) {
            $cls = 'cb-hero cb-hero-split cb-hero-media-' . $mediaSide;
            return sprintf(
                '<section class="cb-pad-%s %s"><div class="cb-hero-inner">'
                    . '<div class="cb-hero-media"><img src="%s" alt="%s"></div>'
                    . '<div class="cb-hero-body">%s%s%s%s</div>'
                    . '</div></section>',
                \e($pad), \e($cls), \e(\slate_safe_url($imageUrl)), \e($heading),
                $eyebrowHtml, $headingHtml, $subHtml, $actions,
            );
        }

        $cls = 'cb-hero cb-hero-banner cb-hero-h-' . $height;
        $style = '';
        if ($hasImg) {
            $cls .= ' cb-overlay-' . $overlay;
            $style = ' style="background-image:url(\'' . \e(\slate_safe_url($imageUrl)) . '\')"';
        } else {
            $cls .= ' cb-hero-plain';
        }

        return sprintf(
            '<section class="cb-pad-%s %s"%s><div class="cb-hero-inner">%s%s%s%s</div></section>',
            \e($pad), \e($cls), $style, $eyebrowHtml, $headingHtml, $subHtml, $actions,
        );
    }
}
