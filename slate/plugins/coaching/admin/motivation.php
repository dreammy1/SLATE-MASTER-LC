<?php
/**
 * Coaching — Motivation editor for one client.
 *
 * Practitioner-side: send challenges + exercises to a client. See what
 * they've completed. Trigger an end-of-program summary manually.
 *
 * URL: /plugins/coaching/admin/motivation.php?client=<customer_id>
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/CoachingAPI.php';
require_once dirname(__DIR__) . '/includes/assets.php';

Auth::require();
Auth::requirePerm('coaching.manage_clients');
CoachingAPI::ensureSchema();

$cid = (int)($_GET['client'] ?? 0);
$tid = current_tenant_id();
$customer = $cid > 0 ? Database::row("SELECT * FROM customers WHERE id = ? AND tenant_id = ?", [$cid, $tid]) : null;
if (!$customer) {
    header('Location: ' . plugin_url('coaching', 'admin/clients.php'));
    exit;
}

$pageTitle  = 'Coaching · Motivation · ' . $customer['name'];
$currentNav = 'coaching-clients';

$flash = null;
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } else {
        $action = (string)($_POST['_action'] ?? '');
        if ($action === 'save_challenge') {
            CoachingAPI::saveChallenge([
                'id'               => (int)($_POST['id'] ?? 0),
                'customer_id'      => $cid,
                'kind'             => (string)($_POST['kind'] ?? 'challenge'),
                'title'            => (string)($_POST['title'] ?? ''),
                'description_html' => (string)($_POST['description_html'] ?? ''),
                'video_url'        => (string)($_POST['video_url'] ?? ''),
                'starts_at'        => (string)($_POST['starts_at'] ?? date('Y-m-d')),
                'ends_at'          => (string)($_POST['ends_at'] ?? ''),
            ]);
            $flash = ['type' => 'success', 'msg' => 'Saved.'];
        }
        elseif ($action === 'delete_challenge') {
            CoachingAPI::deleteChallenge((int)($_POST['id'] ?? 0));
            $flash = ['type' => 'success', 'msg' => 'Removed.'];
        }
        elseif ($action === 'generate_summary') {
            CoachingAPI::generateSummary($cid);
            $flash = ['type' => 'success', 'msg' => 'Summary generated. The client sees it in their program menu.'];
        }
    }
}

$active    = CoachingAPI::listChallenges($cid, true);
$completed = Database::rows(
    "SELECT * FROM coaching_challenge WHERE tenant_id = ? AND customer_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 30",
    [$tid, $cid]);
$summary   = CoachingAPI::getSummary($cid);

require SLATE_ROOT . '/admin/partials/header.php';

// The plugin's design, emitted by the page rather than relying on a boot-time
// enqueue that never runs while coaching is inactive.
coaching_emit_css('admin.css');

slate_breadcrumbs([
    ['label' => 'Dashboard', 'href' => SLATE_URL . '/admin/'],
    ['label' => 'Coaching',  'href' => plugin_url('coaching', 'admin/index.php')],
    ['label' => 'Program clients', 'href' => plugin_url('coaching', 'admin/clients.php')],
    ['label' => $customer['name'], 'href' => plugin_url('coaching', 'admin/client.php') . '?id=' . (int)$cid],
    ['label' => 'Motivation'],
]);
?>

<div class="page-header">
    <div>
        <h1>Motivation · <?= e($customer['name']) ?></h1>
        <p class="text-muted">Challenges, exercises, and the end-of-program summary.</p>
    </div>
    <a href="<?= e(plugin_url('coaching', 'admin/client.php')) ?>?id=<?= (int)$cid ?>" class="btn btn-ghost">← Client detail</a>
</div>

<?php if ($flash): ?>
    <div class="alert alert-<?= e($flash['type'] === 'success' ? 'success' : 'danger') ?>" style="margin-bottom:var(--space-3);"><?= e($flash['msg']) ?></div>
<?php endif; ?>

<div class="card" style="padding:var(--space-4);margin-bottom:var(--space-3);">
    <h3 style="margin-top:0;">New challenge or exercise</h3>
    <form method="post">
        <?= csrf_field() ?>
        <input type="hidden" name="_action" value="save_challenge">
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:12px;">
            <div class="field"><label class="field-label" for="title">Title</label>
                <input type="text" id="title" name="title" required maxlength="200" placeholder="7-day mindful eating challenge">
            </div>
            <div class="field"><label class="field-label" for="kind">Kind</label>
                <select id="kind" name="kind">
                    <option value="challenge">Challenge</option>
                    <option value="exercise">Exercise</option>
                </select>
            </div>
            <div class="field"><label class="field-label" for="starts_at">Starts</label>
                <input type="date" id="starts_at" name="starts_at" value="<?= e(date('Y-m-d')) ?>">
            </div>
            <div class="field"><label class="field-label" for="ends_at">Ends (optional)</label>
                <input type="date" id="ends_at" name="ends_at">
            </div>
        </div>
        <div class="field">
            <label class="field-label" for="description_html">Description (HTML allowed)</label>
            <textarea id="description_html" name="description_html" rows="4"></textarea>
        </div>
        <div class="field">
            <label class="field-label" for="video_url">Video URL (optional)</label>
            <input type="url" id="video_url" name="video_url" maxlength="500" placeholder="https://youtu.be/…">
        </div>
        <div style="text-align:right;">
            <button class="btn btn-primary">Send to client</button>
        </div>
    </form>
</div>

<?php if ($active): ?>
    <div class="card" style="padding:0;margin-bottom:var(--space-3);">
        <h3 style="margin:0;padding:var(--space-4) var(--space-4) 0;">Active</h3>
        <div class="data-list" data-single-open>
            <?php foreach ($active as $ch):
                $kindLabel = $ch['kind'] === 'exercise' ? 'Exercise' : 'Challenge';
                $when = date('j M', strtotime($ch['starts_at']))
                      . (!empty($ch['ends_at']) ? ' → ' . date('j M', strtotime($ch['ends_at'])) : '');

                ob_start(); ?>
                <form method="post" style="margin:0;" onsubmit="return confirm('Remove?');">
                    <?= csrf_field() ?>
                    <input type="hidden" name="_action" value="delete_challenge">
                    <input type="hidden" name="id" value="<?= (int)$ch['id'] ?>">
                    <button class="btn btn-sm btn-danger">Remove</button>
                </form>
                <?php $rowActions = ob_get_clean();

                slate_data_row([
                    'title'        => (string)$ch['title'],
                    'meta'         => $when,
                    'badge'        => [$kindLabel, $ch['kind'] === 'exercise' ? 'success' : 'info'],
                    'actions'      => $rowActions,
                ]);
            endforeach; ?>
        </div>
        <?php slate_data_list_script(); ?>
    </div>
<?php endif; ?>

<?php if ($completed): ?>
    <div class="card" style="padding:0;margin-bottom:var(--space-3);">
        <h3 style="margin:0;padding:var(--space-4) var(--space-4) 0;">Completed by the client</h3>
        <div class="data-list" data-single-open>
            <?php foreach ($completed as $ch):
                $completedWhen = date('j M · H:i', strtotime($ch['completed_at']));
                $note = trim((string)($ch['client_note'] ?? ''));

                slate_data_row([
                    'title'        => (string)$ch['title'],
                    'meta'         => $completedWhen,
                    'detail'       => $note !== '' ? [['label' => 'Client note', 'html' => '&quot;' . e($note) . '&quot;']] : [],
                ]);
            endforeach; ?>
        </div>
        <?php slate_data_list_script(); ?>
    </div>
<?php endif; ?>

<div class="card" style="padding:var(--space-4);margin-bottom:var(--space-3);">
    <h3 style="margin-top:0;">End-of-program summary</h3>
    <?php if ($summary): ?>
        <p class="text-muted" style="font-size:13px;">
            Last generated <?= e(date('j M Y · H:i', strtotime($summary['generated_at']))) ?>.
            Covers <?= e(date('j M', strtotime($summary['period_start']))) ?> → <?= e(date('j M Y', strtotime($summary['period_end']))) ?>.
        </p>
        <details style="margin-top:8px;">
            <summary style="cursor:pointer;color:var(--coach-brand);">Preview what the client will see</summary>
            <pre style="background:#f8fafc;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.6;margin-top:8px;"><?= e(json_encode(json_decode((string)$summary['summary_json'], true), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre>
        </details>
    <?php else: ?>
        <p class="text-muted" style="font-size:14px;">No summary yet. The cron auto-generates one 3 days before membership expiry; you can also trigger it manually.</p>
    <?php endif; ?>
    <form method="post" style="margin-top:12px;">
        <?= csrf_field() ?>
        <input type="hidden" name="_action" value="generate_summary">
        <button class="btn btn-primary"><?= $summary ? 'Regenerate summary' : 'Generate summary now' ?></button>
    </form>
</div>

<?php require SLATE_ROOT . '/admin/partials/footer.php';
