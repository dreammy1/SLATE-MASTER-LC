-- Master Licensing DB Schema
-- Adds packages, orders, and licenses tables for the licensing system

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  plugin_set TEXT, -- JSON array of plugins included
  restrictions TEXT, -- JSON array of restriction rules
  pricing_monthly_cents INTEGER,
  pricing_yearly_cents INTEGER,
  pricing_lifetime_cents INTEGER,
  pricing_currency TEXT DEFAULT 'USD',
  stripe_price_monthly TEXT,
  stripe_price_yearly TEXT,
  stripe_price_lifetime TEXT,
  github_ref TEXT, -- tag/branch for deployment
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  package_id TEXT REFERENCES packages(id),
  package_slug TEXT,
  billing_cycle TEXT CHECK(billing_cycle IN ('monthly','yearly','lifetime')),
  site_url TEXT,
  base_path TEXT,
  cpanel_config TEXT, -- JSON {host, user, api_token_encrypted}
  contact_info TEXT, -- JSON {name, phone, email}
  payment_method TEXT CHECK(payment_method IN ('stripe','bank_transfer','cash_on_delivery','custom')),
  status TEXT CHECK(status IN ('draft','pending_payment','pending_review','paid','bootstrap_running','bootstrap_done','install_running','completed','failed','cancelled')) DEFAULT 'draft',
  stripe_session_id TEXT,
  license_id TEXT,
  site_id TEXT,
  progress_percent REAL DEFAULT 0,
  progress_stage TEXT DEFAULT 'QUEUED',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  package_id TEXT REFERENCES packages(id),
  package_slug TEXT,
  billing_cycle TEXT,
  domain TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_last4 TEXT,
  status TEXT CHECK(status IN ('trial','active','expired','suspended','revoked','cancelled')) DEFAULT 'trial',
  starts_at DATETIME,
  expires_at DATETIME, -- NULL for lifetime
  activation_limit INTEGER DEFAULT 1,
  activation_count INTEGER DEFAULT 0,
  replaces_license_id TEXT,
  tenant_id TEXT,
  order_id TEXT REFERENCES orders(id),
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_licenses_domain ON licenses(domain);
CREATE INDEX IF NOT EXISTS idx_licenses_key_hash ON licenses(key_hash);
CREATE INDEX IF NOT EXISTS idx_packages_slug ON packages(slug);

-- Seed default packages based on your two-package spec
INSERT OR REPLACE INTO packages (id, slug, name, description, is_active, sort_order, plugin_set, restrictions, pricing_monthly_cents, pricing_yearly_cents, pricing_lifetime_cents, pricing_currency, github_ref) VALUES
('pkg_business_ops', 'business-ops', 'Business Operations', 'Core + Booking + Membership + Stripe Payment', 1, 1, '["booking","membership","stripe-payment"]', '[{"match":"admin/settings.php","mode":"block"},{"match":"admin/plugins.php","mode":"block"},{"match":"plugins/booking/admin/new.php","mode":"block"},{"match":"plugins/booking/admin/settings.php","mode":"block"},{"match":"plugins/stripe-payment/admin/*","mode":"block"},{"match":"plugins/booking/admin/appointments.php","mode":"readonly"},{"match":"plugins/booking/admin/customers.php","mode":"readonly"},{"match":"plugins/membership/admin/members.php","mode":"readonly"}]', 2900, 2900, 9900, 'USD', 'v1.4.0'),
('pkg_coaching_suite', 'coaching-suite', 'Coaching Platform', 'Core + Coaching + Forms + Stripe Payment + MCP Gateway', 1, 2, '["coaching","forms","stripe-payment","mcp-gateway"]', '[{"match":"admin/settings.php","mode":"block"},{"match":"admin/plugins.php","mode":"block"},{"match":"plugins/coaching/admin/new.php","mode":"block"},{"match":"plugins/coaching/admin/settings.php","mode":"block"},{"match":"plugins/forms/admin/*","mode":"block"},{"match":"plugins/stripe-payment/admin/*","mode":"block"},{"match":"plugins/coaching/admin/sessions.php","mode":"readonly"},{"match":"plugins/coaching/admin/clients.php","mode":"readonly"},{"match":"admin/contact_forms.php","mode":"readonly"}]', 4900, 4900, 19900, 'USD', 'v1.4.0');