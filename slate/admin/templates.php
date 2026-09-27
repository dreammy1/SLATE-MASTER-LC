<?php
/**
 * Slate — Template Library.
 *
 * Content -> Templates (/admin/templates.php)
 * Central management of page templates, section layout templates, and starter packs.
 */

declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

Auth::require();
Auth::requirePerm('content.view');

$pageTitle  = __('templates', 'Templates');
$currentNav = 'templates';

// Load available page templates
$pageTemplates = [
    [
        'id'          => 'default',
        'name'        => __('template_default', 'Default Page'),
        'description' => __('template_default_desc', 'Standard boxed layout with global header, contained content, and footer.'),
        'type'        => 'page',
        'badge'       => 'Core',
    ],
    [
        'id'          => 'full-width',
        'name'        => __('template_full_width', 'Full Width Canvas'),
        'description' => __('template_full_width_desc', 'Edge-to-edge section container suitable for modern visual marketing pages.'),
        'type'        => 'page',
        'badge'       => 'Core',
    ],
    [
        'id'          => 'landing',
        'name'        => __('template_landing', 'Landing Page (No Header/Footer)'),
        'description' => __('template_landing_desc', 'Distraction-free high conversion landing page without global navigation.'),
        'type'        => 'page',
        'badge'       => 'Marketing',
    ],
    [
        'id'          => 'blog-single',
        'name'        => __('template_blog_single', 'Editorial Post'),
        'description' => __('template_blog_single_desc', 'Optimized typography for articles, reading progress, and author metadata.'),
        'type'        => 'post',
        'badge'       => 'Blog',
    ],
];

// Load available section layout presets
$sectionTemplates = [
    [
        'id'          => 'hero-split',
        'name'        => 'Split Hero Banner',
        'category'    => 'Hero',
        'description' => 'Two-column layout with high-impact headline, value bullets, primary CTA, and responsive media container.',
    ],
    [
        'id'          => 'features-grid-3',
        'name'        => 'Three-Column Features Grid',
        'category'    => 'Features',
        'description' => 'Modern bento-style cards with icons, titles, short descriptions, and link tags.',
    ],
    [
        'id'          => 'social-proof',
        'name'        => 'Testimonial & Social Proof Wall',
        'category'    => 'Testimonials',
        'description' => 'Customer quotes, client logos, star ratings, and verified badge indicators.',
    ],
    [
        'id'          => 'pricing-table',
        'name'        => 'Three-Tier Pricing Table',
        'category'    => 'Commerce',
        'description' => 'Highlight featured plan, toggle billing cadences, and direct checkout buttons.',
    ],
    [
        'id'          => 'contact-cta',
        'name'        => 'Conversion CTA with Contact',
        'category'    => 'Call to Action',
        'description' => 'Bold accent banner with newsletter signup or booking inquiry prompt.',
    ],
];

require __DIR__ . '/partials/header.php';
?>

<div class="content-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;">
    <div>
        <h1 style="margin:0 0 6px;font-size:24px;font-weight:700;color:var(--text);"><?= __('templates_library', 'Template Library') ?></h1>
        <p style="margin:0;color:var(--muted);font-size:14px;"><?= __('templates_library_sub', 'Standard page structures, section presets, and reusable design layouts.') ?></p>
    </div>
    <div style="display:flex;gap:10px;">
        <a href="<?= e(SLATE_URL) ?>/admin/editor.php" class="btn btn-primary">
            <?= slate_admin_nav_icon('layout') ?>
            <span><?= __('open_editor', 'New Page in Editor') ?></span>
        </a>
    </div>
</div>

<div class="card" style="margin-bottom:32px;">
    <div class="card-header">
        <h2><?= __('page_templates', 'Page Document Templates') ?></h2>
        <span class="badge badge-info"><?= count($pageTemplates) ?> <?= __('templates', 'Templates') ?></span>
    </div>
    <div class="card-body" style="padding:20px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:18px;">
            <?php foreach ($pageTemplates as $tmpl): ?>
                <div class="card" style="margin:0;border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;justify-content:space-between;">
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                            <strong style="font-size:16px;color:var(--text);"><?= e($tmpl['name']) ?></strong>
                            <span class="badge"><?= e($tmpl['badge']) ?></span>
                        </div>
                        <p style="font-size:13px;color:var(--muted);margin:0 0 16px;line-height:1.45;"><?= e($tmpl['description']) ?></p>
                    </div>
                    <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);padding-top:12px;">
                        <code style="font-size:11px;color:var(--subtle);"><?= e($tmpl['id']) ?></code>
                        <a href="<?= e(SLATE_URL) ?>/admin/editor.php?template=<?= urlencode($tmpl['id']) ?>" class="btn btn-sm btn-ghost">
                            <?= __('use_in_editor', 'Use Template') ?> →
                        </a>
                    </div>
                </div>
            <?php endforeach; ?>
        </div>
    </div>
</div>

<div class="card">
    <div class="card-header">
        <h2><?= __('section_templates', 'Section Layout Library') ?></h2>
        <span class="badge badge-info"><?= count($sectionTemplates) ?> <?= __('presets', 'Presets') ?></span>
    </div>
    <div class="card-body" style="padding:20px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:18px;">
            <?php foreach ($sectionTemplates as $sec): ?>
                <div class="card" style="margin:0;border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;justify-content:space-between;">
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                            <strong style="font-size:15px;color:var(--text);"><?= e($sec['name']) ?></strong>
                            <span class="badge badge-secondary"><?= e($sec['category']) ?></span>
                        </div>
                        <p style="font-size:13px;color:var(--muted);margin:0 0 16px;line-height:1.45;"><?= e($sec['description']) ?></p>
                    </div>
                    <div style="display:flex;justify-content:flex-end;">
                        <a href="<?= e(SLATE_URL) ?>/admin/editor.php?insert_section=<?= urlencode($sec['id']) ?>" class="btn btn-sm btn-secondary">
                            <?= __('insert_in_page', 'Insert in Editor') ?>
                        </a>
                    </div>
                </div>
            <?php endforeach; ?>
        </div>
    </div>
</div>

<?php
require __DIR__ . '/partials/footer.php';
