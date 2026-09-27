<?php
/**
 * Coaching — Program clients roster.
 *
 * Full list of enrolled clients. Wave 1: read-only overview with profile
 * KPIs. Per-client detail page + edit lands in a later wave.
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/CoachingAPI.php';
require_once dirname(__DIR__) . '/includes/assets.php';

Auth::require();
Auth::requirePerm('coaching.view_clients');
CoachingAPI::ensureSchema();

$pageTitle  = 'Coaching · Clients';
$currentNav = 'coaching-clients';

$clients = CoachingAPI::listEnrolledClients();

require SLATE_ROOT . '/admin/partials/header.php';

// The plugin's design, emitted by the page rather than relying on a boot-time
// enqueue that never runs while coaching is inactive.
coaching_emit_css('admin.css');

slate_breadcrumbs([
    ['label' => 'Dashboard', 'href' => SLATE_URL . '/admin/'],
    ['label' => 'Coaching',  'href' => plugin_url('coaching', 'admin/index.php')],
    ['label' => 'Program clients'],
]);
?>

<div class="page-header">
    <div>
        <h1>Program clients</h1>
        <p class="text-muted">Everyone currently enrolled in the Body &amp; Soul Program.</p>
    </div>
</div>

<?php if (!$clients): ?>
    <div class="card">
        <div class="empty">
            <div class="empty-title">No enrolled clients</div>
            <p class="text-sm">
                A client is "enrolled" when they hold an active membership matching the program plan.
                Configure the gate in <a href="<?= e(plugin_url('coaching', 'admin/settings.php')) ?>">Coaching settings</a>,
                then sell a plan via the Membership plugin.
            </p>
        </div>
    </div>
<?php else: ?>
    <div class="data-list" data-single-open>
    <?php foreach ($clients as $c):
        $profile = CoachingAPI::getProfile((int)$c['id']);
        $goals   = CoachingAPI::listGoals((int)$c['id'], null, true);
        $detail  = [
            'Email'   => ['label' => 'Email', 'html' => '<a href="mailto:' . e($c['email']) . '">' . e($c['email']) . '</a>'],
            'Height'  => !empty($profile['height_cm']) ? number_format((float)$profile['height_cm'], 1) . ' cm' : '—',
            'Weight'  => !empty($profile['weight_kg']) ? number_format((float)$profile['weight_kg'], 1) . ' kg' : '—',
            'BMI'     => !empty($profile['bmi'])       ? number_format((float)$profile['bmi'], 1)              : '—',
            'BMR'     => !empty($profile['bmr'])       ? (int)$profile['bmr'] . ' kcal/day'                    : '—',
            'TDEE'    => !empty($profile['tdee'])      ? (int)$profile['tdee'] . ' kcal/day'                   : '—',
            'Goals'   => count($goals) . ' active',
            'Profile updated' => !empty($c['profile_updated_at']) ? date('j M Y', strtotime($c['profile_updated_at'])) : '—',
        ];
        $profileFilled = !empty($profile['height_cm']) && !empty($profile['weight_kg']) && !empty($profile['dob']);
        $badge = $profileFilled ? ['Profile filled', 'active'] : ['Profile incomplete', 'inactive'];

        $actions = '<a href="' . e(plugin_url('coaching', 'admin/client.php')) . '?id=' . (int)$c['id'] . '" class="btn btn-sm btn-primary">Open</a>';
        slate_data_row([
            'avatar_html'  => slate_avatar_overlay_html(mb_strtoupper(mb_substr($c['name'], 0, 1)), (string)($c['email'] ?? '')),
            'avatar_color' => $profileFilled ? 'info' : 'muted',
            'title'        => $c['name'],
            'meta'         => e($c['email']),
            'badge'        => $badge,
            'detail'       => $detail,
            'actions'      => $actions,
        ]);
    endforeach; ?>
    </div>
    <?php slate_data_list_script(); ?>
<?php endif; ?>

<?php require SLATE_ROOT . '/admin/partials/footer.php';
