<?php
/**
 * 0021_license_domains — remote licensing: domain binding + renewal chain.
 * Additive only. Backfills domain from metadata->domain where present.
 */
declare(strict_types=1);

use Slate\Data\Schema\Schema;
use Slate\Data\Schema\Table;

return new class extends \Slate\Data\Migration {
    public function up(Schema $s): void
    {
        if ($s->hasTable('licenses')) {
            $s->table('licenses', function (Table $t) {
                $t->string('domain', 255)->nullable()->after('license_key_hash');
                $t->string('billing_cycle', 16)->nullable()->after('plan_id');
                $t->int('replaces_license_id')->unsigned()->nullable()->after('activation_count');
                $t->string('package_slug', 64)->nullable()->after('plan_id');
            });
            try {
                foreach (\Database::rows("SELECT id, metadata FROM licenses WHERE domain IS NULL") as $row) {
                    $meta = json_decode((string)($row['metadata'] ?? ''), true);
                    if (is_array($meta) && !empty($meta['domain'])) {
                        \Database::query("UPDATE licenses SET domain = ? WHERE id = ?", [$meta['domain'], $row['id']]);
                    }
                }
            } catch (\Throwable $e) { /* best-effort backfill */ }
        }
    }

    public function down(Schema $s): void
    {
        if ($s->hasTable('licenses')) {
            $s->table('licenses', function (Table $t) {
                $t->drop('domain');
                $t->drop('billing_cycle');
                $t->drop('replaces_license_id');
                $t->drop('package_slug');
            });
        }
    }
};
