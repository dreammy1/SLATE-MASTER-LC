<?php
/**
 * Slate — public landing page renderer.
 *
 * Single source of truth for the "choose your vessel" entry page, shared by
 * the site root (index.php) and the forms index (/forms/). All content is
 * driven by the Landing settings tab (admin/settings.php → Landing), so it is
 * fully editable from the backend with no code change:
 *
 *   landing_eyebrow, landing_title, landing_intro, landing_footer,
 *   landing_website_url, landing_website_label, landing_forms_json
 *
 * The featured cards come from landing_forms_json (a list of {id,label,blurb,
 * icon}); if none are configured yet it falls back to the Powerboat/Sailboat
 * survey forms so a fresh install still looks complete. The hero background
 * reuses the Branding login image. Layout is built to fit one 100vh screen on
 * desktop/tablet and to scroll gracefully on small phones.
 */

if (!function_exists('slate_render_landing')) {

/** Inline SVG illustration for a vessel/icon key (stroke = currentColor). */
function slate_landing_icon(string $kind): string {
    switch ($kind) {
        case 'sailboat':
            return '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 . '<path d="M32 6v34"/>'
                 . '<path d="M32 10c10 5 15 14 16 26H32z" fill="currentColor" fill-opacity=".14"/>'
                 . '<path d="M30 12C22 17 18 26 16 36h14z" fill="currentColor" fill-opacity=".08"/>'
                 . '<path d="M10 44h44l-7 11a6 6 0 0 1-5 3H22a6 6 0 0 1-5-3z" fill="currentColor" fill-opacity=".16"/>'
                 . '<path d="M6 50c4 2 6 2 10 0s6-2 10 0 6 2 10 0 6-2 10 0 6 2 10 0"/></svg>';
        case 'boat':
            return '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 . '<path d="M10 40h44l-6 11a6 6 0 0 1-5 3H21a6 6 0 0 1-5-3z" fill="currentColor" fill-opacity=".16"/>'
                 . '<path d="M16 40V22l28 18z" fill="currentColor" fill-opacity=".08"/>'
                 . '<path d="M4 54c4 2 6 2 10 0s6-2 10 0 6 2 10 0 6-2 10 0 6 2 10 0"/></svg>';
        case 'anchor':
            return '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 . '<circle cx="32" cy="14" r="5"/><path d="M32 19v33"/><path d="M20 30h24"/>'
                 . '<path d="M12 36c0 11 9 18 20 18s20-7 20-18"/><path d="M12 36l-5 4M12 36l6 2M52 36l5 4M52 36l-6 2"/></svg>';
        case 'compass':
            return '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 . '<circle cx="32" cy="32" r="24"/><path d="M42 22 36 36 22 42 28 28z" fill="currentColor" fill-opacity=".14"/></svg>';
        case 'star':
            return '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 . '<path d="M32 8l7.6 15.4L56 25.8 44 37.5l2.8 16.5L32 46.2 17.2 54l2.8-16.5L8 25.8l16.4-2.4z" fill="currentColor" fill-opacity=".12"/></svg>';
        case 'clipboard':
            return '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 . '<rect x="16" y="10" width="32" height="44" rx="4" fill="currentColor" fill-opacity=".08"/>'
                 . '<rect x="24" y="6" width="16" height="8" rx="2"/><path d="M24 28h16M24 36h16M24 44h10"/></svg>';
        case 'powerboat':
        default:
            return '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 . '<path d="M8 34h40l8-12-30 4z" fill="currentColor" fill-opacity=".10"/>'
                 . '<path d="M6 40h52l-6 10a6 6 0 0 1-5 3H17a6 6 0 0 1-5-3z" fill="currentColor" fill-opacity=".18"/>'
                 . '<path d="M30 22v12M30 22l18-2"/>'
                 . '<path d="M4 52c4 2 6 2 10 0s6-2 10 0 6 2 10 0 6-2 10 0 6 2 10 0"/></svg>';
    }
}

/** Render and echo the full landing page document. */
function slate_render_landing(): void {
    $e = static fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');

    $siteName = Database::setting('site_name')     ?: 'Slate';
    $bizName  = Database::setting('business_name')  ?: $siteName;
    $accent   = preg_match('/^#[0-9a-fA-F]{6}$/', (string)Database::setting('brand_accent_color'))
                ? (string)Database::setting('brand_accent_color') : '#01aced';
    $logoPath = (string)Database::setting('brand_logo_path');
    $logoUrl  = $logoPath !== '' ? SLATE_URL . '/' . ltrim($logoPath, '/') : '';
    $heroPath = (string)Database::setting('brand_login_image_path');
    $heroUrl  = $heroPath !== '' ? SLATE_URL . '/' . ltrim($heroPath, '/') : '';

    // Editable copy (fall back to sensible defaults when unset).
    $eyebrow = (string)Database::setting('landing_eyebrow') ?: 'Vessel Survey Orders';
    $title   = (string)Database::setting('landing_title')   ?: $bizName;
    $intro   = (string)Database::setting('landing_intro')   ?:
        'Please choose either Powerboat or Sailboat from one of the two vessel survey order forms below:';
    $footer  = (string)Database::setting('landing_footer')  ?:
        ('© ' . date('Y') . ' ' . $bizName . '. All rights reserved.');

    // Back-to-website link (main domain) — hidden when blank.
    $siteUrl   = (string)Database::setting('landing_website_url');
    $siteLabel = (string)Database::setting('landing_website_label') ?: 'Back to website';

    // Contact details from the business profile (Settings → Profile). Each is
    // shown only when set; phone/email become tel:/mailto: links.
    $cPhone = trim((string)Database::setting('business_phone'));
    $cEmail = trim((string)Database::setting('business_email'));
    $cAddr  = trim((string)Database::setting('business_address'));
    // Only turn the phone into a tel: link when it's a single clean number —
    // many businesses store free-form text ("Phone: … Outside the U.S.: …") or
    // two numbers, which must not be mashed into one bogus dial string. A real
    // single number has no letters and 7–15 digits (E.164 max is 15; two
    // concatenated numbers exceed that).
    $phoneDigits   = preg_replace('/\D/', '', $cPhone);
    $phoneDialable = $cPhone !== '' && !preg_match('/[A-Za-z]/', $cPhone)
                     && strlen($phoneDigits) >= 7 && strlen($phoneDigits) <= 15;
    $telHref = $phoneDialable ? 'tel:' . preg_replace('/[^0-9+]/', '', $cPhone) : '';
    $hasContact = $cPhone !== '' || $cEmail !== '' || $cAddr !== '';

    // Build the featured cards from saved config; fall back to the two vessel
    // survey forms so a fresh install still shows something meaningful.
    $configured = (array)json_decode((string)Database::setting('landing_forms_json'), true);
    if (!$configured) {
        $configured = [
            ['slug' => 'powerboat-survey-order', 'label' => 'Powerboat', 'icon' => 'powerboat',
             'blurb' => 'Motor yachts, cruisers, and powered vessels — engines, hull, and systems.'],
            ['slug' => 'sailboat-survey-order',  'label' => 'Sailboat',  'icon' => 'sailboat',
             'blurb' => 'Sailing yachts and keelboats — rigging, sails, hull, and systems.'],
        ];
    }

    $cards = [];
    if (class_exists('FormsAPI')) {
        foreach ($configured as $c) {
            $form = isset($c['id']) ? FormsAPI::getFormById((int)$c['id'])
                  : (isset($c['slug']) ? FormsAPI::getForm((string)$c['slug']) : null);
            if (!$form || ($form['status'] ?? '') !== 'published') continue;
            $cards[] = [
                'label'  => ($c['label'] ?? '') !== '' ? $c['label'] : $form['title'],
                'blurb'  => (string)($c['blurb'] ?? ''),
                'icon'   => (string)($c['icon'] ?? 'clipboard'),
                'button' => (string)($c['button'] ?? ''),
                'url'    => SLATE_URL . '/forms/' . $form['slug'],
            ];
        }
    }
    $year = date('Y');
    ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= $e($title) ?> — <?= $e($eyebrow) ?></title>
<?php if ($logoUrl !== ''): ?><link rel="icon" href="<?= $e($logoUrl) ?>"><?php endif; ?>
<style>
    :root { --accent: <?= $e($accent) ?>; --radius: 18px; }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #fff; min-height: 100vh; min-height: 100dvh;
        display: flex; flex-direction: column; position: relative;
        background: #0b1c2c; overflow: hidden;
    }
    .bg { position: fixed; inset: 0; z-index: -2;
        <?php if ($heroUrl !== ''): ?>background: url("<?= $e($heroUrl) ?>") center/cover no-repeat;
        <?php else: ?>background: radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--accent) 45%, #0b1c2c), #0b1c2c);<?php endif; ?>
    }
    .bg::after { content: ""; position: absolute; inset: 0;
        background:
            linear-gradient(180deg, rgba(8,18,28,.72) 0%, rgba(8,18,28,.55) 40%, rgba(8,18,28,.88) 100%),
            radial-gradient(90% 60% at 50% 0%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 70%);
    }
    /* Top bar: back-to-website link. */
    .topbar { position: relative; display: flex; align-items: center; gap: 12px; padding: clamp(12px, 2.4vh, 20px) clamp(16px, 3vw, 30px); }
    /* Brand sits at the top-right, opposite the back link. */
    .topbrand { display: flex; align-items: center; gap: 11px; margin-left: auto; text-decoration: none; color: #fff; }
    .topbrand img { height: clamp(34px, 5.4vh, 46px); width: auto; filter: drop-shadow(0 6px 16px rgba(0,0,0,.4)); }
    .topbrand-name { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; font-weight: 600; color: rgba(255,255,255,.88); white-space: nowrap; }
    @media (max-width: 560px) { .topbrand-name { display: none; } }
    .back {
        display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
        font-size: 13.5px; font-weight: 600; color: rgba(255,255,255,.9);
        padding: 8px 14px; border-radius: 999px;
        background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.18);
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); transition: background .15s, transform .15s;
    }
    .back:hover { background: rgba(255,255,255,.18); transform: translateX(-2px); }
    .back svg { width: 16px; height: 16px; }
    /* Centred hero column. */
    .wrap {
        flex: 1; width: 100%; max-width: 980px; margin: 0 auto;
        padding: clamp(8px, 2vh, 24px) clamp(18px, 4vw, 30px) clamp(10px, 2vh, 22px);
        display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; min-height: 0;
    }
    /* (brand now lives in the top bar — see .topbrand) */
    .eyebrow {
        display: inline-flex; align-items: center; gap: 8px;
        font-size: 11.5px; letter-spacing: .14em; text-transform: uppercase; font-weight: 700; color: var(--accent);
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
        padding: 6px 14px; border-radius: 999px; margin-bottom: clamp(10px, 2vh, 18px);
    }
    .eyebrow svg { width: 14px; height: 14px; }
    h1 { font-size: clamp(26px, 5vh, 44px); line-height: 1.08; font-weight: 800; letter-spacing: -.02em;
        margin: 0 0 clamp(10px, 1.8vh, 16px); max-width: 16ch; text-shadow: 0 2px 20px rgba(0,0,0,.35); }
    .lede { font-size: clamp(14px, 2.2vh, 18px); line-height: 1.5; font-weight: 500; color: rgba(255,255,255,.9);
        max-width: 42ch; margin: 0 auto clamp(20px, 4vh, 38px); }
    .cards { display: grid; gap: clamp(14px, 2.4vw, 20px); width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (max-width: 620px) { .cards { grid-template-columns: minmax(0, 1fr); } }
    .card {
        position: relative; display: flex; flex-direction: column; align-items: center; gap: clamp(10px, 1.6vh, 16px);
        padding: clamp(22px, 3.2vh, 34px) 26px clamp(20px, 2.6vh, 28px); text-decoration: none; color: #fff;
        background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); border-radius: var(--radius);
        -webkit-backdrop-filter: blur(14px) saturate(140%); backdrop-filter: blur(14px) saturate(140%);
        box-shadow: 0 18px 50px -20px rgba(0,0,0,.55);
        transition: transform .2s cubic-bezier(.4,0,.2,1), border-color .2s, background .2s, box-shadow .2s; overflow: hidden;
    }
    .card::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 4px;
        background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: 0; transition: opacity .2s; }
    .card:hover { transform: translateY(-6px); border-color: color-mix(in srgb, var(--accent) 70%, transparent);
        background: rgba(255,255,255,.13); box-shadow: 0 26px 60px -18px rgba(0,0,0,.6); }
    .card:hover::before { opacity: 1; }
    .card:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    .card-ico { width: clamp(76px, 11vh, 96px); height: clamp(76px, 11vh, 96px); display: grid; place-items: center;
        color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); border-radius: 50%; }
    .card-ico svg { width: 56%; height: 56%; }
    .card-title { font-size: clamp(19px, 2.6vh, 22px); font-weight: 750; letter-spacing: -.01em; }
    .card-blurb { font-size: 13.5px; line-height: 1.5; color: rgba(255,255,255,.78); margin: -2px 0 2px; }
    .card-cta { display: inline-flex; align-items: center; gap: 7px; margin-top: auto; font-size: 14px; font-weight: 700; color: var(--accent); }
    .card-cta svg { width: 16px; height: 16px; transition: transform .2s; }
    .card:hover .card-cta svg { transform: translateX(4px); }
    .empty { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); border-radius: var(--radius); padding: 28px; max-width: 460px; }
    footer { position: relative; text-align: center; padding: clamp(8px, 1.6vh, 16px) 20px clamp(10px, 1.8vh, 16px); }
    /* Slim, divided contact line (from the business profile) — light-weight so
       it never pushes the page past 100vh. */
    .contact { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; margin-bottom: 8px; }
    .contact > * {
        position: relative; display: inline-flex; align-items: center; gap: 7px;
        padding: 2px 16px; font-size: 12.5px; font-weight: 500;
        color: rgba(255,255,255,.82); text-decoration: none; transition: color .15s;
    }
    .contact > * + *::before {
        content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
        width: 1px; height: 13px; background: rgba(255,255,255,.24);
    }
    .contact a:hover { color: #fff; }
    .contact svg { width: 14px; height: 14px; flex: none; color: var(--accent); }
    .foot-copy { font-size: 12px; color: rgba(255,255,255,.55); }
    @media (max-width: 600px) {
        .contact { flex-direction: column; gap: 6px; }
        .contact > * + *::before { display: none; }
    }
    /* Small phones / very short viewports: let the page scroll instead of clipping. */
    @media (max-width: 620px), (max-height: 660px) {
        body { overflow: auto; height: auto; }
        .wrap { justify-content: flex-start; }
    }
</style>
</head>
<body>
    <div class="bg"></div>

    <header class="topbar">
        <?php if ($siteUrl !== ''): ?>
            <a class="back" href="<?= $e($siteUrl) ?>">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
                <?= $e($siteLabel) ?>
            </a>
        <?php endif; ?>
        <a class="topbrand" href="<?= $e(SLATE_URL) ?>/">
            <?php if ($logoUrl !== ''): ?><img src="<?= $e($logoUrl) ?>" alt="<?= $e($bizName) ?>"><?php endif; ?>
            <span class="topbrand-name"><?= $e($bizName) ?></span>
        </a>
    </header>

    <main class="wrap">
        <span class="eyebrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18c2 1.2 3 1.2 5 0s3-1.2 5 0 3 1.2 5 0 3-1.2 5 0"/><path d="M5 18V9l13-3v12"/><path d="M5 9l13-3"/></svg>
            <?= $e($eyebrow) ?>
        </span>

        <h1><?= $e($title) ?></h1>
        <p class="lede"><?= $e($intro) ?></p>

        <?php if ($cards): ?>
            <div class="cards">
                <?php foreach ($cards as $c): ?>
                    <a class="card" href="<?= $e($c['url']) ?>">
                        <span class="card-ico"><?= slate_landing_icon($c['icon']) ?></span>
                        <span class="card-title"><?= $e($c['label']) ?></span>
                        <?php if ($c['blurb'] !== ''): ?><span class="card-blurb"><?= $e($c['blurb']) ?></span><?php endif; ?>
                        <span class="card-cta">
                            <?= $e($c['button'] !== '' ? $c['button'] : 'Start ' . $c['label']) ?>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                        </span>
                    </a>
                <?php endforeach; ?>
            </div>
        <?php else: ?>
            <div class="empty">The survey order forms aren’t published yet. Please check back shortly.</div>
        <?php endif; ?>
    </main>

    <footer>
        <?php if ($hasContact): ?>
        <div class="contact">
            <?php if ($cPhone !== ''):
                $phoneTag = $phoneDialable ? 'a' : 'span';
                $phoneAttr = $phoneDialable ? ' href="' . $e($telHref) . '" aria-label="Call us"' : '';
            ?>
                <<?= $phoneTag ?><?= $phoneAttr ?>>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    <?= $e($cPhone) ?>
                </<?= $phoneTag ?>>
            <?php endif; ?>
            <?php if ($cEmail !== ''): ?>
                <a href="mailto:<?= $e($cEmail) ?>" aria-label="Email us">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>
                    <?= $e($cEmail) ?>
                </a>
            <?php endif; ?>
            <?php if ($cAddr !== ''): ?>
                <span class="addr">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                    <span><?= $e(preg_replace('/\s*\R\s*/u', ' · ', $cAddr)) ?></span>
                </span>
            <?php endif; ?>
        </div>
        <?php endif; ?>
        <div class="foot-copy"><?= $e($footer) ?></div>
    </footer>
</body>
</html>
    <?php
}

}
