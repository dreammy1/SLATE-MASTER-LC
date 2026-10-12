<?php
/**
 * Slate WordPress Licensing SDK
 *
 * Provides automated activation, daily verification heartbeat via WP-Cron,
 * local status persistence, offline grace period, and fail-closed license enforcement.
 *
 * @package Slate_WP_License
 * @version 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

class Slate_WP_License {

    /**
     * Active configurations keyed by plugin slug.
     *
     * @var array
     */
    protected static $instances = array();

    /**
     * Configuration for this instance.
     *
     * @var array
     */
    protected $config = array();

    /**
     * Initialize licensing for a WordPress plugin.
     *
     * @param array $args {
     *     @type string $slug       Required. Unique plugin slug.
     *     @type string $name       Required. Human-readable plugin name.
     *     @type string $version    Required. Plugin version.
     *     @type string $master_url Required. Master dashboard URL.
     * }
     * @return Slate_WP_License
     */
    public static function init($args = array()) {
        $slug = isset($args['slug']) ? sanitize_key($args['slug']) : '';
        if (empty($slug)) {
            return null;
        }

        if (!isset(self::$instances[$slug])) {
            self::$instances[$slug] = new self($args);
        }

        return self::$instances[$slug];
    }

    /**
     * Retrieve a registered license instance by slug.
     *
     * @param string|null $slug
     * @return Slate_WP_License|null
     */
    public static function get_instance($slug = null) {
        if ($slug && isset(self::$instances[$slug])) {
            return self::$instances[$slug];
        }
        $keys = array_keys(self::$instances);
        if (!empty($keys)) {
            return self::$instances[$keys[0]];
        }
        return null;
    }

    /**
     * Constructor.
     */
    protected function __construct($args) {
        $this->config = wp_parse_args($args, array(
            'slug'       => '',
            'name'       => 'Slate Plugin',
            'version'    => '1.0.0',
            'master_url' => '',
        ));

        $slug = $this->config['slug'];

        // Register daily verification cron hook
        $cron_hook = 'slate_wp_license_daily_cron_' . $slug;
        add_action($cron_hook, array($this, 'daily_cron_heartbeat'));

        if (!wp_next_scheduled($cron_hook)) {
            wp_schedule_event(time() + DAY_IN_SECONDS, 'daily', $cron_hook);
        }

        // Initialize admin UI when running in WP Admin
        if (is_admin()) {
            if (file_exists(__DIR__ . '/class-slate-wp-license-admin.php')) {
                require_once __DIR__ . '/class-slate-wp-license-admin.php';
                Slate_WP_License_Admin::init($this->config, $this);
            }
        }
    }

    /**
     * Option key for storing license state.
     *
     * @return string
     */
    public function get_option_key() {
        return 'slate_license_' . $this->config['slug'];
    }

    /**
     * Retrieve stored license data.
     *
     * @return array
     */
    public function get_data() {
        $data = get_option($this->get_option_key(), array());
        return wp_parse_args($data, array(
            'key'          => '',
            'status'       => 'inactive',
            'expires_at'   => null,
            'last_checked' => 0,
            'server_msg'   => '',
        ));
    }

    /**
     * Save license data.
     *
     * @param array $data
     * @return bool
     */
    public function save_data($data) {
        return update_option($this->get_option_key(), $data, false);
    }

    /**
     * Determine if license is currently active (fail-closed with 72h offline grace).
     *
     * @return bool
     */
    public function is_active() {
        $data = $this->get_data();
        if (empty($data['key']) || $data['status'] !== 'active') {
            return false;
        }

        // Check explicit expiration date if set
        if (!empty($data['expires_at'])) {
            $expiry = strtotime($data['expires_at']);
            if ($expiry && time() > $expiry) {
                // Expired
                $data['status'] = 'expired';
                $this->save_data($data);
                return false;
            }
        }

        // 72-hour offline grace period check
        if (!empty($data['last_checked'])) {
            $elapsed = time() - intval($data['last_checked']);
            if ($elapsed > (72 * HOUR_IN_SECONDS)) {
                // Heartbeat missed for over 72 hours
                return apply_filters('slate_license_is_active_' . $this->config['slug'], false, $data);
            }
        }

        return apply_filters('slate_license_is_active_' . $this->config['slug'], true, $data);
    }

    /**
     * Static helper: Check if plugin features are unlocked.
     *
     * @param string|null $slug
     * @return bool
     */
    public static function is_unlocked($slug = null) {
        $inst = self::get_instance($slug);
        return $inst ? $inst->is_active() : false;
    }

    /**
     * Normalize Master URL.
     *
     * @return string
     */
    public function get_master_url() {
        $url = trim($this->config['master_url']);
        if (empty($url)) {
            $url = defined('SLATE_MASTER_URL') ? SLATE_MASTER_URL : '';
        }
        return rtrim($url, '/');
    }

    /**
     * Activate license key against Master API.
     *
     * @param string $key
     * @return array
     */
    public function activate($key) {
        $raw_key = strtoupper(trim(sanitize_text_field($key)));
        if (empty($raw_key)) {
            return array('success' => false, 'error' => 'Please enter a valid license key.');
        }

        $master_url = $this->get_master_url();
        if (empty($master_url)) {
            return array('success' => false, 'error' => 'Master dashboard URL is not configured.');
        }

        $endpoint = $master_url . '/api/licenses/activate';
        $domain   = untrailingslashit(home_url());

        $payload = array(
            'key'     => $raw_key,
            'domain'  => $domain,
            'slug'    => $this->config['slug'],
            'version' => $this->config['version'],
        );

        $response = wp_remote_post($endpoint, array(
            'timeout'     => 15,
            'headers'     => array(
                'Content-Type' => 'application/json',
                'Accept'       => 'application/json',
            ),
            'body'        => wp_json_encode($payload),
            'sslverify'   => false,
        ));

        if (is_wp_error($response)) {
            return array(
                'success' => false,
                'error'   => 'Could not reach licensing server: ' . $response->get_error_message(),
            );
        }

        $code = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);
        $json = json_decode($body, true);

        if ($code === 200 && !empty($json['success'])) {
            $expires_at = null;
            if (isset($json['license']['expires_at'])) {
                $expires_at = $json['license']['expires_at'];
            }

            $saved_data = array(
                'key'          => $raw_key,
                'status'       => 'active',
                'expires_at'   => $expires_at,
                'last_checked' => time(),
                'server_msg'   => 'License activated successfully.',
            );
            $this->save_data($saved_data);
            do_action('slate_license_activated_' . $this->config['slug'], $saved_data);

            return array('success' => true, 'message' => 'License activated successfully!');
        }

        $error_msg = !empty($json['error']) ? $json['error'] : 'License activation failed (HTTP ' . $code . ').';
        
        $this->save_data(array(
            'key'          => $raw_key,
            'status'       => 'inactive',
            'expires_at'   => null,
            'last_checked' => time(),
            'server_msg'   => $error_msg,
        ));

        return array('success' => false, 'error' => $error_msg);
    }

    /**
     * Deactivate current license locally.
     *
     * @return array
     */
    public function deactivate() {
        $data = array(
            'key'          => '',
            'status'       => 'inactive',
            'expires_at'   => null,
            'last_checked' => time(),
            'server_msg'   => 'License deactivated.',
        );
        $this->save_data($data);
        do_action('slate_license_deactivated_' . $this->config['slug'], $data);

        return array('success' => true, 'message' => 'License deactivated.');
    }

    /**
     * Check license status against Master /api/licenses/check.
     *
     * @return array
     */
    public function check_license() {
        $data = $this->get_data();
        if (empty($data['key'])) {
            return array('success' => false, 'error' => 'No license key configured.');
        }

        $master_url = $this->get_master_url();
        if (empty($master_url)) {
            return array('success' => false, 'error' => 'Master URL not configured.');
        }

        $domain   = untrailingslashit(home_url());
        $endpoint = add_query_arg(array(
            'key'     => $data['key'],
            'site'    => $domain,
            'slug'    => $this->config['slug'],
            'version' => $this->config['version'],
        ), $master_url . '/api/licenses/check');

        $response = wp_remote_get($endpoint, array(
            'timeout'   => 15,
            'headers'   => array('Accept' => 'application/json'),
            'sslverify' => false,
        ));

        if (is_wp_error($response)) {
            // Master unreachable: do not immediately lock out if within 72h grace
            $elapsed = time() - intval($data['last_checked']);
            if ($elapsed <= (72 * HOUR_IN_SECONDS) && $data['status'] === 'active') {
                return array('success' => true, 'status' => 'active', 'grace_period' => true);
            }
            return array('success' => false, 'error' => $response->get_error_message());
        }

        $code = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);
        $json = json_decode($body, true);

        if ($code === 200 && !empty($json['ok']) && !empty($json['status'])) {
            $data['status']       = $json['status'];
            $data['expires_at']   = isset($json['expires_at']) ? $json['expires_at'] : $data['expires_at'];
            $data['last_checked'] = time();
            $data['server_msg']   = 'Verified online.';
            $this->save_data($data);

            return array('success' => true, 'status' => $data['status']);
        }

        // Inactive or revoked on server
        $new_status = (!empty($json['status'])) ? $json['status'] : 'revoked';
        $data['status']       = $new_status;
        $data['last_checked'] = time();
        $data['server_msg']   = !empty($json['error']) ? $json['error'] : 'License revoked or expired.';
        $this->save_data($data);

        return array('success' => false, 'status' => $new_status, 'error' => $data['server_msg']);
    }

    /**
     * Cron callback: Daily heartbeat.
     */
    public function daily_cron_heartbeat() {
        $this->check_license();
    }
}
