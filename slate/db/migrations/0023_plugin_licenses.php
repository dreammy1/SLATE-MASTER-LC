<?php
/**
 * 0023_plugin_licenses - per-plugin entitlements for individually sold plugins.
 *
 * Core licensing lives in `licenses` (one row per tenant, domain-bound). A
 * plugin sold OUTSIDE a package needs its own independent lifecycle: its own
 * key, its own expiry, its own renewal chain. Folding that into `licenses`
 * would mean either one row per plugin (breaking "the tenant's license") or a
 * JSON blob nobody could query by expiry.
 *
 * Key handling mirrors the Master side exactly: SHA-256 hash for lookup,
 * last4 for display, AES-encrypted copy so support can re-show a key that a
 * customer lost (rotating instead is a worse answer when the key is already
 * installed).
 *
 * `source` records HOW the entitlement was acquired, because "did this plugin
 * come from the package?" decides whether the customer may renew it directly
 * or must renew the package instead.
 */
declare(strict_types=1);
use Slate\Data\Schema\Schema;
use Slate\Data\Schema\Table;
return new class extends \Slate\Data\Migration {
    public function up(Schema $s): void
    {
        $s->create('plugin_licenses', function (Table $t) {
            $t->id();
            $t->int('tenant_id')->unsigned();
            $t->string('plugin_slug', 64);
            $t->string('domain', 255)->nullable();
            $t->char('license_key_hash', 64);
            $t->string('license_key_last4', 8)->nullable();
            $t->text('license_key_encrypted')->nullable();
            $t->enum('status', ['trial', 'active', 'expired', 'suspended', 'revoked', 'cancelled'])
                ->default('active');
            $t->string('billing_cycle', 16)->nullable();
            $t->enum('source', ['package', 'single', 'manual'])->default('single');
            // Set when source = package, so the UI can say
            // "included in Business Ops" and disable single-plugin renewal.
            $t->string('source_package_slug', 64)->nullable();
            $t->datetime('starts_at')->useCurrent();
            $t->datetime('expires_at')->nullable();
            $t->int('activation_limit')->unsigned()->default(1);
            $t->int('activation_count')->unsigned()->default(0);
            $t->int('renewal_of')->unsigned()->nullable();
            $t->json('metadata')->nullable();
            $t->datetime('last_validated_at')->nullable();
            $t->datetime('created_at')->useCurrent();
            $t->datetime('updated_at')->useCurrent();
            $t->unique('license_key_hash', 'uniq_plugin_license_hash');
            $t->index('tenant_id', 'idx_pluglic_tenant');
            $t->index(['tenant_id', 'plugin_slug'], 'idx_pluglic_tenant_slug');
            $t->index('status', 'idx_pluglic_status');
            $t->index('expires_at', 'idx_pluglic_expires');
        });
    }
    public function down(Schema $s): void
    {
        $s->dropIfExists('plugin_licenses');
    }
};