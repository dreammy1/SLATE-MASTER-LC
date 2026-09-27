<?php
/**
 * MLT — Harvester. Walks a rendered HTML page and stores every unique
 * translatable text string it finds. Runs passively on every real page
 * view (see MultilangTranslate::obCallback) and is also driven by
 * MLT_Crawler for the manual "Scan" button.
 */

class MLT_Harvester {

    public static function harvest(int $tid, string $html, string $area): int {
        if (stripos($html, '<html') === false && stripos($html, '<body') === false && strlen($html) < 20) {
            return 0; // not a full HTML page (JSON/XML/asset response) — skip
        }
        $seen = [];
        MLT_Tokenizer::walk($html, function (string $normalized) use (&$seen) {
            $seen[$normalized] = ($seen[$normalized] ?? 0) + 1;
            return null; // read-only, no replacement
        });
        if (!$seen) return 0;
        return MLT_StringRepo::harvestBatch($tid, $seen, $area);
    }
}
