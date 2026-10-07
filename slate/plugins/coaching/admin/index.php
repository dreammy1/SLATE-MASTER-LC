<?php
/**
 * Coaching — admin overview.
 *
 * KPI snapshot + link into the full roster / settings.
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/CoachingAPI.php';
require_once dirname(__DIR__) . '/includes/assets.php';

Auth::require();
if (!Auth::can('coaching.view_clients')
    && !Auth::can('coaching.manage_clients')
    && !Auth::isSuperAdmin()) {
    Auth::requirePerm('coaching.view_clients');
}
if (function_exists('slate_require_plugin_entitlement')) { slate_require_plugin_entitlement('coaching'); }
CoachingAPI::ensureSchema();

$pageTitle  = 'Coaching';
$currentNav = 'coaching';
$tid        = current_tenant_id();

$clients      = CoachingAPI::listEnrolledClients();
$totalClients = count($clients);
$profiles     = (int) Database::value("SELECT COUNT(*) FROM coaching_profile   WHERE tenant_id = ?", [$tid]);
$goals        = (int) Database::value("SELECT COUNT(*) FROM coaching_goal      WHERE tenant_id = ? AND is_active = 1", [$tid]);
$checkins     = (int) Database::value("SELECT COUNT(*) FROM coaching_goal_checkin WHERE tenant_id = ? AND day = CURDATE()", [$tid]);
$planId       = (int) (Database::setting('coaching.program_plan_id') ?? 0);
$planRow      = $planId > 0 && class_exists('MembershipAPI')
    ? Database::row("SELECT name FROM membership_plans WHERE id = ?", [$planId])
    : null;

require SLATE_ROOT . '/admin/partials/header.php';

// The plugin's design, emitted by the page rather than relying on a boot-time
// enqueue that never runs while coaching is inactive.
coaching_emit_css('admin.css');

slate_breadcrumbs([
    ['label' => 'Dashboard', 'href' => SLATE_URL . '/admin/'],
    ['label' => 'Coaching'],
]);
?>

<div class="page-header">
    <div>
        <h1>Coaching</h1>
        <p class="text-muted">The 3-month Body &amp; Soul Program surface. Clients here are gated on their membership.</p>
    </div>
    <div class="page-actions">
        <a href="<?= e(plugin_url('coaching', 'admin/clients.php')) ?>" class="btn btn-secondary">Program clients</a>
        <a href="<?= e(plugin_url('coaching', 'admin/settings.php')) ?>" class="btn btn-primary">Settings</a>
    </div>
</div>

<?php if (!$planRow): ?>
    <div class="alert alert-warning" style="margin-bottom:var(--space-4);">
        <strong>Setup incomplete:</strong> no membership plan is wired as the program gate yet.
        <a href="<?= e(plugin_url('coaching', 'admin/settings.php')) ?>">Open Coaching settings</a> to pick one.
        Until then, no client will be marked "enrolled" on this dashboard.
    </div>
<?php endif; ?>

<div class="kpi-strip" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-3);margin-bottom:var(--space-4);">
    <div class="card kpi-card"><div class="kpi-label">Enrolled clients</div><div class="kpi-value"><?= $totalClients ?></div></div>
    <div class="card kpi-card"><div class="kpi-label">Profiles on file</div><div class="kpi-value"><?= $profiles ?></div></div>
    <div class="card kpi-card"><div class="kpi-label">Active goals</div><div class="kpi-value"><?= $goals ?></div></div>
    <div class="card kpi-card"><div class="kpi-label">Check-ins today</div><div class="kpi-value"><?= $checkins ?></div></div>
</div>

<div class="card">
    <div style="padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--border);">
        <strong>Currently enrolled</strong>
        <span class="text-muted" style="margin-left:var(--space-2);">Wave 1 · profile + goals foundation. Diary + chat land in later waves.</span>
    </div>
    <?php if (!$clients): ?>
        <div class="empty">
            <div class="empty-title">No clients enrolled yet</div>
            <p class="text-sm">Sell a "Body &amp; Soul Program" membership plan to a customer, then they appear here.</p>
        </div>
    <?php else: ?>
        <div class="data-list" data-single-open>
            <?php foreach (array_slice($clients, 0, 10) as $c):
                if (!empty($c['bmi'])) {
                    $profile = 'BMI ' . number_format((float)$c['bmi'], 1);
                } elseif (!empty($c['profile_updated_at'])) {
                    $profile = 'Partial';
                } else {
                    $profile = 'Empty';
                }

                ob_start(); ?>
                <a href="<?= e(plugin_url('coaching', 'admin/client.php')) ?>?id=<?= (int)$c['id'] ?>" class="btn btn-sm btn-secondary">Open</a>
                <?php $rowActions = ob_get_clean();

                slate_data_row([
                    'avatar_html'  => slate_avatar_overlay_html(mb_strtoupper(mb_substr((string)$c['name'], 0, 2)), (string)($c['email'] ?? '')),
                    'avatar_color' => 'accent',
                    'title'        => (string)$c['name'],
                    'meta'         => (string)$c['email'],
                    'value'        => $profile,
                    'detail'       => [
                        'Email'   => (string)$c['email'],
                        'Profile' => $profile,
                    ],
                    'actions'      => $rowActions,
                ]);
            endforeach; ?>
        </div>
        <?php slate_data_list_script(); ?>
        <?php if ($totalClients > 10): ?>
            <div style="padding:var(--space-3) var(--space-4);text-align:center;">
                <a href="<?= e(plugin_url('coaching', 'admin/clients.php')) ?>">See all <?= (int)$totalClients ?> clients →</a>
            </div>
        <?php endif; ?>
    <?php endif; ?>
</div>

<?php require SLATE_ROOT . '/admin/partials/footer.php';
