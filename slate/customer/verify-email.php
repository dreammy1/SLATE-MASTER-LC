<?php
/**
 * Slate — customer email verification.
 * Consumes a single-use token from the verification email and
 * flips email_verified on the customer record.
 */
require_once dirname(__DIR__) . '/config.php';

$token  = (string)($_GET['token'] ?? '');
$result = null;

if ($token !== '') {
    $customerId = Auth::verifyCustomerEmail($token);
    $result = ($customerId !== null) ? 'ok' : 'fail';
}

$pageTitle = 'Verify your email';
$customerPageVariant = 'auth';
require __DIR__ . '/partials/header.php';
?>

<div class="auth-card">
    <?php if ($result === 'ok'): ?>
        <h1>You're verified</h1>
        <p class="auth-card-sub">Thanks — your email address is confirmed.</p>
        <div class="alert alert-success" role="status">
            You can now sign in to your account.
        </div>
        <a href="<?= e(SLATE_URL) ?>/customer/login.php" class="btn btn-primary btn-block btn-lg">
            Continue to sign in
        </a>
    <?php elseif ($result === 'fail'): ?>
        <h1>Link expired</h1>
        <p class="auth-card-sub">This verification link is invalid or has already been used.</p>
        <div class="alert alert-warning" role="status">
            Sign in to request a fresh verification email, or create a new account.
        </div>
        <a href="<?= e(SLATE_URL) ?>/customer/login.php" class="btn btn-primary btn-block">Sign in</a>
    <?php else: ?>
        <h1>Verify your email</h1>
        <p class="auth-card-sub">No token in the URL.</p>
        <div class="alert alert-info" role="status">
            Use the link we sent to your email address. If you didn't get one,
            <a href="<?= e(SLATE_URL) ?>/customer/register.php">register first</a>.
        </div>
    <?php endif; ?>
</div>

<?php require __DIR__ . '/partials/footer.php'; ?>
