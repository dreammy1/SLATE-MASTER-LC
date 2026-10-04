<?php
/**
 * 0025_plugin_checkout_profiles - saved billing details for one-click checkout.
 *
 * The point of this table is that a returning customer never retypes their
 * details. It stores CONTACT AND BILLING INFORMATION ONLY.
 *
 * No card data, ever - not a number, not a token, not the last four. Payment
 * details stay inside Stripe's own hosted iframe on the Master site, so this
 * table is out of PCI scope entirely. If that rule is ever broken, this comment
 * is the reason it should not be.
 *
 * One row per tenant (UNIQUE), because the profile describes the person/company
 * behind the account, not an individual purchase.
 */
declare(strict_types=1);
use Slate\Data\Schema\Schema;
use Slate\Data\Schema\Table;
return new class extends \Slate\Data\Migration {
    public function up(Schema $s): void
    {
        $s->create('plugin_checkout_profiles', function (Table $t) {
            $t->id();
            $t->int('tenant_id')->unsigned();
            $t->string('full_name', 255)->nullable();
            $t->string('email', 255)->nullable();
            $t->string('phone', 64)->nullable();
            $t->string('company', 255)->nullable();
            $t->string('vat_tax_id', 64)->nullable();
            $t->string('country', 2)->nullable();
            $t->string('city', 128)->nullable();
            $t->string('address_line1', 255)->nullable();
            $t->string('address_line2', 255)->nullable();
            $t->string('postal_code', 32)->nullable();
            $t->string('master_customer_id', 255)->nullable();
            $t->datetime('created_at')->useCurrent();
            $t->datetime('updated_at')->useCurrent();
            $t->unique('tenant_id', 'uniq_checkout_profile_tenant');
        });
    }
    public function down(Schema $s): void
    {
        $s->dropIfExists('plugin_checkout_profiles');
    }
};