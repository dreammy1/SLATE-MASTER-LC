<?php
/**
 * 0024_plugin_orders - plugin shop checkout records.
 *
 * Deliberately separate from the core `orders` table. A core order carries
 * cPanel host/user/API token and drives the whole bootstrap pipeline (database
 * creation, file deploy, agent handshake). A plugin order needs none of that:
 * the plugin files are already on the server, so paying only flips an
 * entitlement. Reusing `orders` would have meant either nullable cPanel columns
 * everywhere or a bootstrap pipeline that tries to deploy for a purchase that
 * must never touch the filesystem.
 *
 * `stripe_session_id` is UNIQUE rather than merely indexed: Stripe retries
 * webhooks aggressively, and the unique constraint is what makes a retried
 * payment idempotent at the database level instead of relying on a read-then-
 * write check that two concurrent deliveries can both pass.
 */
declare(strict_types=1);
use Slate\Data\Schema\Schema;
use Slate\Data\Schema\Table;
return new class extends \Slate\Data\Migration {
    public function up(Schema $s): void
    {
        $s->create('plugin_orders', function (Table $t) {
            $t->id();
            $t->int('tenant_id')->unsigned();
            $t->enum('order_type', ['single', 'package'])->default('single');
            $t->string('package_slug', 64)->nullable();
            $t->json('plugin_slugs')->nullable();
            $t->string('billing_cycle', 16)->default('yearly');
            $t->int('amount_cents')->unsigned()->default(0);
            $t->string('currency', 8)->default('USD');
            $t->enum('status', ['pending_payment', 'paid', 'failed', 'cancelled', 'refunded'])
                ->default('pending_payment');
            $t->string('stripe_session_id', 255)->nullable();
            $t->string('stripe_payment_intent', 255)->nullable();
            $t->int('renewal_of_plugin_license_id')->unsigned()->nullable();
            $t->string('contact_email', 255)->nullable();
            $t->json('metadata')->nullable();
            $t->datetime('created_at')->useCurrent();
            $t->datetime('paid_at')->nullable();
            $t->datetime('updated_at')->useCurrent();
            $t->unique('stripe_session_id', 'uniq_plugin_order_session');
            $t->index('tenant_id', 'idx_plugord_tenant');
            $t->index('status', 'idx_plugord_status');
        });
    }
    public function down(Schema $s): void
    {
        $s->dropIfExists('plugin_orders');
    }
};