<?php
/**
 * Slate — shared error-page renderer.
 *
 * Used by 404.php / 403.php / 500.php at the root and by PublicRouter for
 * unmatched public routes. Renders a branded, full-screen page that matches
 * the landing page: the Branding login image as the background, a frosted
 * glass card, the business logo and accent colour.
 *
 * Branding is pulled from the DB ONLY when it's safely available — every DB
 * read is wrapped so a 500 caused by a database outage still renders (it just
 * falls back to an accent gradient instead of the hero image). Self-contained:
 * no template engine, no plugin code.
 *
 *   slate_render_error(404, 'Not found', 'We couldn\'t find that page.');
 */
if (!function_exists('slate_render_error')) {
    function slate_render_error(int $status, string $title, string $message): void {
        @http_response_code($status);
        $e = static fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');

        $home    = defined('SLATE_URL') ? rtrim((string)SLATE_URL, '/') : '';
        $accent  = '#2563EB';
        $hero = $logo = $biz = $siteUrl = '';

        // Best-effort branding — never let it break the error page itself.
        try {
            if (class_exists('Database')) {
                $a = (string)Database::setting('brand_accent_color');
                if (preg_match('/^#[0-9a-fA-F]{6}$/', $a)) $accent = $a;
                $hp = (string)Database::setting('brand_login_image_path');
                if ($hp !== '' && $home !== '') $hero = $home . '/' . ltrim($hp, '/');
                $lp = (string)Database::setting('brand_logo_path');
                if ($lp !== '' && $home !== '') $logo = $home . '/' . ltrim($lp, '/');
                $biz     = (string)(Database::setting('business_name') ?: Database::setting('site_name'));
                $siteUrl = (string)Database::setting('landing_website_url');
            }
        } catch (\Throwable $ignored) {
            // DB unavailable (e.g. a real 500) — gradient fallback below.
        }

        $bg = $hero !== ''
            ? 'background:url("' . $e($hero) . '") center/cover no-repeat;'
            : 'background:radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--accent) 45%, #0b1c2c), #0b1c2c);';
        ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= $status ?> · <?= $e($title) ?></title>
<?php if ($logo !== ''): ?><link rel="icon" href="<?= $e($logo) ?>"><?php endif; ?>
<style>
    :root { --accent: <?= $e($accent) ?>; }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        min-height: 100vh; min-height: 100dvh; color: #fff;
        display: grid; place-items: center; padding: 24px; position: relative; background: #0b1c2c;
    }
    .bg { position: fixed; inset: 0; z-index: -2; <?= $bg ?> }
    .bg::after { content: ""; position: absolute; inset: 0;
        background:
            linear-gradient(180deg, rgba(8,18,28,.74) 0%, rgba(8,18,28,.6) 45%, rgba(8,18,28,.9) 100%),
            radial-gradient(90% 60% at 50% 0%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 70%);
    }
    .card {
        width: 100%; max-width: 460px; text-align: center; padding: 40px 34px 34px;
        background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); border-radius: 18px;
        -webkit-backdrop-filter: blur(16px) saturate(140%); backdrop-filter: blur(16px) saturate(140%);
        box-shadow: 0 22px 60px -22px rgba(0,0,0,.6);
    }
    .logo { height: 46px; width: auto; margin: 0 auto 20px; display: block; filter: drop-shadow(0 6px 18px rgba(0,0,0,.35)); }
    .code {
        display: inline-block; font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 12px; letter-spacing: .14em; font-weight: 700; text-transform: uppercase; color: var(--accent);
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
        padding: 5px 12px; border-radius: 999px; margin-bottom: 16px;
    }
    h1 { margin: 0 0 10px; font-size: 27px; font-weight: 800; letter-spacing: -.02em; text-shadow: 0 2px 18px rgba(0,0,0,.3); }
    p { margin: 0 0 24px; color: rgba(255,255,255,.85); font-size: 14.5px; line-height: 1.55; }
    .actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    .btn {
        display: inline-flex; align-items: center; gap: 7px; padding: 11px 18px; border-radius: 11px;
        text-decoration: none; font-weight: 650; font-size: 14px; transition: transform .15s, background .15s, border-color .15s;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn-primary { background: var(--accent); color: #fff; box-shadow: 0 10px 26px -10px var(--accent); }
    .btn-primary:hover { filter: brightness(1.06); }
    .btn-ghost { background: rgba(255,255,255,.10); color: #fff; border: 1px solid rgba(255,255,255,.22); }
    .btn-ghost:hover { background: rgba(255,255,255,.18); }
    .biz { margin-top: 22px; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: rgba(255,255,255,.6); }
</style>
</head>
<body>
    <div class="bg"></div>
    <div class="card">
        <?php if ($logo !== ''): ?><img class="logo" src="<?= $e($logo) ?>" alt="<?= $e($biz) ?>"><?php endif; ?>
        <div class="code">Error <?= $status ?></div>
        <h1><?= $e($title) ?></h1>
        <p><?= $e($message) ?></p>
        <div class="actions">
            <a class="btn btn-primary" href="<?= $e($home) ?>/">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>
                Return home
            </a>
            <?php if ($siteUrl !== ''): ?>
            <a class="btn btn-ghost" href="<?= $e($siteUrl) ?>">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
                Back to website
            </a>
            <?php endif; ?>
        </div>
        <?php if ($biz !== ''): ?><div class="biz"><?= $e($biz) ?></div><?php endif; ?>
    </div>
</body>
</html>
        <?php
    }
}

if (!function_exists('slate_maintenance_gate')) {
    /**
     * Public-side maintenance gate. When maintenance mode is enabled, shows the
     * branded 503 page to visitors; a logged-in admin passes through so they can
     * keep working. Best-effort — never blocks if the DB/Auth aren't available.
     * Call this at the top of public entry points (public.php, root index.php).
     */
    function slate_maintenance_gate(): void {
        try {
            if (!class_exists('Database') || Database::setting('maintenance_mode') !== '1') return;
            if (class_exists('Auth') && Auth::check()) return; // admin is logged in → allow through
        } catch (\Throwable $e) {
            return; // not installed / DB unavailable → don't block
        }
        @http_response_code(503);
        @header('Retry-After: 3600');
        slate_render_error(503, 'Down for maintenance',
            "We're making some improvements and will be back shortly. Thanks for your patience.");
        exit;
    }
}
