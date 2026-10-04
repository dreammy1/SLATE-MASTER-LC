<?php
/**
 * Slate - TenantToken: a short-lived, signed proof of "which tenant is asking".
 *
 * The checkout page runs inside an IFRAME posted from the customer's Slate
 * site to the Master dashboard. An iframe carries no session - it is a separate
 * origin, a separate cookie jar - so Master cannot tell which tenant opened it.
 * Passing a bare tenant_id would be catastrophic: anyone could edit the number
 * and buy plugins, or read saved billing details, for someone else's account.
 *
 * So the tenant's own server mints a token here, signed with its APP_SECRET,
 * and Master verifies it with the tenant secret it already holds from pairing.
 * The token carries the tenant id AND the domain, so a token stolen from site A
 * cannot be replayed against site B.
 *
 * Deliberately NOT a JWT: this codebase already standardises on `slate_sign()`
 * (HMAC + context namespace), and adding a second token format means a second
 * set of bugs. The payload is base64 JSON plus a signature, which is all a JWT
 * would give us here, with far less surface.
 *
 * Format:  base64url(json).base64url(hmac)
 * Lifetime: 5 minutes. Long enough to open a checkout modal, short enough that
 * a leaked URL in a browser history is worthless.
 *
 * Layer: Services / Licensing.
 */
declare(strict_types=1);
namespace Slate\Services\Licensing;

class TenantToken
{
    /** Seconds a freshly minted token stays valid. */
    public const TTL = 300;

    private const CONTEXT = 'slate.checkout.tenant';

    /**
     * Mint a token for this tenant.
     *
     * Returns null when APP_SECRET is missing. That is deliberate: minting a
     * token under a fallback constant would produce a signature anyone could
     * forge, which is worse than refusing to continue. Callers must handle null.
     */
    public static function mint(int $tenantId, string $domain, ?string $email = null): ?string
    {
        $payload = [
            't'  => $tenantId,
            'd'  => self::normaliseDomain($domain),
            'e'  => $email !== null ? strtolower(trim($email)) : '',
            'ia' => time(),
            'ex' => time() + self::TTL,
            // Random nonce so two tokens minted in the same second differ -
            // otherwise a retry would produce an identical string and any replay
            // window would silently widen.
            'n'  => bin2hex(random_bytes(8)),
        ];
        $json = json_encode($payload, JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return null;
        }
        $body = self::b64urlEncode($json);
        $sig  = slate_sign(self::CONTEXT, $body);
        if ($sig === null) {
            return null;
        }
        return $body . '.' . self::b64urlEncode($sig);
    }

    /**
     * Verify a token and return its claims, or null when it is not trustworthy.
     *
     * $secret is the tenant's APP_SECRET as known by Master (established during
     * agent pairing). Passing the wrong secret simply fails the signature check.
     *
     * Strict on purpose: expired, malformed, wrong-signature and unknown-secret
     * all return null. There is no "trust it anyway" path, because the only
     * caller that would want one is an attacker.
     *
     * @return array{t:int,d:string,e:string,ia:int,ex:int,n:string}|null
     */
    public static function verify(string $token, string $secret): ?array
    {
        $secret = trim($secret);
        if ($token === '' || $secret === '') {
            return null;
        }
        $parts = explode('.', $token);
        if (count($parts) !== 2) {
            return null;
        }
        [$body, $sigEncoded] = $parts;

        $expected = hash_hmac('sha256', self::CONTEXT . '|' . $body, $secret);
        $actual   = self::b64urlDecode($sigEncoded);
        if ($actual === null || !hash_equals($expected, $actual)) {
            return null;
        }

        $json = self::b64urlDecode($body);
        if ($json === null) {
            return null;
        }
        $claims = json_decode($json, true);
        if (!is_array($claims) || !isset($claims['t'], $claims['ex'])) {
            return null;
        }
        if ((int) $claims['ex'] < time()) {
            return null; // expired
        }
        if ((int) $claims['t'] <= 0) {
            return null;
        }
        return $claims;
    }

    /**
     * Does this token belong to the domain it is being used from?
     *
     * Belt-and-braces on top of the signature: if a token were ever logged or
     * leaked in a screenshot, it still cannot be redeemed from another site.
     */
    public static function matchesDomain(array $claims, string $domain): bool
    {
        return self::normaliseDomain((string) ($claims['d'] ?? '')) === self::normaliseDomain($domain);
    }

    /** Scheme-less, lowercase, no trailing slash, no www prefix. */
    private static function normaliseDomain(string $domain): string
    {
        $d = strtolower(trim($domain));
        $d = preg_replace('#^https?://#', '', $d) ?? $d;
        $d = preg_replace('#/.*$#', '', $d) ?? $d;
        $d = preg_replace('#^www\.#', '', $d) ?? $d;
        return rtrim($d, '/');
    }

    private static function b64urlEncode(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    private static function b64urlDecode(string $encoded): ?string
    {
        $padded = strtr($encoded, '-_', '+/');
        $mod    = strlen($padded) % 4;
        if ($mod > 0) {
            $padded .= str_repeat('=', 4 - $mod);
        }
        $decoded = base64_decode($padded, true);
        return $decoded === false ? null : $decoded;
    }
}