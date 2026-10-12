<?php
/**
 * Slate WordPress Licensing Admin View & Controller
 *
 * Renders the clean license management page under WordPress Admin,
 * handles key submission, CSRF nonces, and displays status indicators.
 *
 * @package Slate_WP_License
 * @version 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

class Slate_WP_License_Admin {

    /**
     * @var array
     */
    protected $config;

    /**
     * @var Slate_WP_License
     */
    protected $license;

    /**
     * Feedback notice.
     *
     * @var array|null
     */
    protected $notice = null;

    /**
     * Initialize Admin Interface.
     *
     * @param array $config
     * @param Slate_WP_License $license
     * @return Slate_WP_License_Admin
     */
    public static function init($config, $license) {
        return new self($config, $license);
    }

    /**
     * Constructor.
     */
    public function __construct($config, $license) {
        $this->config  = $config;
        $this->license = $license;

        add_action('admin_menu', array($this, 'register_menu'));
        add_action('admin_init', array($this, 'handle_actions'));
        add_action('admin_notices', array($this, 'render_admin_notice'));
    }

    /**
     * Register Admin Page.
     */
    public function register_menu() {
        $page_title = $this->config['name'] . ' License';
        $menu_title = $this->config['name'] . ' License';
        $menu_slug  = 'slate-license-' . $this->config['slug'];

        add_options_page(
            $page_title,
            $menu_title,
            'manage_options',
            $menu_slug,
            array($this, 'render_page')
        );
    }

    /**
     * Handle Activate / Deactivate / Check POST submissions.
     */
    public function handle_actions() {
        $slug = $this->config['slug'];
        if (!isset($_POST['slate_license_action_' . $slug])) {
            return;
        }

        if (!current_user_can('manage_options')) {
            wp_die(__('Unauthorized user action.', 'slate'));
        }

        check_admin_referer('slate_license_verify_' . $slug);

        $action = sanitize_text_field($_POST['slate_license_action_' . $slug]);

        if ($action === 'activate') {
            $key = isset($_POST['slate_license_key']) ? sanitize_text_field($_POST['slate_license_key']) : '';
            $res = $this->license->activate($key);
            $this->notice = array(
                'type'    => !empty($res['success']) ? 'success' : 'error',
                'message' => !empty($res['success']) ? $res['message'] : ($res['error'] ?? 'Activation failed.'),
            );
        } elseif ($action === 'deactivate') {
            $res = $this->license->deactivate();
            $this->notice = array(
                'type'    => 'info',
                'message' => 'License has been deactivated.',
            );
        } elseif ($action === 'check') {
            $res = $this->license->check_license();
            $this->notice = array(
                'type'    => !empty($res['success']) ? 'success' : 'error',
                'message' => !empty($res['success']) ? 'License status verified: Active' : ($res['error'] ?? 'License check failed.'),
            );
        }
    }

    /**
     * Display a warning notice across WP Admin if license is not active.
     */
    public function render_admin_notice() {
        if ($this->license->is_active()) {
            return;
        }

        $screen = get_current_screen();
        $menu_slug = 'slate-license-' . $this->config['slug'];
        if ($screen && strpos($screen->id, $menu_slug) !== false) {
            return; // Don't show redundant banner on license page itself
        }

        $license_url = admin_url('options-general.php?page=' . $menu_slug);
        ?>
        <div class="notice notice-warning is-dismissible" style="border-left-color: #00f0ff;">
            <p>
                <strong><?php echo esc_html($this->config['name']); ?></strong> is currently unlicensed.
                <a href="<?php echo esc_url($license_url); ?>" class="button button-small" style="margin-left:8px;">
                    Activate License &rarr;
                </a>
            </p>
        </div>
        <?php
    }

    /**
     * Render the License Settings Page.
     */
    public function render_page() {
        $data   = $this->license->get_data();
        $slug   = $this->config['slug'];
        $active = $this->license->is_active();
        $domain = untrailingslashit(home_url());

        ?>
        <div class="wrap" style="max-width: 800px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <h1 style="display:flex; align-items:center; gap:10px; margin-bottom: 20px;">
                <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:<?php echo $active ? '#10b981' : '#f43f5e'; ?>;"></span>
                <?php echo esc_html($this->config['name']); ?> &mdash; License Management
            </h1>

            <?php if ($this->notice): ?>
                <div class="notice notice-<?php echo esc_attr($this->notice['type']); ?> is-dismissible">
                    <p><strong><?php echo esc_html($this->notice['message']); ?></strong></p>
                </div>
            <?php endif; ?>

            <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:24px; box-shadow:0 1px 3px rgba(0,0,0,0.05); margin-top:20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #f1f5f9; padding-bottom:16px; margin-bottom:20px;">
                    <div>
                        <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Status</div>
                        <div style="font-size:18px; font-weight:700; color:<?php echo $active ? '#059669' : '#dc2626'; ?>; margin-top:4px;">
                            <?php echo $active ? '● ACTIVE & VERIFIED' : '○ ' . strtoupper(esc_html($data['status'])); ?>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Plugin Version</div>
                        <div style="font-size:14px; font-weight:600; color:#1e293b; margin-top:4px;">
                            v<?php echo esc_html($this->config['version']); ?>
                        </div>
                    </div>
                </div>

                <form method="post" action="">
                    <?php wp_nonce_field('slate_license_verify_' . $slug); ?>

                    <table class="form-table" role="presentation">
                        <tbody>
                            <tr>
                                <th scope="row">
                                    <label for="slate_license_key">License Key</label>
                                </th>
                                <td>
                                    <input 
                                        type="text" 
                                        name="slate_license_key" 
                                        id="slate_license_key" 
                                        value="<?php echo esc_attr($data['key']); ?>" 
                                        class="regular-text code"
                                        placeholder="SLT-XXXX-XXXX-XXXX-XXXX"
                                        style="font-family:monospace; font-size:14px; padding:6px 10px; width:100%; max-width:420px;"
                                        <?php echo $active ? 'readonly' : ''; ?>
                                    />
                                    <p class="description">
                                        Enter the license key delivered upon checkout.
                                    </p>
                                </td>
                            </tr>
                            <tr>
                                <th scope="row">Site Domain</th>
                                <td>
                                    <code><?php echo esc_html($domain); ?></code>
                                    <p class="description">License activations are cryptographically locked to this site URL.</p>
                                </td>
                            </tr>
                            <?php if (!empty($data['expires_at'])): ?>
                            <tr>
                                <th scope="row">Expires On</th>
                                <td>
                                    <strong><?php echo esc_html(date('F j, Y', strtotime($data['expires_at']))); ?></strong>
                                </td>
                            </tr>
                            <?php endif; ?>
                            <?php if (!empty($data['last_checked'])): ?>
                            <tr>
                                <th scope="row">Last Heartbeat</th>
                                <td>
                                    <span style="color:#64748b;"><?php echo esc_html(human_time_diff($data['last_checked'], time()) . ' ago'); ?></span>
                                </td>
                            </tr>
                            <?php endif; ?>
                        </tbody>
                    </table>

                    <div style="margin-top:24px; padding-top:16px; border-top:1px solid #f1f5f9; display:flex; gap:10px; align-items:center;">
                        <?php if (!$active): ?>
                            <input type="hidden" name="slate_license_action_<?php echo esc_attr($slug); ?>" value="activate" />
                            <button type="submit" class="button button-primary" style="background:#0284c7; border-color:#0284c7; padding:4px 16px;">
                                Activate License
                            </button>
                        <?php else: ?>
                            <button type="submit" name="slate_license_action_<?php echo esc_attr($slug); ?>" value="check" class="button">
                                Check Status Now
                            </button>
                            <button type="submit" name="slate_license_action_<?php echo esc_attr($slug); ?>" value="deactivate" class="button button-secondary" onclick="return confirm('Deactivate this license on this site?');">
                                Deactivate License
                            </button>
                        <?php endif; ?>
                    </div>
                </form>
            </div>

            <div style="margin-top:20px; color:#94a3b8; font-size:12px; display:flex; justify-content:space-between;">
                <span>Powered by Slate DevOps Licensing Shield</span>
                <span>Automated Heartbeat: Daily WP-Cron</span>
            </div>
        </div>
        <?php
    }
}
