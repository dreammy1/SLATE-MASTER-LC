<?php
/**
 * Coaching — per-client detail (redesigned UI).
 *
 * Single source of truth for one program client. Uses the coaching
 * admin design system (assets/css/admin.css, .coach-* classes).
 *
 * URL: /plugins/coaching/admin/client.php?id=<customer_id>
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/CoachingAPI.php';
require_once dirname(__DIR__) . '/includes/assets.php';

Auth::require();
Auth::requirePerm('coaching.view_clients');
CoachingAPI::ensureSchema();

$cid = (int)($_GET['id'] ?? 0);
$tid = current_tenant_id();
$customer = $cid > 0 ? Database::row("SELECT * FROM customers WHERE id = ? AND tenant_id = ?", [$cid, $tid]) : null;
if (!$customer) {
    header('Location: ' . plugin_url('coaching', 'admin/clients.php'));
    exit;
}

$pageTitle  = 'Coaching · ' . $customer['name'];
$currentNav = 'coaching-clients';

$flash = null;
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } elseif (!Auth::can('coaching.manage_clients') && !Auth::isSuperAdmin()) {
        $flash = ['type' => 'error', 'msg' => 'You need coaching.manage_clients to edit this.'];
    } else {
        $action = (string)($_POST['_action'] ?? '');
        if ($action === 'save_profile') {
            CoachingAPI::saveProfile($cid, [
                'dob'                  => (string)($_POST['dob'] ?? ''),
                'gender'               => (string)($_POST['gender'] ?? ''),
                'height_cm'            => (string)($_POST['height_cm'] ?? ''),
                'weight_kg'            => (string)($_POST['weight_kg'] ?? ''),
                'body_type'            => (string)($_POST['body_type'] ?? ''),
                'activity_factor'      => (float)($_POST['activity_factor'] ?? 1.4),
                'show_computed'        => !empty($_POST['show_computed']),
                'has_meal_structure'   => !empty($_POST['has_meal_structure']),
                'has_shopping_list'    => !empty($_POST['has_shopping_list']),
                'has_recipes'          => !empty($_POST['has_recipes']),
                'pathologies'          => (string)($_POST['pathologies'] ?? ''),
                'ongoing_care'         => (string)($_POST['ongoing_care'] ?? ''),
                'alternative_medicine' => (string)($_POST['alternative_medicine'] ?? ''),
                'personal_issues'      => (string)($_POST['personal_issues'] ?? ''),
            ]);
            $flash = ['type' => 'success', 'msg' => 'Profile saved.'];
        }
        elseif ($action === 'add_goal') {
            CoachingAPI::saveGoal([
                'customer_id' => $cid,
                'scope'       => (string)($_POST['scope'] ?? 'daily'),
                'title'       => (string)($_POST['title'] ?? ''),
                'description' => (string)($_POST['description'] ?? ''),
                'target_count'=> $_POST['target_count'] ?? '',
                'is_active'   => 1,
            ]);
            $flash = ['type' => 'success', 'msg' => 'Goal added.'];
        }
        elseif ($action === 'retire_goal') {
            CoachingAPI::retireGoal((int)($_POST['goal_id'] ?? 0));
            $flash = ['type' => 'success', 'msg' => 'Goal retired.'];
        }
    }
}

// The profile and goals are the core client record. The diary, library,
// challenges and chat were added in later coaching waves. A partially applied
// plugin update must not turn this whole client page into an HTTP 500, so those
// optional panels fail closed to an empty state and leave a diagnostic log.
$optional = static function (string $feature, mixed $fallback, callable $load): mixed {
    try {
        return $load();
    } catch (\Throwable $e) {
        slate_log('Coaching client page: ' . $feature . ' unavailable: ' . $e->getMessage(), 'warning');
        return $fallback;
    }
};

$profile = $optional('profile', [], static fn(): array => CoachingAPI::getProfile($cid) ?? []);
$goals   = $optional('goals', [], static fn(): array => CoachingAPI::listGoals($cid, null, true));
$diaryCount = $optional('diary count', 0, static fn(): int => (int) Database::value(
    "SELECT COUNT(*) FROM coaching_diary_entry WHERE tenant_id = ? AND customer_id = ?", [$tid, $cid]));
$checkinsCount = $optional('check-in count', 0, static fn(): int => (int) Database::value(
    "SELECT COUNT(*) FROM coaching_goal_checkin WHERE tenant_id = ? AND customer_id = ?", [$tid, $cid]));
$mealCount = $optional('meal structure', 0, static fn(): int => count(CoachingAPI::listMealStructure($cid)));
$shopCount = $optional('shopping lists', 0, static fn(): int => count(CoachingAPI::listShoppingLists($cid)));
$recipeCount = $optional('recipes', 0, static fn(): int => count(CoachingAPI::listRecipes($cid)));
$activeChallenges = $optional('challenges', 0, static fn(): int => count(CoachingAPI::listChallenges($cid, true)));
$threadId = $optional('chat thread', 0, static fn(): int => CoachingAPI::ensureThread($cid));
$thread = $threadId > 0
    ? $optional('chat status', null, static fn(): ?array => CoachingAPI::getThread($cid))
    : null;
$unreadFromClient = (int)($thread['unread_practitioner'] ?? 0);

$recentDiary = $optional('recent diary', [], static fn(): array => Database::rows(
    "SELECT id, day, meal_type, emotion, summary FROM coaching_diary_entry
      WHERE tenant_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 3",
    [$tid, $cid]));
$profileFilled = !empty($profile['dob']) && !empty($profile['height_cm']) && !empty($profile['weight_kg']);

require SLATE_ROOT . '/admin/partials/header.php';

// The plugin's design, emitted by the page rather than relying on a boot-time
// enqueue that never runs while coaching is inactive.
coaching_emit_css('admin.css');

slate_breadcrumbs([
    ['label' => 'Dashboard', 'href' => SLATE_URL . '/admin/'],
    ['label' => 'Coaching',  'href' => plugin_url('coaching', 'admin/index.php')],
    ['label' => 'Program clients', 'href' => plugin_url('coaching', 'admin/clients.php')],
    ['label' => $customer['name']],
]);

$initial = mb_strtoupper(mb_substr($customer['name'], 0, 1));
?>

<?php if ($flash): ?>
    <div class="alert alert-<?= e($flash['type'] === 'success' ? 'success' : 'danger') ?>" style="margin-bottom:16px;"><?= e($flash['msg']) ?></div>
<?php endif; ?>

<div class="coach-hero">
    <div class="coach-hero-avatar"><?= e($initial) ?></div>
    <div class="coach-hero-body">
        <h1><?= e($customer['name']) ?></h1>
        <p class="coach-hero-sub">
            <a href="mailto:<?= e($customer['email']) ?>" style="color:inherit;text-decoration:none;"><?= e($customer['email']) ?></a>
        </p>
        <div class="coach-hero-tags">
            <span class="coach-pill <?= $profileFilled ? 'is-on' : 'is-warn' ?>">
                <?= $profileFilled ? 'Profile complete' : 'Profile incomplete' ?>
            </span>
            <?php if ($activeChallenges > 0): ?>
                <span class="coach-pill is-brand"><?= $activeChallenges ?> active challenge<?= $activeChallenges === 1 ? '' : 's' ?></span>
            <?php endif; ?>
            <?php if ($unreadFromClient > 0): ?>
                <span class="coach-pill is-warn"><?= $unreadFromClient ?> unread message<?= $unreadFromClient === 1 ? '' : 's' ?></span>
            <?php endif; ?>
        </div>
    </div>
    <div class="coach-hero-actions">
        <a href="<?= e(plugin_url('coaching', 'admin/chat.php')) ?>?thread=<?= (int)$threadId ?>" class="btn btn-secondary"><?= slate_admin_nav_icon('message') ?> Chat</a>
        <a href="<?= e(plugin_url('coaching', 'admin/motivation.php')) ?>?client=<?= (int)$cid ?>" class="btn btn-primary"><?= slate_admin_nav_icon('sparkles') ?> Motivation</a>
    </div>
</div>

<div class="coach-kpi-grid">
    <div class="coach-kpi coach-kpi--accent">
        <div class="coach-kpi-label">BMI</div>
        <div class="coach-kpi-value"><?= !empty($profile['bmi']) ? number_format((float)$profile['bmi'], 1) : '—' ?></div>
        <div class="coach-kpi-hint"><?= !empty($profile['height_cm']) && !empty($profile['weight_kg']) ? number_format((float)$profile['height_cm'], 0) . 'cm · ' . number_format((float)$profile['weight_kg'], 1) . 'kg' : 'Not set' ?></div>
    </div>
    <div class="coach-kpi">
        <div class="coach-kpi-label">BMR</div>
        <div class="coach-kpi-value"><?= !empty($profile['bmr']) ? (int)$profile['bmr'] : '—' ?><small>kcal/day</small></div>
    </div>
    <div class="coach-kpi">
        <div class="coach-kpi-label">TDEE</div>
        <div class="coach-kpi-value"><?= !empty($profile['tdee']) ? (int)$profile['tdee'] : '—' ?><small>kcal/day</small></div>
    </div>
    <div class="coach-kpi">
        <div class="coach-kpi-label">Diary entries</div>
        <div class="coach-kpi-value"><?= $diaryCount ?></div>
    </div>
    <div class="coach-kpi">
        <div class="coach-kpi-label">Check-ins</div>
        <div class="coach-kpi-value"><?= $checkinsCount ?></div>
    </div>
    <div class="coach-kpi">
        <div class="coach-kpi-label">Goals</div>
        <div class="coach-kpi-value"><?= count($goals) ?></div>
    </div>
</div>

<form method="post" id="profile-form">
    <?= csrf_field() ?>
    <input type="hidden" name="_action" value="save_profile">

    <div class="coach-cols">

        <div class="coach-stack">

            <div class="coach-card">
                <div class="coach-card-header">
                    <div>
                        <span class="coach-eyebrow">Body</span>
                        <h3>Profile</h3>
                    </div>
                </div>
                <div class="coach-card-body">
                    <div class="coach-form-row cols-3">
                        <div class="coach-field">
                            <label for="dob">Date of birth</label>
                            <input type="date" id="dob" name="dob" value="<?= e((string)($profile['dob'] ?? '')) ?>">
                        </div>
                        <div class="coach-field">
                            <label for="gender">Gender</label>
                            <select id="gender" name="gender">
                                <?php foreach (['' => '—', 'female' => 'Female', 'male' => 'Male', 'other' => 'Other', 'undisclosed' => 'Undisclosed'] as $v => $lbl): ?>
                                    <option value="<?= e($v) ?>" <?= (($profile['gender'] ?? '') === $v) ? 'selected' : '' ?>><?= e($lbl) ?></option>
                                <?php endforeach; ?>
                            </select>
                        </div>
                        <div class="coach-field">
                            <label for="activity_factor">Activity factor</label>
                            <input type="number" id="activity_factor" name="activity_factor" step="0.05" min="1.0" max="2.5" value="<?= e(number_format((float)($profile['activity_factor'] ?? 1.4), 2)) ?>">
                        </div>
                    </div>
                    <div class="coach-form-row cols-3">
                        <div class="coach-field">
                            <label for="height_cm">Height (cm)</label>
                            <input type="number" step="0.1" id="height_cm" name="height_cm" value="<?= e((string)($profile['height_cm'] ?? '')) ?>">
                        </div>
                        <div class="coach-field">
                            <label for="weight_kg">Weight (kg)</label>
                            <input type="number" step="0.1" id="weight_kg" name="weight_kg" value="<?= e((string)($profile['weight_kg'] ?? '')) ?>">
                        </div>
                        <div class="coach-field">
                            <label for="body_type">Body type</label>
                            <input type="text" id="body_type" name="body_type" maxlength="80" value="<?= e((string)($profile['body_type'] ?? '')) ?>">
                        </div>
                    </div>

                    <hr class="coach-divider">

                    <details>
                        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--coach-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:12px;">
                            Medical section
                        </summary>
                        <div class="coach-form-row cols-2">
                            <div class="coach-field">
                                <label for="pathologies">Pathologies</label>
                                <textarea id="pathologies" name="pathologies" rows="2"><?= e((string)($profile['pathologies'] ?? '')) ?></textarea>
                            </div>
                            <div class="coach-field">
                                <label for="ongoing_care">Ongoing care</label>
                                <textarea id="ongoing_care" name="ongoing_care" rows="2"><?= e((string)($profile['ongoing_care'] ?? '')) ?></textarea>
                            </div>
                            <div class="coach-field">
                                <label for="alternative_medicine">Alternative medicine</label>
                                <textarea id="alternative_medicine" name="alternative_medicine" rows="2"><?= e((string)($profile['alternative_medicine'] ?? '')) ?></textarea>
                            </div>
                            <div class="coach-field">
                                <label for="personal_issues">Personal issues</label>
                                <textarea id="personal_issues" name="personal_issues" rows="2"><?= e((string)($profile['personal_issues'] ?? '')) ?></textarea>
                            </div>
                        </div>
                    </details>
                </div>
                <div class="coach-card-footer">
                    <button type="submit" class="btn btn-primary">Save profile</button>
                </div>
            </div>

            <div class="coach-card">
                <div class="coach-card-header">
                    <div>
                        <span class="coach-eyebrow">Progress</span>
                        <h3>Goals</h3>
                    </div>
                    <span class="coach-pill is-brand"><?= count($goals) ?> active</span>
                </div>
                <div class="coach-card-body">
                    <?php if (!$goals): ?>
                        <div class="coach-empty" style="padding:20px 12px;">
                            <div class="coach-empty-icon"><?= slate_admin_nav_icon('sparkles') ?></div>
                            <div class="coach-empty-title">No active goals</div>
                            <div class="coach-empty-sub">Add one below and it'll show up in the client's daily check-in flow.</div>
                        </div>
                    <?php else:
                        $grouped = [];
                        foreach ($goals as $g) { $grouped[$g['scope']][] = $g; }
                        foreach (['daily' => 'Daily', 'weekly' => 'Weekly', 'monthly' => 'Monthly', 'general' => 'General', 'personal' => 'Personal'] as $scope => $lbl):
                            if (empty($grouped[$scope])) continue;
                    ?>
                        <div style="margin-bottom:16px;">
                            <span class="coach-eyebrow"><?= e($lbl) ?></span>
                            <?php foreach ($grouped[$scope] as $g): ?>
                                <div class="coach-list-item" style="padding:10px 0;border-bottom:1px solid var(--coach-border);margin:0;">
                                    <div class="coach-list-body">
                                        <div class="coach-list-title"><?= e($g['title']) ?></div>
                                        <?php if (!empty($g['description']) || !empty($g['target_count'])): ?>
                                            <div class="coach-list-sub">
                                                <?php if (!empty($g['target_count'])): ?>Target: <?= (int)$g['target_count'] ?>/day<?php endif; ?>
                                                <?php if (!empty($g['target_count']) && !empty($g['description'])): ?> · <?php endif; ?>
                                                <?= e((string)($g['description'] ?? '')) ?>
                                            </div>
                                        <?php endif; ?>
                                    </div>
                                    <!-- This page already has the profile form open. Use a
                                         detached form for the destructive action instead of
                                         nesting forms, which browsers parse unpredictably. -->
                                    <button form="retire-goal-form" name="goal_id" value="<?= (int)$g['id'] ?>"
                                            onclick="return confirm('Retire this goal?');"
                                            style="border:0;background:none;color:var(--coach-faint);cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Retire</button>
                                </div>
                            <?php endforeach; ?>
                        </div>
                    <?php endforeach; endif; ?>

                    <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--coach-border);">
                        <span class="coach-eyebrow">Add a goal</span>
                        <div style="height:8px;"></div>
                        <div class="coach-form-row cols-3">
                            <div class="coach-field" style="grid-column:span 2;">
                                <label for="goal_title">Title</label>
                                <input type="text" id="goal_title" form="add-goal-form" name="title" required maxlength="200" placeholder="e.g. Drink 2L of water">
                            </div>
                            <div class="coach-field">
                                <label for="goal_scope">Scope</label>
                                <select id="goal_scope" form="add-goal-form" name="scope">
                                    <?php foreach (['daily' => 'Daily', 'weekly' => 'Weekly', 'monthly' => 'Monthly', 'general' => 'General', 'personal' => 'Personal'] as $v => $lbl): ?>
                                        <option value="<?= e($v) ?>"><?= e($lbl) ?></option>
                                    <?php endforeach; ?>
                                </select>
                            </div>
                        </div>
                        <div class="coach-form-row cols-2">
                            <div class="coach-field">
                                <label for="goal_target">Target count</label>
                                <input type="number" id="goal_target" form="add-goal-form" name="target_count" min="0" placeholder="Optional">
                            </div>
                            <div class="coach-field">
                                <label for="goal_desc">Description</label>
                                <input type="text" id="goal_desc" form="add-goal-form" name="description" maxlength="500">
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <button form="add-goal-form" class="btn btn-sm btn-primary">+ Add goal</button>
                        </div>
                    </div>
                </div>
            </div>

            <?php if ($recentDiary): ?>
            <div class="coach-card">
                <div class="coach-card-header">
                    <div>
                        <span class="coach-eyebrow">Timeline</span>
                        <h3>Recent diary entries</h3>
                    </div>
                    <a href="<?= e(plugin_url('coaching', 'admin/feed.php')) ?>?client=<?= (int)$cid ?>" style="font-size:13px;color:var(--coach-brand);text-decoration:none;">View all →</a>
                </div>
                <div class="coach-list">
                    <?php
                    $emojiMap = ['breakfast'=>slate_admin_nav_icon('egg'),'lunch'=>slate_admin_nav_icon('salad'),'dinner'=>slate_admin_nav_icon('plate'),'snack'=>slate_admin_nav_icon('cookie'),'binge'=>slate_admin_nav_icon('stack'),'drink'=>slate_admin_nav_icon('coffee'),'other'=>slate_admin_nav_icon('utensils')];
                    foreach ($recentDiary as $e): ?>
                        <div class="coach-list-item">
                            <div class="coach-list-avatar" style="background:transparent;font-size:22px;">
                                <?= $emojiMap[$e['meal_type']] ?? slate_admin_nav_icon('utensils') ?>
                            </div>
                            <div class="coach-list-body">
                                <div class="coach-list-title">
                                    <span style="text-transform:capitalize;"><?= e($e['meal_type']) ?></span>
                                    <?php if (!empty($e['emotion'])): ?>
                                        <span class="coach-tag is-muted" style="margin-left:6px;"><?= e($e['emotion']) ?></span>
                                    <?php endif; ?>
                                </div>
                                <div class="coach-list-sub"><?= e(date('j M Y', strtotime($e['day']))) ?><?= !empty($e['summary']) ? ' · ' . e($e['summary']) : '' ?></div>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </div>
            </div>
            <?php endif; ?>
        </div>

        <div class="coach-stack">

            <div class="coach-card">
                <div class="coach-card-header">
                    <div>
                        <span class="coach-eyebrow">Modules</span>
                        <h3>What this client sees</h3>
                    </div>
                </div>
                <div class="coach-card-body">
                    <?php
                    $toggles = [
                        ['name' => 'show_computed',      'value' => !empty($profile['show_computed']),      'title' => 'BMI / BMR / TDEE',   'sub' => 'Show computed metrics to the client'],
                        ['name' => 'has_meal_structure', 'value' => !empty($profile['has_meal_structure']), 'title' => 'Meal structure',      'sub' => $mealCount . ' assigned'],
                        ['name' => 'has_shopping_list',  'value' => !empty($profile['has_shopping_list']),  'title' => 'Shopping list',       'sub' => $shopCount . ' assigned'],
                        ['name' => 'has_recipes',        'value' => !empty($profile['has_recipes']),        'title' => 'Recipes',             'sub' => $recipeCount . ' assigned'],
                    ];
                    foreach ($toggles as $t): ?>
                        <label class="coach-toggle <?= $t['value'] ? 'is-on' : '' ?>" style="margin-bottom:8px;">
                            <div class="coach-toggle-info">
                                <div class="coach-toggle-title"><?= e($t['title']) ?></div>
                                <div class="coach-toggle-sub"><?= e($t['sub']) ?></div>
                            </div>
                            <input type="checkbox" form="profile-form" name="<?= e($t['name']) ?>" value="1" <?= $t['value'] ? 'checked' : '' ?>>
                            <span class="coach-switch"></span>
                        </label>
                    <?php endforeach; ?>
                </div>
                <div class="coach-card-footer">
                    <a href="<?= e(plugin_url('coaching', 'admin/library.php')) ?>" class="btn btn-secondary" style="margin-right:auto;"><?= slate_admin_nav_icon('file-text') ?> Library</a>
                    <button form="profile-form" class="btn btn-primary">Save modules</button>
                </div>
            </div>

            <div class="coach-card">
                <div class="coach-card-header">
                    <div>
                        <span class="coach-eyebrow">Shortcuts</span>
                        <h3>Jump to</h3>
                    </div>
                </div>
                <div class="coach-card-body" style="padding:12px;">
                    <a href="<?= e(plugin_url('coaching', 'admin/chat.php')) ?>?thread=<?= (int)$threadId ?>"
                       style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:var(--coach-r-sm);text-decoration:none;color:inherit;transition:background 0.15s;"
                       onmouseover="this.style.background='var(--coach-surface-2)'" onmouseout="this.style.background=''">
                        <div style="width:36px;height:36px;border-radius:50%;background:var(--coach-brand-soft);color:var(--coach-brand);display:flex;align-items:center;justify-content:center;font-size:16px;"><?= slate_admin_nav_icon('message') ?></div>
                        <div style="flex:1;">
                            <div style="font-weight:600;font-size:14px;">Chat thread</div>
                            <div style="font-size:12px;color:var(--coach-muted);"><?= $unreadFromClient > 0 ? $unreadFromClient . ' unread' : 'View conversation' ?></div>
                        </div>
                        <span style="color:var(--coach-faint);">→</span>
                    </a>
                    <a href="<?= e(plugin_url('coaching', 'admin/feed.php')) ?>?client=<?= (int)$cid ?>"
                       style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:var(--coach-r-sm);text-decoration:none;color:inherit;"
                       onmouseover="this.style.background='var(--coach-surface-2)'" onmouseout="this.style.background=''">
                        <div style="width:36px;height:36px;border-radius:50%;background:var(--coach-good-soft);color:var(--coach-good);display:flex;align-items:center;justify-content:center;font-size:16px;"><?= slate_admin_nav_icon('file-text') ?></div>
                        <div style="flex:1;">
                            <div style="font-weight:600;font-size:14px;">Diary feed</div>
                            <div style="font-size:12px;color:var(--coach-muted);"><?= $diaryCount ?> entries total</div>
                        </div>
                        <span style="color:var(--coach-faint);">→</span>
                    </a>
                    <a href="<?= e(plugin_url('coaching', 'admin/motivation.php')) ?>?client=<?= (int)$cid ?>"
                       style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:var(--coach-r-sm);text-decoration:none;color:inherit;"
                       onmouseover="this.style.background='var(--coach-surface-2)'" onmouseout="this.style.background=''">
                        <div style="width:36px;height:36px;border-radius:50%;background:rgba(139,92,246,0.12);color:var(--coach-purple);display:flex;align-items:center;justify-content:center;font-size:16px;"><?= slate_admin_nav_icon('sparkles') ?></div>
                        <div style="flex:1;">
                            <div style="font-weight:600;font-size:14px;">Motivation &amp; summary</div>
                            <div style="font-size:12px;color:var(--coach-muted);"><?= $activeChallenges > 0 ? $activeChallenges . ' active' : 'Send a challenge' ?></div>
                        </div>
                        <span style="color:var(--coach-faint);">→</span>
                    </a>
                    <a href="<?= e(plugin_url('coaching', 'admin/library.php')) ?>"
                       style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:var(--coach-r-sm);text-decoration:none;color:inherit;"
                       onmouseover="this.style.background='var(--coach-surface-2)'" onmouseout="this.style.background=''">
                        <div style="width:36px;height:36px;border-radius:50%;background:rgba(236,72,153,0.12);color:var(--coach-pink);display:flex;align-items:center;justify-content:center;font-size:16px;"><?= slate_admin_nav_icon('file-text') ?></div>
                        <div style="flex:1;">
                            <div style="font-weight:600;font-size:14px;">Library</div>
                            <div style="font-size:12px;color:var(--coach-muted);">Assign templates</div>
                        </div>
                        <span style="color:var(--coach-faint);">→</span>
                    </a>
                </div>
            </div>
        </div>
    </div>
</form>

<form method="post" id="add-goal-form" style="display:none;">
    <?= csrf_field() ?>
    <input type="hidden" name="_action" value="add_goal">
</form>

<form method="post" id="retire-goal-form" style="display:none;">
    <?= csrf_field() ?>
    <input type="hidden" name="_action" value="retire_goal">
</form>

<?php require SLATE_ROOT . '/admin/partials/footer.php';
