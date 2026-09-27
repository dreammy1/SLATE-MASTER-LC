<?php
/**
 * SLATE — Activate & Install mini-app (Phase B entry).
 *
 * Deployed by Master bootstrap alongside auth.php BEFORE the full app exists.
 * No DB required. It:
 *   1. discovers the Master URL from .slate_agent_config.json (written by the
 *      agent handshake during setup)
 *   2. verifies the license key with Master
 *   3. streams /api/deploy/full-install and renders 0-100% progress
 *   4. on ANY failure shows the reason + numbered manual recovery steps
 *
 * Version: 1.1.0
 */

$configPath  = __DIR__ . '/.slate_agent_config.json';
$agentConfig = [];
if (file_exists($configPath)) {
    $agentConfig = json_decode((string)@file_get_contents($configPath), true) ?: [];
}

$MASTER_URL = getenv('SLATE_MASTER_URL')
    ?: ($agentConfig['master_host'] ?? '')
    ?: '';
$MASTER_URL = rtrim($MASTER_URL, '/');

/**
 * A Master URL that only works on the CLIENT's machine is worse than no URL.
 *
 * This used to fall back to 'http://localhost:3000'. When pairing had not run,
 * the activation page then told the CLIENT's browser to call localhost — which
 * resolves to the visitor's own computer, where nothing is listening. The
 * customer saw a useless "Failed to fetch" while Master was perfectly healthy.
 *
 * Guessing a loopback address is never correct for a browser talking to a remote
 * service, so it is detected and reported as a configuration problem instead.
 */
$MASTER_IS_LOOPBACK = (bool)preg_match('#^https?://(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$#i', $MASTER_URL);

$scheme   = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http';
$host     = $_SERVER['HTTP_HOST'] ?? 'localhost';
$reqPath  = $_SERVER['REQUEST_URI'] ?? '/activate.php';
$SELF_URL = preg_replace('#/activate\.php.*$#', '', $scheme . '://' . $host . parse_url($reqPath, PHP_URL_PATH));
$SELF_URL = rtrim($SELF_URL, '/');
$APP_DIR  = str_replace('\\', '/', __DIR__);

$installerPresent = file_exists(__DIR__ . '/slate-installer.php');
$alreadyInstalled  = file_exists(__DIR__ . '/.installed');
?>
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activate your Slate site</title>
<style>
body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0a0d14;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
.card{max-width:620px;width:100%;background:#111625;border:1px solid #00f0ff55;border-radius:14px;padding:28px}
h2{margin:0 0 6px}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #1e293b;background:#0a0d14;color:#fff;font-size:15px;letter-spacing:1px}
button{background:#00f0ff;color:#000;font-weight:800;border:0;border-radius:8px;padding:12px 18px;cursor:pointer;width:100%;margin-top:12px}
button:disabled{opacity:.5;cursor:default}
button.ghost{background:transparent;color:#00f0ff;border:1px solid #00f0ff55}
.bar{height:12px;background:#0a0d14;border:1px solid #1e293b;border-radius:99px;overflow:hidden;margin:14px 0}
.bar>div{height:100%;width:0;background:linear-gradient(90deg,#00f0ff,#10b981);transition:width .3s}
.log{background:#03060a;border:1px solid #1e293b;border-radius:8px;padding:10px;font-size:12px;min-height:90px;max-height:220px;overflow:auto;white-space:pre-wrap}
.muted{color:#94a3b8;font-size:12px}
.box{margin-top:14px;padding:14px;border-radius:10px;font-size:13px}
.ok{background:#052e1b;border:1px solid #10b98166}
.err{background:#2a0b12;border:1px solid #f4364b66}
.warn{background:#2a2205;border:1px solid #eab30866}
.box ol{margin:8px 0 0 18px;padding:0}
.box li{margin:4px 0}
code{background:#0a0d14;padding:2px 5px;border-radius:4px;color:#00f0ff}
a{color:#00f0ff}
</style>
</head><body><div class="card">
<h2>Activate your Slate site</h2>
<?php if ($MASTER_IS_LOOPBACK || $MASTER_URL === ''): ?>
<div class="box err" style="text-align:left">
  <b>This site is not linked to your provider's Master dashboard yet</b>
  <p class="muted" style="margin:8px 0 0">
    <?php if ($MASTER_IS_LOOPBACK): ?>
      The address recorded for Master is <code><?= htmlspecialchars($MASTER_URL) ?></code>,
      which only works on the machine that runs the dashboard — your own browser cannot reach it.
    <?php else: ?>
      No Master address has been recorded for this site yet.
    <?php endif; ?>
  </p>
  <p class="muted" style="margin:8px 0 0">
    Nothing is wrong with your site or your files. Ask your provider to set the public Master URL
    (it must be a real domain, e.g. <code>https://master.yourprovider.com</code>) or to re-run
    setup so the link is written. Then reload this page.
  </p>
</div>
<?php else: ?>
<p class="muted">Site: <b><?= htmlspecialchars($SELF_URL) ?></b> &nbsp;·&nbsp; Master: <b><?= htmlspecialchars($MASTER_URL) ?></b></p>
<?php endif; ?>

<?php if (!$installerPresent): ?>
  <div class="box warn">
    <b>The installer file is missing on this server.</b>
    <ol>
      <li>Open cPanel → File Manager and go to <code><?= htmlspecialchars($APP_DIR) ?></code>.</li>
      <li>Confirm <code>slate-installer.php</code> sits next to <code>auth.php</code>. If it is missing, run the setup step again from Master.</li>
      <li>Reload this page afterwards.</li>
    </ol>
  </div>
<?php endif; ?>

<?php if ($alreadyInstalled): ?>
  <div class="box ok">
    <b>This site already looks installed.</b>
    If you still see the install wizard, press the button below to re-run the setup — it is safe and will not duplicate data.
    <p style="margin:10px 0 0"><a href="<?= htmlspecialchars($SELF_URL) ?>/admin/">Go to admin →</a></p>
  </div>
<?php endif; ?>


<p class="muted" style="margin-top:16px">Paste the license key from your email, then press <b>Activate &amp; Install</b>.</p>
<input id="key" placeholder="SLT-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
<button id="go">Activate &amp; Install</button>
<div class="bar"><div id="fill"></div></div>
<div class="log" id="log">Waiting for your license key…</div>
<div id="result"></div>
<script>
const MASTER = <?= json_encode($MASTER_URL) ?>;
const SITE   = <?= json_encode($SELF_URL) ?>;
const KEY_STORE = 'slate_license_key';
const $ = (id) => document.getElementById(id);

function log(msg){ const el = $('log'); el.textContent += "\n" + msg; el.scrollTop = el.scrollHeight; }
function setPct(p){ $('fill').style.width = Math.max(0, Math.min(100, p)) + '%'; }

/** Renders the failure box: reason + the numbered manual steps sent by Master. */
function showFailure(reason, failedStage, percent, guide){
  const steps = (guide && guide.steps && guide.steps.length) ? guide.steps : [
    'Nothing was lost and you were not charged twice.',
    'Press Retry installation — most temporary problems fix themselves on the second try.',
    'If it fails again, copy the red text and send it to support with your site URL.'
  ];
  const help = (guide && guide.helpUrl)
    ? '<p><a href="' + guide.helpUrl + '" target="_blank" rel="noreferrer">Open host documentation →</a></p>' : '';
  $('result').innerHTML =
    '<div class="box err"><b>' + ((guide && guide.title) || 'Setup could not finish') + '</b>' +
    '<p style="margin:6px 0 0">' + (reason || 'Unknown error.') + '</p>' +
    '<p class="muted" style="margin:6px 0 0">Stopped at <b>' + (failedStage || '?') + '</b> — ' + (percent || 0) + '%</p>' +
    '<div style="margin-top:10px"><b>Fix it yourself:</b><ol>' +
      steps.map(function(s){ return '<li>' + s + '</li>'; }).join('') +
    '</ol></div>' + help +
    '<button class="ghost" id="copy">Copy details for support</button></div>';
  const c = $('copy');
  if (c) c.onclick = function(){
    const txt = 'Site: ' + SITE + '\nStage: ' + failedStage + ' (' + percent + '%)\nError: ' + reason;
    if (navigator.clipboard) navigator.clipboard.writeText(txt);
    c.textContent = 'Copied';
  };
}

async function install(key){
  const btn = $('go');
  btn.disabled = true; btn.textContent = 'Installing…';
  $('result').innerHTML = '';
  setPct(2); log('Verifying your license key…');

  let v, vd;
  try {
    v = await fetch(MASTER + '/api/licenses/activate', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key: key, domain: SITE })
    });
    vd = await v.json();
  } catch (e) {
    showFailure('Master could not be reached: ' + e.message, 'ACTIVATE', 0, null);
    btn.disabled = false; btn.textContent = 'Retry installation'; return;
  }
  if (!v.ok || !vd.success) {
    showFailure(vd.error || ('License check failed (HTTP ' + v.status + ')'), 'ACTIVATE', 0, vd.guide);
    btn.disabled = false; btn.textContent = 'Retry installation'; return;
  }
  try { localStorage.setItem(KEY_STORE, key); } catch(_) {}
  log('Key accepted — package: ' + (vd.package && vd.package.slug ? vd.package.slug : 'slate'));
  setPct(6);

  let res;
  try {
    res = await fetch(MASTER + '/api/deploy/full-install', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key: key, domain: SITE })
    });
  } catch (e) {
    showFailure('Lost connection to Master during install: ' + e.message, 'DEPLOY', 6, null);
    btn.disabled = false; btn.textContent = 'Retry installation'; return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastEvent = Date.now();
  let sawDone = false;

  // Watchdog: Master sends a heartbeat every 10s. 45s of silence means the
  // stream died — show an actionable error instead of a frozen bar.
  const watchdog = setInterval(function(){
    const idle = Date.now() - lastEvent;
    if (idle > 45000 && !sawDone) {
      clearInterval(watchdog);
      showFailure('No update from the server for ' + Math.round(idle/1000) + 's — the connection was dropped.',
        'CONNECTION', 0, {
          title: 'The install connection was interrupted',
          reason: 'Your server may still be working, or a proxy cut the request off.',
          steps: [
            'Press Retry installation — the installer resumes where it stopped and never duplicates tables or the admin account.',
            'If it drops at the same step every time, send support your site URL and the step name.'
          ]
        });
      btn.disabled = false; btn.textContent = 'Retry installation';
    }
  }, 5000);

  try {
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    lastEvent = Date.now();
    buf += dec.decode(chunk.value, {stream:true});
    const lines = buf.split("\n");
    buf = lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch(_) { continue; }
      if (typeof e.percent === 'number') setPct(e.percent);
      if (e.error) {
        clearInterval(watchdog);
        showFailure(e.error, e.failedStage || e.stage, e.percent, e.guide);
        btn.disabled = false; btn.textContent = 'Retry installation';
        return;
      }
      if (e.message && !e.heartbeat) log('[' + (e.percent || 0) + '%] ' + e.message);
      if (e.warnings && e.warnings.length) e.warnings.forEach(function(w){ log('note: ' + w); });
      if (e.done) {
        sawDone = true;
        clearInterval(watchdog);
        const plugins = (e.plugins && e.plugins.length) ? e.plugins.join(', ') : 'core only';
        $('result').innerHTML =
          '<div class="box ok"><b>Your Slate site is live</b>' +
          '<p class="muted" style="margin:6px 0">Package plugins installed: <b>' + plugins + '</b></p>' +
          '<p style="margin-top:12px"><a href="' + (e.loginUrl || (SITE + '/admin/')) + '">' +
          '<b>Go to Admin Login →</b></a></p></div>';
        btn.textContent = 'Re-run installation';
        btn.disabled = false;
        log('DONE — your site is ready.');
      }
    }
  }
  } finally { clearInterval(watchdog); }
  btn.disabled = false;
}

$('go').onclick = function(){
  const key = $('key').value.trim();
  if (!key) { alert('Please paste your license key first.'); return; }
  install(key);
};
try { const stored = localStorage.getItem(KEY_STORE); if (stored) $('key').value = stored; } catch(_) {}
</script>
</div></body></html>
