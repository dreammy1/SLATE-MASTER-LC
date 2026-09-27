<?php
/**
 * Stripe Payment — admin settings.
 *
 * Smart-paste UX:
 *   1. Click "Open Stripe API Keys ↗" to open the Stripe dashboard in
 *      a new tab. We try to land on the right URL (sandbox vs regular
 *      test) by looking at the prefix of any key the admin has already
 *      saved.
 *   2. Paste both keys into one "paste both keys here" box. JS extracts
 *      the pk_ and sk_ lines and routes them into their respective
 *      fields.
 *   3. JS extracts the account-id prefix from each key and shows a live
 *      validation banner — green when they match, red when they don't.
 *      Save button stays disabled while validation is red.
 *   4. On save, the server immediately hits Stripe's /v1/balance with
 *      the new secret. If it fails, the save is rejected (the old keys
 *      stay in place) and Stripe's error is shown inline. If it
 *      succeeds, we cache the verified account_id + livemode + a
 *      timestamp so the status card can display them.
 */

$root = realpath(__DIR__ . '/../../..');
require $root . '/config.php';

Auth::require();
Auth::requirePerm('stripe.manage_settings');

require_once dirname(__DIR__) . '/StripeAPI.php';

$pageTitle  = 'Stripe Payment Settings';
$currentNav = 'shop-stripe';

$flash = null;

/**
 * Verify a secret key with Stripe by hitting /v1/balance. Returns one of:
 *   ['ok' => true,  'mode' => 'test'|'live', 'account_id' => '...']
 *   ['ok' => false, 'error' => 'human message']
 */
function stripe_verify_secret(string $secret): array {
    if ($secret === '') {
        return ['ok' => false, 'error' => 'Secret key is empty.'];
    }
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'error' => 'PHP cURL extension is not available.'];
    }
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => 'https://api.stripe.com/v1/balance',
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $secret],
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        return ['ok' => false, 'error' => 'Could not reach Stripe: ' . $err];
    }
    $data = json_decode((string)$body, true);
    if ($code === 200 && is_array($data) && isset($data['livemode'])) {
        // Stripe doesn't directly return our account_id from /v1/balance,
        // so derive it from the key. First ~14 body chars are the
        // account marker (e.g. "51TCoPYBqTcGep").
        // /v1/account would give a canonical id but costs an extra
        // round-trip and requires the 'read account' permission.
        $marker = stripe_key_account_marker($secret);
        return [
            'ok'         => true,
            'mode'       => $data['livemode'] ? 'live' : 'test',
            'account_id' => $marker,
        ];
    }
    $msg = $data['error']['message'] ?? "HTTP $code";
    return ['ok' => false, 'error' => 'Stripe rejected the key: ' . $msg];
}

/**
 * Extract the account-marker portion of a Stripe key — the chars between
 * the mode prefix and the random suffix. This is what we use to do quick
 * client-side matching of pk_/sk_ pairs. Returns empty string if the
 * key doesn't look like a real Stripe key.
 *
 * Examples:
 *   "pk_test_51TCoPYBqTcGepwu2..."  → "51TCoPYBqTcGep"
 *   "sk_live_51TCoPYBqTcGepwu2..."  → "51TCoPYBqTcGep"
 *   "garbage"                       → ""
 */
function stripe_key_account_marker(string $key): string {
    if (!preg_match('/^(?:pk|sk|rk)_(?:test|live)_([A-Za-z0-9]{1,32})/', $key, $m)) {
        return '';
    }
    return substr($m[1], 0, 14);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } elseif (($_POST['_action'] ?? '') === 'test_connection') {
        // Manual "Run test" button — preserved for backward compat /
        // re-test of the saved key without changing it.
        $result = stripe_verify_secret(StripeAPI::secretKey());
        if ($result['ok']) {
            $upper = strtoupper($result['mode']);
            $flash = ['type' => 'success',
                'msg' => "Connection successful. Stripe is responding in $upper mode (account: {$result['account_id']})."];
            // Refresh the cache
            Database::setSetting('stripe-payment.verified_at', slate_db_now());
            Database::setSetting('stripe-payment.verified_account', $result['account_id']);
            Database::setSetting('stripe-payment.verified_mode', $result['mode']);
        } else {
            $flash = ['type' => 'error', 'msg' => $result['error']];
        }
    } elseif (($_POST['_action'] ?? '') === 'clear_keys') {
        // Explicit "disconnect" — wipe stored creds so Stripe stops
        // showing up as an available payment method until reconfigured.
        foreach (['mode', 'publishable_key', 'secret_key', 'webhook_secret',
                  'verified_at', 'verified_account', 'verified_mode'] as $k) {
            Database::setSetting('stripe-payment.' . $k, '');
        }
        $flash = ['type' => 'success', 'msg' => 'Stripe keys cleared.'];
    } else {
        // Standard save. We do a few things in order:
        //   1. Validate the pk/sk look like Stripe keys at all
        //   2. Compare their account markers; refuse if mismatched
        //   3. Verify the secret with Stripe (hit /v1/balance)
        //   4. Only then write the new keys to the settings table

        $newPub      = trim((string)($_POST['publishable_key'] ?? ''));
        $newSecret   = trim((string)($_POST['secret_key']      ?? ''));
        $newWebhook  = trim((string)($_POST['webhook_secret']  ?? ''));
        $newCountries = trim((string)($_POST['allowed_countries'] ?? 'US,CA,GB,AU,BD'));
        $newMode     = in_array(($_POST['mode'] ?? 'test'), ['test', 'live'], true)
                           ? $_POST['mode'] : 'test';
        $showHosted   = isset($_POST['show_hosted'])   ? '1' : '0';
        $showEmbedded = isset($_POST['show_embedded']) ? '1' : '0';

        // Booking-widget inline payment + wallet toggles. These drive the
        // embedded Payment Element inside the /book widget.
        $bookingEmbedded = isset($_POST['booking_embedded']) ? '1' : '0';
        $walletApplePay  = isset($_POST['wallet_apple_pay'])  ? '1' : '0';
        $walletGooglePay = isset($_POST['wallet_google_pay']) ? '1' : '0';
        $walletLink      = isset($_POST['wallet_link'])       ? '1' : '0';
        // Extra (non-card) payment methods for the inline form. Default off —
        // each must also be activated on your Stripe dashboard to work.
        $methodBank      = isset($_POST['method_us_bank_account']) ? '1' : '0';
        $methodKlarna    = isset($_POST['method_klarna'])          ? '1' : '0';
        $methodCashapp   = isset($_POST['method_cashapp'])         ? '1' : '0';
        $methodAmazonPay = isset($_POST['method_amazon_pay'])      ? '1' : '0';
        // Bancontact is a Stripe payment method, not a separate gateway.
        // It is only offered for eligible EUR payments; Stripe performs the
        // final customer/account eligibility check at checkout.
        $methodBancontact = isset($_POST['method_bancontact'])      ? '1' : '0';

        // If both pk + sk are present, run validation. (If only webhook
        // was changed, allow that without re-verifying the API key.)
        $keysChanged = $newPub !== StripeAPI::publishableKey()
                    || $newSecret !== StripeAPI::secretKey();

        $verifyError = null;
        $verifyOk    = null;

        if ($keysChanged && ($newPub !== '' || $newSecret !== '')) {
            // Format checks
            if (!preg_match('/^pk_(test|live)_/', $newPub)) {
                $verifyError = 'Publishable key must start with pk_test_ or pk_live_.';
            } elseif (!preg_match('/^sk_(test|live)_/', $newSecret)) {
                $verifyError = 'Secret key must start with sk_test_ or sk_live_.';
            } else {
                // Mode-prefix match
                preg_match('/^pk_(test|live)_/', $newPub, $pm);
                preg_match('/^sk_(test|live)_/', $newSecret, $sm);
                if ($pm[1] !== $sm[1]) {
                    $verifyError = 'Mode mismatch: publishable is ' . $pm[1]
                        . ' mode, secret is ' . $sm[1] . ' mode. They must match.';
                } elseif ($pm[1] !== $newMode) {
                    $verifyError = 'The Mode dropdown is "' . $newMode . '" but you pasted '
                        . $pm[1] . '-mode keys. Pick the mode that matches your keys.';
                } else {
                    // Account-marker match
                    $pMark = stripe_key_account_marker($newPub);
                    $sMark = stripe_key_account_marker($newSecret);
                    if ($pMark !== '' && $sMark !== '' && $pMark !== $sMark) {
                        $verifyError = 'Account mismatch: publishable belongs to '
                            . $pMark . ', secret belongs to ' . $sMark
                            . '. Get both keys from the same Stripe dashboard.';
                    } else {
                        // Server-side verification with Stripe itself.
                        $verifyOk = stripe_verify_secret($newSecret);
                        if (!$verifyOk['ok']) {
                            $verifyError = $verifyOk['error'];
                            $verifyOk = null;
                        }
                    }
                }
            }
        }

        if ($verifyError !== null) {
            $flash = ['type' => 'error', 'msg' => $verifyError];
        } else {
            // Encrypt secret material at rest (AES-256-GCM envelope).
            // Falls back to plaintext only if APP_SECRET isn't configured,
            // so a misconfigured install still works rather than fataling.
            $encSecret = static function (string $v): string {
                if ($v === '' || !function_exists('slate_encrypt_secret')) return $v;
                try { return slate_encrypt_secret($v); }
                catch (\Throwable $e) { return $v; }
            };
            $secretEnc  = $encSecret($newSecret);
            $webhookEnc = $encSecret($newWebhook);

            // Save. We always write all fields, so unchecked toggles
            // become '0' (not removed entirely). The publishable key is
            // public and stored as-is; secret + webhook keys are encrypted.
            $fields = [
                'stripe-payment.mode'              => $newMode,
                'stripe-payment.publishable_key'   => $newPub,
                'stripe-payment.secret_key'        => $secretEnc,
                'stripe-payment.webhook_secret'    => $webhookEnc,
                'stripe-payment.allowed_countries' => $newCountries,
                'stripe-payment.show_hosted'       => $showHosted,
                'stripe-payment.show_embedded'    => $showEmbedded,
                'stripe-payment.booking_embedded'  => $bookingEmbedded,
                'stripe-payment.wallet_apple_pay'  => $walletApplePay,
                'stripe-payment.wallet_google_pay' => $walletGooglePay,
                'stripe-payment.wallet_link'       => $walletLink,
                'stripe-payment.method_us_bank_account' => $methodBank,
                'stripe-payment.method_klarna'          => $methodKlarna,
                'stripe-payment.method_cashapp'         => $methodCashapp,
                'stripe-payment.method_amazon_pay'      => $methodAmazonPay,
                'stripe-payment.method_bancontact'      => $methodBancontact,
            ];
            foreach ($fields as $k => $v) {
                Database::setSetting($k, (string)$v);
            }

            // Phase 2: also save the keys into mode-prefixed slots so
            // flipping the mode toggle later preserves both sets.
            // StripePaymentAPI::keyByMode reads test_*/live_* first and
            // falls back to the legacy single-key slot, so this is
            // strictly additive.
            Database::setSetting('stripe-payment.' . $newMode . '_publishable_key', $newPub);
            Database::setSetting('stripe-payment.' . $newMode . '_secret_key',      $secretEnc);
            Database::setSetting('stripe-payment.' . $newMode . '_webhook_secret',  $webhookEnc);

            // Cache verification info so the status card has fresh info
            // without re-hitting Stripe on every page load.
            if ($verifyOk !== null) {
                Database::setSetting('stripe-payment.verified_at',
                    slate_db_now());
                Database::setSetting('stripe-payment.verified_account',
                    $verifyOk['account_id']);
                Database::setSetting('stripe-payment.verified_mode',
                    $verifyOk['mode']);
            }

            if (class_exists('AuditLog')) {
                AuditLog::record('stripe.settings_changed');
            }

            $msg = 'Settings saved.';
            if ($verifyOk !== null) {
                $msg .= ' Verified ' . strtoupper($verifyOk['mode'])
                     . ' account ' . $verifyOk['account_id'] . '.';
            }
            $flash = ['type' => 'success', 'msg' => $msg];
        }
    }
}

$mode             = StripeAPI::mode();
$publishableKey   = StripeAPI::publishableKey();
$secretKey        = StripeAPI::secretKey();
$webhookSecret    = StripeAPI::webhookSecret();
$allowedCountries = Database::setting('stripe-payment.allowed_countries') ?: 'US,CA,GB,AU,BD';
$showHosted   = (Database::setting('stripe-payment.show_hosted')   ?? '1') !== '0';
$showEmbedded = (Database::setting('stripe-payment.show_embedded') ?? '1') !== '0';

// Booking-widget inline payment defaults (all on unless explicitly disabled).
$bookingEmbedded = (Database::setting('stripe-payment.booking_embedded')  ?? '1') !== '0';
$walletApplePay  = (Database::setting('stripe-payment.wallet_apple_pay')  ?? '1') !== '0';
$walletGooglePay = (Database::setting('stripe-payment.wallet_google_pay') ?? '1') !== '0';
$walletLink      = (Database::setting('stripe-payment.wallet_link')       ?? '1') !== '0';
// Extra non-card methods default OFF (must be activated on Stripe too).
$methodBank      = Database::setting('stripe-payment.method_us_bank_account') === '1';
$methodKlarna    = Database::setting('stripe-payment.method_klarna')          === '1';
$methodCashapp   = Database::setting('stripe-payment.method_cashapp')         === '1';
$methodAmazonPay = Database::setting('stripe-payment.method_amazon_pay')       === '1';
$methodBancontact = Database::setting('stripe-payment.method_bancontact')      === '1';

$verifiedAt      = (string)(Database::setting('stripe-payment.verified_at')      ?? '');
$verifiedAccount = (string)(Database::setting('stripe-payment.verified_account') ?? '');
$verifiedMode    = (string)(Database::setting('stripe-payment.verified_mode')    ?? '');

// Decide which Stripe dashboard URL to link to. If we have keys saved
// already and they look like sandbox keys, use the sandbox-aware URL.
// Otherwise default to the regular test-mode keys page.
$dashboardUrl = 'https://dashboard.stripe.com/test/apikeys';
if ($publishableKey !== '' && stripe_key_account_marker($publishableKey) !== '') {
    // Account-specific URL works for both regular accounts and most
    // sandboxes; the dashboard handles redirect to the right namespace.
    $dashboardUrl = 'https://dashboard.stripe.com/apikeys';
}

$webhookUrl = SLATE_URL . '/plugins/stripe-payment/public/webhook.php';

require $root . '/admin/partials/header.php';
?>

<div class="page-header">
    <div>
        <h1>Stripe Payment</h1>
        <p class="page-header-sub">
            Connect your Stripe account to accept card payments at checkout.
        </p>
    </div>
</div>

<?php if ($flash): ?>
    <div class="alert alert-<?= e($flash['type']) ?>" role="status"><?= e($flash['msg']) ?></div>
<?php endif; ?>

<!-- ────────── Connection status card (always at top) ────────── -->
<div class="card" style="margin-bottom: 1rem;">
    <?php if ($verifiedAt !== '' && $verifiedAccount !== ''): ?>
        <div class="flex" style="gap: 14px; align-items: center; flex-wrap: wrap;">
            <span class="badge badge-success" style="font-size: 11.5px;">✓ Connected</span>
            <div>
                <div style="font-weight: 600;">Account: <code><?= e($verifiedAccount) ?></code></div>
                <div class="text-muted text-sm">
                    <?= strtoupper(e($verifiedMode)) ?> mode
                    · last verified <?= e($verifiedAt) ?>
                </div>
            </div>
            <div style="flex: 1;"></div>
            <form method="post" style="margin: 0;"
                  onsubmit="return confirm('Re-test the connection with the saved secret key?');">
                <?= csrf_field() ?>
                <input type="hidden" name="_action" value="test_connection">
                <button type="submit" class="btn btn-sm">Re-test</button>
            </form>
            <form method="post" style="margin: 0;"
                  onsubmit="return confirm('Clear ALL Stripe keys? Customers will no longer see Stripe as a payment option until you reconnect.');">
                <?= csrf_field() ?>
                <input type="hidden" name="_action" value="clear_keys">
                <button type="submit" class="btn btn-sm btn-ghost">Disconnect</button>
            </form>
        </div>
    <?php else: ?>
        <div class="flex" style="gap: 14px; align-items: center; flex-wrap: wrap;">
            <span class="badge badge-warning" style="font-size: 11.5px;">Not connected</span>
            <div class="text-muted text-sm">
                Paste your Stripe keys below to enable card payments.
            </div>
        </div>
    <?php endif; ?>
</div>

<div class="split-layout">
    <div>
        <!-- ────────── Step 1: Open Stripe dashboard ────────── -->
        <div class="card">
            <div class="card-header"><h2>1 · Get your keys from Stripe</h2></div>
            <p class="text-muted text-sm" style="margin: 0 0 0.75rem;">
                Open your Stripe dashboard in a new tab, then come back here
                and paste below. Stay in the same dashboard tab for the
                whole process — switching between sandboxes or accounts
                between copying the two keys is the #1 cause of
                "key mismatch" errors.
            </p>
            <a href="<?= e($dashboardUrl) ?>" target="_blank" rel="noopener"
               class="btn btn-primary">
                Open Stripe API Keys ↗
            </a>
        </div>

        <!-- ────────── Step 2: Paste keys ────────── -->
        <div class="card" style="margin-top: 1rem;">
            <div class="card-header"><h2>2 · Paste both keys</h2></div>
            <form method="post" id="stripe-settings-form">
                <?= csrf_field() ?>
                <input type="hidden" name="_action" value="save">

                <div class="field">
                    <label class="field-label" for="paste-blob">
                        Quick paste (optional shortcut)
                    </label>
                    <textarea id="paste-blob" rows="3"
                              placeholder="Paste BOTH keys here (publishable and secret, in any order). We'll detect each and fill in the fields below."
                              style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;"></textarea>
                    <div class="field-hint">
                        You can also fill the two fields below manually if you prefer.
                    </div>
                </div>

                <div id="key-validation-banner" hidden></div>

                <div class="field">
                    <label class="field-label" for="publishable_key">
                        Publishable key <span class="field-required">*</span>
                        <span id="pub-marker" class="key-marker" hidden></span>
                    </label>
                    <input type="text" id="publishable_key" name="publishable_key"
                           value="<?= e($publishableKey) ?>"
                           placeholder="pk_test_… or pk_live_…"
                           autocomplete="off"
                           spellcheck="false"
                           style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;">
                </div>

                <div class="field">
                    <label class="field-label" for="secret_key">
                        Secret key <span class="field-required">*</span>
                        <span id="sec-marker" class="key-marker" hidden></span>
                    </label>
                    <input type="password" id="secret_key" name="secret_key"
                           value="<?= e($secretKey) ?>"
                           placeholder="sk_test_… or sk_live_…"
                           autocomplete="off"
                           spellcheck="false"
                           style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;">
                    <div class="field-hint">
                        <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
                            <input type="checkbox" id="show-secret">
                            Show secret key
                        </label>
                    </div>
                </div>

                <div class="field" hidden>
                    <!-- Mode is determined by the key prefix; the hidden
                         field is kept so existing logic that reads it
                         still works. -->
                    <input type="radio" name="mode" value="test" <?= $mode === 'test' ? 'checked' : '' ?>>
                    <input type="radio" name="mode" value="live" <?= $mode === 'live' ? 'checked' : '' ?>>
                </div>

                <!-- ────────── Step 3: Webhook secret ────────── -->
                <div style="border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 1rem;">
                    <div class="field">
                        <label class="field-label" for="webhook_secret">
                            Webhook signing secret
                        </label>
                        <input type="password" id="webhook_secret" name="webhook_secret"
                               value="<?= e($webhookSecret) ?>"
                               placeholder="whsec_…"
                               autocomplete="off"
                               spellcheck="false"
                               style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;">
                        <div class="field-hint">
                            From your Stripe dashboard → Developers → Webhooks
                            → your endpoint → Signing secret.
                            <a href="#webhook-setup">Setup instructions ↓</a>
                        </div>
                    </div>
                </div>

                <!-- ────────── Step 4: Provider toggles ────────── -->
                <div style="border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 1rem;">
                    <label class="field-label">Payment options to show customers</label>
                    <div class="field">
                        <label class="switch-label" style="align-items: flex-start;">
                            <span class="switch" style="margin-top: 1px;">
                                <input type="checkbox" name="show_embedded" value="1" <?= $showEmbedded ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span>
                                <strong>Embedded card form</strong> (recommended)
                                <div class="text-muted text-sm">
                                    Card / Apple Pay / Google Pay / Link inline on
                                    the checkout page. Customer never leaves.
                                </div>
                            </span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="switch-label" style="align-items: flex-start;">
                            <span class="switch" style="margin-top: 1px;">
                                <input type="checkbox" name="show_hosted" value="1" <?= $showHosted ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span>
                                <strong>Hosted Stripe Checkout</strong>
                                <div class="text-muted text-sm">
                                    Redirect to stripe.com to pay. Simpler PCI
                                    scope; you give up some checkout-page control.
                                </div>
                            </span>
                        </label>
                    </div>
                </div>

                <!-- ────────── Booking widget inline payment ────────── -->
                <div style="border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 1rem;">
                    <label class="field-label">Booking widget</label>
                    <div class="field">
                        <label class="switch-label" style="align-items: flex-start;">
                            <span class="switch" style="margin-top: 1px;">
                                <input type="checkbox" name="booking_embedded" value="1" <?= $bookingEmbedded ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span>
                                <strong>Inline embedded card payment</strong> (recommended)
                                <div class="text-muted text-sm">
                                    Collect deposits/payments on the booking summary
                                    step inside the <code>/book</code> widget — the
                                    customer never leaves for stripe.com. When off,
                                    paid bookings fall back to hosted Stripe Checkout.
                                </div>
                            </span>
                        </label>
                    </div>
                    <label class="field-label" style="margin-top: 0.5rem;">Wallets &amp; express checkout</label>
                    <div class="text-muted text-sm" style="margin-bottom: 0.5rem;">
                        Shown in the inline form when the customer's device/browser
                        supports them.
                    </div>
                    <div class="field">
                        <label class="switch-label">
                            <span class="switch">
                                <input type="checkbox" name="wallet_apple_pay" value="1" <?= $walletApplePay ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span><strong>Apple Pay</strong></span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="switch-label">
                            <span class="switch">
                                <input type="checkbox" name="wallet_google_pay" value="1" <?= $walletGooglePay ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span><strong>Google Pay</strong></span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="switch-label" style="align-items: flex-start;">
                            <span class="switch" style="margin-top: 1px;">
                                <input type="checkbox" name="wallet_link" value="1" <?= $walletLink ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span>
                                <strong>Link</strong>
                                <div class="text-muted text-sm">
                                    Stripe's one-click checkout. When off, the inline
                                    form offers card + wallets only.
                                </div>
                            </span>
                        </label>
                    </div>

                    <label class="field-label" style="margin-top: 0.5rem;">Additional payment methods</label>
                    <div class="text-muted text-sm" style="margin-bottom: 0.5rem;">
                        Off by default. Each must also be <strong>activated in your
                        Stripe dashboard</strong> (Settings → Payment methods) and may
                        only apply to certain currencies/countries. If a method isn't
                        active on your account, the inline form safely falls back to
                        card.
                    </div>
                    <div class="field">
                        <label class="switch-label">
                            <span class="switch">
                                <input type="checkbox" name="method_us_bank_account" value="1" <?= $methodBank ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span><strong>Bank</strong> (ACH direct debit)</span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="switch-label">
                            <span class="switch">
                                <input type="checkbox" name="method_klarna" value="1" <?= $methodKlarna ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span><strong>Klarna</strong> (buy now, pay later)</span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="switch-label">
                            <span class="switch">
                                <input type="checkbox" name="method_cashapp" value="1" <?= $methodCashapp ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span><strong>Cash App Pay</strong></span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="switch-label">
                            <span class="switch">
                                <input type="checkbox" name="method_amazon_pay" value="1" <?= $methodAmazonPay ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span><strong>Amazon Pay</strong></span>
                        </label>
                    </div>
                    <div class="field">
                        <label class="switch-label" style="align-items:flex-start;">
                            <span class="switch" style="margin-top:1px;">
                                <input type="checkbox" name="method_bancontact" value="1" <?= $methodBancontact ? 'checked' : '' ?>>
                                <span class="switch-track"></span>
                            </span>
                            <span>
                                <strong>Bancontact</strong> (Belgium)
                                <div class="text-muted text-sm">
                                    Available for eligible EUR payments. Activate Bancontact in
                                    Stripe Dashboard → Settings → Payment methods as well.
                                </div>
                            </span>
                        </label>
                    </div>
                </div>

                <div class="field">
                    <label class="field-label" for="allowed_countries">
                        Allowed shipping countries
                    </label>
                    <input type="text" id="allowed_countries" name="allowed_countries"
                           value="<?= e($allowedCountries) ?>"
                           placeholder="US,CA,GB,AU,BD">
                    <div class="field-hint">
                        Comma-separated 2-letter ISO codes. Only applies to
                        the hosted-checkout flow.
                    </div>
                </div>

                <button type="submit" class="btn btn-primary" id="save-btn">
                    Save and verify
                </button>
            </form>
        </div>
    </div>

    <div>
        <!-- ────────── Webhook health ──────────
             A rejected webhook is silent: Stripe sees a 400 and retries into
             the void while the site looks fine. Surface the last delivery so a
             missing secret or a missing endpoint is visible here rather than
             discovered when a payment doesn't land. -->
        <?php
        $wh = StripePaymentAPI::webhookHealth();
        $ago = static function (string $ts): string {
            if ($ts === '') { return ''; }
            $d = time() - strtotime($ts);
            if ($d < 60)    { return 'just now'; }
            if ($d < 3600)  { return floor($d / 60) . ' min ago'; }
            if ($d < 86400) { return floor($d / 3600) . ' hr ago'; }
            return floor($d / 86400) . ' days ago';
        };
        $tone = ['ok' => 'active', 'rejecting' => 'danger', 'never' => 'warning', 'no_secret' => 'danger'][$wh['state']] ?? 'warning';
        $head = [
            'ok'        => 'Receiving events',
            'rejecting' => 'Deliveries are being rejected',
            'never'     => 'No event has ever arrived',
            'no_secret' => 'No signing secret set',
        ][$wh['state']];
        $why = [
            'ok'        => 'Stripe is reaching this site and the signature checks out.',
            'rejecting' => 'Stripe is reaching this site, but the signature does not match — the signing secret here is probably from a different endpoint or account.',
            'never'     => 'Either no endpoint is registered in Stripe for this URL, or Stripe cannot reach it. Payments still confirm on return from checkout, but a customer who closes the tab will not be reconciled.',
            'no_secret' => 'Every delivery is rejected without one. Add the endpoint in Stripe, then paste its whsec_… secret on the left.',
        ][$wh['state']];
        ?>
        <div class="card" style="margin-bottom:1rem;">
            <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <h2>Webhook health</h2>
                <span class="badge badge-<?= e($tone) ?>"><?= e($head) ?></span>
            </div>
            <p class="text-muted text-sm" style="margin:0 0 0.75rem;"><?= e($why) ?></p>
            <ul class="kv-list">
                <li class="kv-row">
                    <span class="kv-label">Signing secret</span>
                    <span class="kv-value"><?= $wh['secret'] ? 'Set' : '— not set —' ?></span>
                </li>
                <li class="kv-row">
                    <span class="kv-label">Last accepted</span>
                    <span class="kv-value">
                        <?php if ($wh['ok_at'] !== ''): ?>
                            <?= e($ago($wh['ok_at'])) ?>
                            <?php if ($wh['ok_type'] !== ''): ?><br><span class="text-xs text-muted"><?= e($wh['ok_type']) ?></span><?php endif; ?>
                        <?php else: ?>—<?php endif; ?>
                    </span>
                </li>
                <li class="kv-row">
                    <span class="kv-label">Last rejected</span>
                    <span class="kv-value">
                        <?php if ($wh['fail_at'] !== ''): ?>
                            <?= e($ago($wh['fail_at'])) ?>
                            <?php if ($wh['fail_reason'] !== ''): ?><br><span class="text-xs text-muted"><?= e(str_replace('_', ' ', $wh['fail_reason'])) ?></span><?php endif; ?>
                        <?php else: ?>—<?php endif; ?>
                    </span>
                </li>
                <li class="kv-row">
                    <span class="kv-label">Accepted / rejected</span>
                    <span class="kv-value"><?= (int) $wh['ok_count'] ?> / <?= (int) $wh['fail_count'] ?></span>
                </li>
            </ul>
        </div>

        <!-- ────────── Webhook setup card ────────── -->
        <div class="card" id="webhook-setup">
            <div class="card-header"><h2>Webhook endpoint</h2></div>
            <p class="text-muted text-sm">
                In your Stripe dashboard → Developers → Webhooks, add this
                URL, subscribed to events <code>checkout.session.completed</code>
                and <code>payment_intent.succeeded</code>:
            </p>
            <code style="display:block; padding:10px; background:var(--surface-sunken);
                         border-radius:6px; word-break:break-all; font-size:12px;">
                <?= e($webhookUrl) ?>
            </code>
            <p class="text-muted text-sm" style="margin-top: 0.75rem;">
                After saving the webhook in Stripe, copy the signing secret
                (<code>whsec_…</code>) it gives you back into the "Webhook
                signing secret" field on the left.
            </p>
        </div>

        <!-- ────────── Test cards ────────── -->
        <div class="card" style="margin-top: 1rem;">
            <div class="card-header"><h2>Test cards</h2></div>
            <p class="text-muted text-sm" style="margin:0 0 0.5rem;">In test mode:</p>
            <ul style="margin:0; padding-left:1.2rem; font-size:13px; line-height:1.7;">
                <li><code>4242 4242 4242 4242</code> — succeeds</li>
                <li><code>4000 0000 0000 9995</code> — insufficient funds</li>
                <li><code>4000 0027 6000 3184</code> — 3D Secure required</li>
            </ul>
            <p class="text-muted text-sm" style="margin-top:0.5rem;">
                Any future expiry, any CVC, any postal code.
            </p>
        </div>

        <!-- ────────── Status indicators ────────── -->
        <div class="card" style="margin-top: 1rem;">
            <div class="card-header"><h2>Components</h2></div>
            <dl style="margin:0;">
                <dt class="text-muted text-sm">API keys</dt>
                <dd style="margin:0 0 0.5rem;">
                    <?php if (StripeAPI::isConfigured()): ?>
                        <span class="badge badge-success">Set</span>
                    <?php else: ?>
                        <span class="badge badge-warning">Missing</span>
                    <?php endif; ?>
                </dd>
                <dt class="text-muted text-sm">Webhook secret</dt>
                <dd style="margin:0 0 0.5rem;">
                    <?php if ($webhookSecret !== ''): ?>
                        <span class="badge badge-success">Set</span>
                    <?php else: ?>
                        <span class="badge badge-muted">Not set</span>
                    <?php endif; ?>
                </dd>
                <dt class="text-muted text-sm">Shop plugin</dt>
                <dd style="margin:0;">
                    <?php if (PluginLoader::isActive('shop')): ?>
                        <span class="badge badge-success">Active</span>
                    <?php else: ?>
                        <span class="badge badge-danger">Inactive — Stripe won't show on checkout</span>
                    <?php endif; ?>
                </dd>
            </dl>
        </div>
    </div>
</div>

<style>
.key-marker {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 7px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
    border-radius: 4px;
    background: var(--surface-sunken, #f1f3f6);
    color: var(--text-2, #5a6b7e);
    vertical-align: middle;
}
.key-marker.is-good {
    background: rgba(56, 142, 60, 0.1);
    color: #2e7d32;
}
.key-marker.is-bad {
    background: rgba(220, 38, 38, 0.1);
    color: #b91c1c;
}
#key-validation-banner {
    margin: 0 0 1rem;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.5;
}
#key-validation-banner.is-good {
    background: rgba(56, 142, 60, 0.06);
    border: 1px solid rgba(56, 142, 60, 0.3);
    color: #2e7d32;
}
#key-validation-banner.is-bad {
    background: rgba(220, 38, 38, 0.06);
    border: 1px solid rgba(220, 38, 38, 0.3);
    color: #b91c1c;
}
</style>

<script>
(function () {
    var pasteBlob = document.getElementById('paste-blob');
    var pubField  = document.getElementById('publishable_key');
    var secField  = document.getElementById('secret_key');
    var pubMarker = document.getElementById('pub-marker');
    var secMarker = document.getElementById('sec-marker');
    var banner    = document.getElementById('key-validation-banner');
    var saveBtn   = document.getElementById('save-btn');
    var showSec   = document.getElementById('show-secret');

    // First 14 body chars after pk_test_/sk_test_/pk_live_/sk_live_
    var KEY_RE = /^(pk|sk|rk)_(test|live)_([A-Za-z0-9]+)$/;

    function parseKey(k) {
        var m = (k || '').trim().match(KEY_RE);
        if (!m) return null;
        return {
            type: m[1],            // 'pk' / 'sk' / 'rk'
            mode: m[2],            // 'test' / 'live'
            marker: m[3].substring(0, 14),
            raw: k.trim(),
        };
    }

    function showMarker(el, parsed, partnerParsed) {
        if (!el) return;
        if (!parsed) {
            el.hidden = true;
            el.textContent = '';
            el.classList.remove('is-good', 'is-bad');
            return;
        }
        el.hidden = false;
        el.textContent = parsed.marker + ' · ' + parsed.mode;
        el.classList.remove('is-good', 'is-bad');
        if (partnerParsed) {
            if (partnerParsed.marker === parsed.marker
                && partnerParsed.mode === parsed.mode) {
                el.classList.add('is-good');
            } else {
                el.classList.add('is-bad');
            }
        }
    }

    function showBanner(level, msg) {
        if (!banner) return;
        banner.hidden = false;
        banner.classList.remove('is-good', 'is-bad');
        banner.classList.add('is-' + level);
        banner.textContent = msg;
    }
    function hideBanner() {
        if (!banner) return;
        banner.hidden = true;
        banner.textContent = '';
    }

    function validate() {
        var p = parseKey(pubField.value);
        var s = parseKey(secField.value);

        showMarker(pubMarker, p, s);
        showMarker(secMarker, s, p);

        // Allow save if both fields are empty (admin wants to clear them
        // through the regular save instead of the disconnect button).
        if (pubField.value.trim() === '' && secField.value.trim() === '') {
            hideBanner();
            saveBtn.disabled = false;
            return;
        }

        // Type checks
        if (pubField.value.trim() !== '' && (!p || p.type !== 'pk')) {
            showBanner('bad', 'Publishable key should start with pk_test_ or pk_live_.');
            saveBtn.disabled = true;
            return;
        }
        if (secField.value.trim() !== '' && (!s || s.type !== 'sk')) {
            showBanner('bad', 'Secret key should start with sk_test_ or sk_live_.');
            saveBtn.disabled = true;
            return;
        }

        // Need both before we can compare
        if (!p || !s) {
            showBanner('bad', 'Both publishable and secret keys are required.');
            saveBtn.disabled = true;
            return;
        }

        // Mode match
        if (p.mode !== s.mode) {
            showBanner('bad',
                'Mode mismatch — your publishable key is for ' + p.mode
                + ' mode but your secret key is for ' + s.mode + ' mode. '
                + 'Both must be from the same Stripe environment.');
            saveBtn.disabled = true;
            return;
        }

        // Account match
        if (p.marker !== s.marker) {
            showBanner('bad',
                'Account mismatch — your publishable key belongs to account '
                + p.marker + ' but your secret key belongs to account '
                + s.marker + '. '
                + 'Open the same Stripe dashboard tab and copy BOTH keys from '
                + 'the same place. Switching between sandboxes mid-copy is the '
                + '#1 cause of this error.');
            saveBtn.disabled = true;
            return;
        }

        // All good
        showBanner('good',
            '✓ Keys match: account ' + p.marker + ', ' + p.mode + ' mode. '
            + 'Click "Save and verify" — we\'ll confirm with Stripe before saving.');
        saveBtn.disabled = false;
    }

    // Smart paste: if user pastes the whole "API keys" section from
    // Stripe, extract pk_ and sk_ lines and route them.
    pasteBlob.addEventListener('input', function () {
        var lines = pasteBlob.value.split(/\s+/);
        var foundPub = null, foundSec = null;
        for (var i = 0; i < lines.length; i++) {
            var token = lines[i].trim();
            if (!token) continue;
            var parsed = parseKey(token);
            if (!parsed) continue;
            if (parsed.type === 'pk' && !foundPub) foundPub = token;
            if (parsed.type === 'sk' && !foundSec) foundSec = token;
        }
        if (foundPub) pubField.value = foundPub;
        if (foundSec) secField.value = foundSec;
        if (foundPub || foundSec) {
            // Clear the paste box on successful extraction so it doesn't
            // get submitted as form data.
            pasteBlob.value = '';
            validate();
        }
    });

    pubField.addEventListener('input', validate);
    secField.addEventListener('input', validate);

    if (showSec) {
        showSec.addEventListener('change', function () {
            secField.type = showSec.checked ? 'text' : 'password';
        });
    }

    // Initial validation on page load
    validate();
})();
</script>

<?php require $root . '/admin/partials/footer.php'; ?>
