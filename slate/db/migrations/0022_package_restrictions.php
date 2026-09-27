<?php
/**
 * 0022_package_restrictions — per-package URL restriction map for read-only expiry mode.
 * Master syncs Package.restrictions here on full-install; guard reads it.
 */
declare(strict_types=1);

use Slate\Data\Schema\Schema;
use Slate\Data\Schema\Table;

return new class extends \Slate\Data\Migration {
    public function up(Schema $s): void
    {
        $s->create('package_restrictions', function (Table $t) {
            $t->id();
            $t->string('package_slug', 64);
            $t->string('match', 255);
            $t->string('mode', 16)->default('block');
            $t->int('sort_order')->default(0);
            $t->datetime('created_at')->useCurrent();
            $t->index('package_slug', 'idx_pkg_slug');
        });

        $defaults = [
            ['admin/settings.php', 'block'],
            ['admin/plugins.php', 'block'],
            ['admin/users.php', 'block'],
            ['admin/roles.php', 'block'],
            ['plugins/booking/admin/new.php', 'block'],
            ['plugins/booking/admin/settings.php', 'block'],
            ['plugins/stripe-payment/admin/*', 'block'],
            ['plugins/booking/admin/appointments.php', 'readonly'],
            ['plugins/booking/admin/customers.php', 'readonly'],
            ['plugins/membership/admin/members.php', 'readonly'],
            ['admin/contact_forms.php', 'readonly'],
        ];
        foreach (['business-ops', 'coaching-suite'] as $slug) {
            $i = 0;
            foreach ($defaults as [$match, $mode]) {
                try {
                    \Database::insert('package_restrictions', ['package_slug' => $slug, 'match' => $match, 'mode' => $mode, 'sort_order' => $i++]);
                } catch (\Throwable $e) { /* seed best-effort */ }
            }
        }
    }

    public function down(Schema $s): void
    {
        $s->dropIfExists('package_restrictions');
    }
};
