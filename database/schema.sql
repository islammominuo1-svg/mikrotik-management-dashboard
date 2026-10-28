CREATE DATABASE IF NOT EXISTS mikrotik_manager
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE mikrotik_manager;

CREATE TABLE IF NOT EXISTS routers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  host VARCHAR(255) NOT NULL,
  username VARCHAR(120) NOT NULL,
  password VARCHAR(255) NOT NULL,
  port INT NOT NULL DEFAULT 443,
  verify_tls TINYINT(1) NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS traffic_samples (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  router_id INT UNSIGNED NOT NULL,
  rx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cpu_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  sampled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_traffic_router FOREIGN KEY (router_id)
    REFERENCES routers(id) ON DELETE CASCADE,
  INDEX idx_traffic_router_time (router_id, sampled_at)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  router_id INT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL,
  details TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_router FOREIGN KEY (router_id)
    REFERENCES routers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS package_profiles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  router_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  speed VARCHAR(60) NOT NULL DEFAULT '0 Mbps',
  description VARCHAR(255) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_package_router FOREIGN KEY (router_id)
    REFERENCES routers(id) ON DELETE CASCADE,
  INDEX idx_package_router (router_id)
);


CREATE TABLE IF NOT EXISTS resellers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(160) NOT NULL,
  username VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  mobile VARCHAR(30) NOT NULL UNIQUE,
  email VARCHAR(180) NOT NULL,
  zone VARCHAR(120) NOT NULL,
  voter_id_image LONGTEXT NULL,
  permissions VARCHAR(255) NOT NULL DEFAULT 'ppp_user_create_only',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reseller_customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reseller_id INT UNSIGNED NOT NULL,
  created_by_reseller_id INT UNSIGNED NULL,
  router_id INT UNSIGNED NULL,
  full_name VARCHAR(160) NOT NULL,
  username VARCHAR(120) NOT NULL,
  password VARCHAR(120) NOT NULL,
  mobile VARCHAR(30) NOT NULL,
  email VARCHAR(180) NULL,
  package_name VARCHAR(120) NOT NULL,
  area VARCHAR(120) NOT NULL,
  expiry_date DATE NOT NULL,
  balance_days INT NOT NULL DEFAULT 0,
  emergency_extend_used TINYINT(1) NOT NULL DEFAULT 0,
  id_document LONGTEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_customer_reseller (reseller_id),
  INDEX idx_customer_creator_active (created_by_reseller_id, is_active, deleted_at)
);

CREATE TABLE IF NOT EXISTS ppp_customer_delete_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  customer_id INT UNSIGNED NOT NULL,
  router_id INT UNSIGNED NULL,
  deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  restored_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_ppp_delete_customer (customer_id),
  INDEX idx_ppp_delete_state (restored_at, deleted_at)
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reseller_id INT UNSIGNED NOT NULL,
  payment_type ENUM('reseller', 'customer') NOT NULL DEFAULT 'customer',
  customer_name VARCHAR(160) NOT NULL,
  customer_username VARCHAR(120) NOT NULL,
  package_name VARCHAR(120) NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  payment_method VARCHAR(60) NOT NULL DEFAULT 'bKash',
  payment_channel VARCHAR(40) NOT NULL DEFAULT 'cash',
  receiver_name VARCHAR(160) NULL,
  trx_id VARCHAR(100) NULL,
  status ENUM('paid', 'pending', 'processing', 'partial', 'due') NOT NULL DEFAULT 'paid',
  payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL,
  INDEX idx_payment_reseller (reseller_id),
  INDEX idx_payment_type (payment_type),
  INDEX idx_payment_date (payment_date)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payment_id BIGINT UNSIGNED NOT NULL,
  reseller_id INT UNSIGNED NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(24) NOT NULL,
  payment_channel VARCHAR(40) NOT NULL,
  payment_method VARCHAR(60) NULL,
  receiver_name VARCHAR(160) NULL,
  trx_id VARCHAR(100) NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payment_events_payment (payment_id, created_at),
  INDEX idx_payment_events_reseller (reseller_id, created_at)
);

CREATE TABLE IF NOT EXISTS recharge_vouchers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code_hash CHAR(64) NOT NULL UNIQUE,
  code_ciphertext TEXT NULL,
  code_suffix CHAR(4) NOT NULL,
  router_id INT UNSIGNED NOT NULL,
  package_name VARCHAR(120) NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  duration_days SMALLINT UNSIGNED NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  status ENUM('available', 'used', 'void') NOT NULL DEFAULT 'available',
  redeemed_customer_id INT UNSIGNED NULL,
  redeemed_customer_username VARCHAR(120) NULL,
  redeemed_reseller_id INT UNSIGNED NULL,
  payment_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  redeemed_at TIMESTAMP NULL,
  INDEX idx_voucher_status_created (status, created_at),
  INDEX idx_voucher_redeemed_reseller (redeemed_reseller_id, redeemed_at)
);

CREATE TABLE IF NOT EXISTS admins (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(180) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'superadmin',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

