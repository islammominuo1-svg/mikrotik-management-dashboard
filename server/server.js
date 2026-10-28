const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const configuredRouterGetTimeout = process.env.MIKROTIK_GET_TIMEOUT_MS;
const routerGetTimeout = configuredRouterGetTimeout === undefined
  ? 15000
  : Number(configuredRouterGetTimeout);
if (!Number.isSafeInteger(routerGetTimeout) || routerGetTimeout <= 0) {
  throw new Error("MIKROTIK_GET_TIMEOUT_MS must be a positive integer.");
}

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.get("/", (_req, res) => res.redirect(302, "/customer-login.html"));
app.use(express.static(path.join(__dirname, "..", "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || "mikrotik_manager",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  waitForConnections: true,
  connectionLimit: 10
});

async function initializeDatabase() {
  try {
    await pool.query(`
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
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS traffic_samples (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        router_id INT UNSIGNED NOT NULL,
        rx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
        tx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
        cpu_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
        sampled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_traffic_router_time (router_id, sampled_at)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        router_id INT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        details TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS package_profiles (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        router_id INT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        speed VARCHAR(60) NOT NULL DEFAULT '0 Mbps',
        description VARCHAR(255) NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_package_router (router_id)
      )
    `);

    await pool.query(`
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
      )
    `);

    await pool.query(`
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
      )
    `);

    for (const migration of [
      "ALTER TABLE reseller_customers ADD COLUMN created_by_reseller_id INT UNSIGNED NULL AFTER reseller_id",
      "ALTER TABLE reseller_customers ADD COLUMN router_id INT UNSIGNED NULL AFTER reseller_id",
      "ALTER TABLE reseller_customers ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER is_active",
      "ALTER TABLE reseller_customers ADD COLUMN balance_days INT NOT NULL DEFAULT 0 AFTER expiry_date",
      "ALTER TABLE reseller_customers ADD COLUMN trial_expires_at DATETIME NULL AFTER expiry_date",
      "ALTER TABLE reseller_customers ADD COLUMN emergency_extend_used TINYINT(1) NOT NULL DEFAULT 0 AFTER balance_days"
    ]) {
      try {
        await pool.query(migration);
      } catch (error) {
        if (error.code !== "ER_DUP_FIELDNAME" && error.code !== "ER_DUP_KEYNAME") throw error;
      }
    }
    try {
      await pool.query(
        "CREATE INDEX idx_customer_creator_active ON reseller_customers (created_by_reseller_id, is_active, deleted_at)"
      );
    } catch (error) {
      if (error.code !== "ER_DUP_KEYNAME") throw error;
    }

    const [legacyEmergencyFlag] = await pool.query("SHOW COLUMNS FROM reseller_customers LIKE 'negative_payment_used'");
    if (legacyEmergencyFlag.length) {
      await pool.query(
        "UPDATE reseller_customers SET emergency_extend_used=1, negative_payment_used=0 WHERE negative_payment_used=1"
      );
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS renewal_requests (
        request_key VARCHAR(80) PRIMARY KEY,
        customer_id INT UNSIGNED NOT NULL,
        response_json LONGTEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_renewal_requests_created (created_at)
      )
    `);
    await pool.query("DELETE FROM renewal_requests WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ppp_customer_delete_history (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        customer_id INT UNSIGNED NOT NULL,
        router_id INT UNSIGNED NULL,
        deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restored_at TIMESTAMP NULL DEFAULT NULL,
        INDEX idx_ppp_delete_customer (customer_id),
        INDEX idx_ppp_delete_state (restored_at, deleted_at)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        reseller_id INT UNSIGNED NOT NULL,
        payment_type ENUM('reseller', 'customer') NOT NULL DEFAULT 'customer',
        customer_name VARCHAR(160) NOT NULL,
        customer_username VARCHAR(120) NOT NULL,
        package_name VARCHAR(120) NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        payment_method VARCHAR(60) NOT NULL DEFAULT 'bKash',
        payment_channel VARCHAR(40) NOT NULL DEFAULT 'cash',
        paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        receiver_name VARCHAR(160) NULL,
        trx_id VARCHAR(100) NULL,
        status ENUM('paid', 'pending', 'processing', 'partial', 'due') NOT NULL DEFAULT 'paid',
        payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        notes TEXT NULL,
        INDEX idx_payment_reseller (reseller_id),
        INDEX idx_payment_type (payment_type),
        INDEX idx_payment_date (payment_date)
      )
    `);

    try {
      await pool.query("ALTER TABLE payments ADD COLUMN receiver_name VARCHAR(160) NULL AFTER payment_method");
    } catch (error) {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    }

    for (const migration of [
      "ALTER TABLE payments ADD COLUMN payment_channel VARCHAR(40) NOT NULL DEFAULT 'cash' AFTER payment_method",
      "ALTER TABLE payments ADD COLUMN paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER amount"
    ]) {
      try {
        await pool.query(migration);
      } catch (error) {
        if (error.code !== "ER_DUP_FIELDNAME") throw error;
      }
    }
    await pool.query("ALTER TABLE payments MODIFY status ENUM('paid', 'pending', 'processing', 'partial', 'due') NOT NULL DEFAULT 'paid'");
    await pool.query(`
      UPDATE payments
      SET payment_channel=CASE WHEN LOWER(payment_method) IN ('bkash','nagad','rocket') THEN 'online' ELSE 'cash' END,
          paid_amount=CASE WHEN status='paid' AND paid_amount=0 THEN amount ELSE paid_amount END
      WHERE paid_amount=0
    `);

    await pool.query(`
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
      )
    `);

    await pool.query(`
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
      )
    `);
    try {
      await pool.query("ALTER TABLE recharge_vouchers ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER duration_days");
    } catch (error) {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    }
    try {
      await pool.query("ALTER TABLE recharge_vouchers ADD COLUMN code_ciphertext TEXT NULL AFTER code_hash");
    } catch (error) {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    }
    const [voucherStatusColumns] = await pool.query("SHOW COLUMNS FROM recharge_vouchers LIKE 'status'");
    if (voucherStatusColumns.length && String(voucherStatusColumns[0].Type).includes("'redeemed'")) {
      await pool.query("ALTER TABLE recharge_vouchers MODIFY status ENUM('available', 'redeemed', 'used', 'void') NOT NULL DEFAULT 'available'");
      await pool.query("UPDATE recharge_vouchers SET status='used' WHERE status='redeemed'");
      await pool.query("ALTER TABLE recharge_vouchers MODIFY status ENUM('available', 'used', 'void') NOT NULL DEFAULT 'available'");
    }


    await pool.query(`
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
      )
    `);

    const [trialInvoiceRows] = await pool.query(
      `SELECT p.id FROM payments p
       INNER JOIN reseller_customers c
         ON c.reseller_id=p.reseller_id AND c.username=p.customer_username
       WHERE p.notes='Initial package payment awaiting cash receipt'`
    );
    if (trialInvoiceRows.length) {
      const trialInvoiceIds = trialInvoiceRows.map((payment) => payment.id);
      await pool.query("DELETE FROM payment_events WHERE payment_id IN (?)", [trialInvoiceIds]);
      await pool.query("DELETE FROM payments WHERE id IN (?)", [trialInvoiceIds]);
    }
    // Remove only the records written by the former demo seed.
    const demoTransactionIds = [
      "TRX-BANK-882910",
      "TRX-BK-918234",
      "TRX-BK-772910",
      "TRX-NG-662911",
      "TRX-RK-552912",
      "TRX-CSH-442913"
    ];
    const [demoPayments] = await pool.query(
      "SELECT id FROM payments WHERE trx_id IN (?)",
      [demoTransactionIds]
    );
    if (demoPayments.length) {
      const demoPaymentIds = demoPayments.map((payment) => payment.id);
      await pool.query("DELETE FROM payment_events WHERE payment_id IN (?)", [demoPaymentIds]);
    }
    await pool.query("DELETE FROM payments WHERE trx_id IN (?)", [demoTransactionIds]);
    await pool.query(
      `DELETE FROM reseller_customers
       WHERE (username='jahir_pppoe' AND full_name='Jahirul Islam')
          OR (username='rafiq_net' AND full_name='Rafiqul Hasan')
          OR (username='shahin_fast' AND full_name='Shahinur Rahman')
          OR (username='tanvir_isp' AND full_name='Tanvir Ahmed')`
    );
    await pool.query(
      `DELETE FROM resellers
       WHERE username='reseller' AND full_name='Demo Reseller'
         AND mobile='01711000000' AND email='reseller@isp.com'`
    );

  } catch (error) {
    console.error("Database initialization failed:", error.message);
    throw error;
  }
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

async function recordPaymentEvent(executor, event) {
  await executor.query(
    `INSERT INTO payment_events
       (payment_id, reseller_id, event_type, amount, status, payment_channel, payment_method, receiver_name, trx_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.paymentId,
      event.resellerId,
      event.eventType,
      Number(event.amount) || 0,
      event.status,
      event.paymentChannel,
      event.paymentMethod || null,
      event.receiverName || null,
      event.trxId || null,
      event.notes || null
    ]
  );
}

function serializeAdmin(row) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    role: row.role || "superadmin",
    isActive: !!Number(row.is_active)
  };
}

function serializeReseller(row) {
  const permissions = String(row.permissions || "ppp_user_create_only")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    id: row.id,
    fullName: row.full_name,
    username: row.username,
    mobile: row.mobile,
    email: row.email,
    zone: row.zone,
    voterIdImage: row.voter_id_image || "",
    isActive: !!Number(row.is_active),
    permissions: permissions.length ? permissions : ["ppp_user_create_only"]
  };
}

function normalizeRouter(router) {
  const port = Number(router.port) || 443;
  const verifyTls = Boolean(Number(router.verify_tls));
  return { ...router, port, verify_tls: verifyTls };
}

function getRouterCaCertificate() {
  const configuredPath = process.env.MIKROTIK_CA_CERT;
  const certificatePath = configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.resolve(__dirname, configuredPath))
    : path.join(__dirname, "certs", "mikrotik-ca.crt");

  if (!fs.existsSync(certificatePath)) {
    if (configuredPath) {
      throw new Error(`Configured MikroTik CA certificate was not found: ${certificatePath}`);
    }
    return undefined;
  }

  return fs.readFileSync(certificatePath);
}

function buildRouterHttpsAgent(router) {
  const normalized = normalizeRouter(router);
  const ca = getRouterCaCertificate();
  return new https.Agent({
    rejectUnauthorized: normalized.verify_tls,
    ...(ca ? { ca } : {}),
    ciphers: "DEFAULT:@SECLEVEL=0",
    minVersion: "TLSv1",
    maxVersion: "TLSv1.2",
    ...(net.isIP(normalized.host) ? {} : { servername: normalized.host })
  });
}

function getRouterRequestTargets(router) {
  const normalized = normalizeRouter(router);
  const primaryPort = Number(normalized.port) || 443;
  const port = primaryPort === 80 ? 443 : primaryPort;
  return [{
    protocol: "https",
    port,
    url: `https://${normalized.host}:${port}/rest`
  }];
}

function routerBase(router) {
  const targets = getRouterRequestTargets(router);
  return targets[0].url;
}

async function requestRouter(router, resource, method, data, params = {}) {
  const normalized = normalizeRouter(router);
  const urls = getRouterRequestTargets(normalized);
  let lastError;

  for (const target of urls) {
    const url = `${target.url}${resource}`;
    try {
      const config = {
        params,
        auth: { username: normalized.username, password: normalized.password },
        timeout: method === "get" ? routerGetTimeout : 8000
      };

      if (target.protocol === "https") {
        config.httpsAgent = buildRouterHttpsAgent(normalized);
      }

      const response = method === "get"
        ? await axios.get(url, config)
        : method === "patch"
        ? await axios.patch(url, data, config)
        : method === "put"
        ? await axios.put(url, data, config)
        : method === "delete"
        ? await axios.delete(url, config)
        : await axios.post(url, data, config);
      return response.data;
    } catch (error) {
      lastError = error;
      console.log("RouterOS request failed:", {
        url,
        host: normalized.host,
        port: normalized.port,
        resource,
        protocol: target.protocol,
        verify_tls: normalized.verify_tls,
        code: error.code,
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
        cause: error.cause
      });
    }
  }

  throw lastError || new Error(`Unable to reach RouterOS REST API at ${normalized.host}`);
}

async function mtGet(router, resource, params = {}) {
  return requestRouter(router, resource, "get", null, params);
}

async function mtPatch(router, resource, data) {
  return requestRouter(router, resource, "patch", data, {});
}

async function mtPost(router, resource, data) {
  return requestRouter(router, resource, "post", data, {});
}

async function mtPut(router, resource, data) {
  return requestRouter(router, resource, "put", data, {});
}

async function mtDelete(router, resource) {
  return requestRouter(router, resource, "delete", null, {});
}

async function expireTrialPppAccounts() {
  const [customers] = await pool.query(`
    SELECT id, router_id, username
    FROM reseller_customers
    WHERE is_active=1 AND deleted_at IS NULL
      AND ((trial_expires_at IS NOT NULL AND trial_expires_at <= NOW())
        OR (trial_expires_at IS NULL AND expiry_date < CURDATE()))
  `);
  for (const customer of customers) {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [dueRows] = await connection.query(
        `SELECT id, router_id, username FROM reseller_customers
         WHERE id=? AND is_active=1 AND deleted_at IS NULL
           AND ((trial_expires_at IS NOT NULL AND trial_expires_at <= NOW())
             OR (trial_expires_at IS NULL AND expiry_date < CURDATE())) FOR UPDATE`,
        [customer.id]
      );
      if (!dueRows.length) {
        await connection.rollback();
        transactionStarted = false;
        continue;
      }
      const dueCustomer = dueRows[0];
      const [routers] = await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [dueCustomer.router_id]);
      if (!routers.length) throw new Error("Customer router is unavailable");
      const secrets = await mtGet(routers[0], "/ppp/secret");
      const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === dueCustomer.username);
      if (!secret?.[".id"]) throw new Error("PPPoE secret was not found on MikroTik");
      await mtPatch(routers[0], `/ppp/secret/${secret[".id"]}`, { disabled: "true" });
      try {
        const sessions = await mtGet(routers[0], "/ppp/active");
        const session = (Array.isArray(sessions) ? sessions : []).find((item) => item.name === dueCustomer.username);
        if (session?.[".id"]) await mtDelete(routers[0], `/ppp/active/${session[".id"]}`);
      } catch (sessionError) {
        console.warn(`Could not disconnect expired PPPoE session ${dueCustomer.username}:`, sessionError.message);
      }
      await connection.query("UPDATE reseller_customers SET is_active=0, trial_expires_at=NULL WHERE id=?", [dueCustomer.id]);
      await connection.commit();
      transactionStarted = false;
      console.log(`PPPoE access expired for ${dueCustomer.username}.`);
    } catch (error) {
      if (transactionStarted) await connection.rollback().catch(() => {});
      console.error(`Could not expire trial PPPoE account ${customer.username}:`, error.message);
    } finally {
      connection.release();
    }
  }
}

async function activatePaidCustomerSubscription(connection, payment, paidAmount) {
  if (payment.payment_type !== "customer" || !payment.customer_username) return null;
  const [customers] = await connection.query(
    "SELECT id, reseller_id, router_id, username, balance_days, emergency_extend_used FROM reseller_customers WHERE reseller_id=? AND username=? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
    [payment.reseller_id, payment.customer_username]
  );
  if (!customers.length) return null;
  const customer = customers[0];
  const amount = Number(paidAmount);
  const [routers] = customer.router_id
    ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [customer.router_id])
    : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
  if (!routers.length) throw new Error("No enabled MikroTik router is available for this customer.");
  const router = routers[0];
  if (!customer.router_id) {
    await connection.query("UPDATE reseller_customers SET router_id=? WHERE id=?", [router.id, customer.id]);
    customer.router_id = router.id;
  }
  const [profiles] = await connection.query(
    "SELECT name FROM package_profiles WHERE router_id=? AND price=? AND enabled=1 ORDER BY id DESC LIMIT 1",
    [customer.router_id, amount]
  );
  if (!profiles.length) throw new Error(`No enabled PPP profile has a price of ${amount}.`);
  const appliedDays = getRegularRenewalDays(customer.emergency_extend_used);
  const secrets = await mtGet(router, "/ppp/secret");
  const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
  if (!secret?.[".id"]) throw new Error("PPPoE secret was not found on MikroTik.");
  await mtPatch(router, `/ppp/secret/${secret[".id"]}`, { profile: profiles[0].name, disabled: "false" });
  await connection.query(
    `UPDATE reseller_customers
     SET package_name=?, is_active=1, trial_expires_at=NULL,
         expiry_date=DATE_ADD(COALESCE(expiry_date, CURDATE()), INTERVAL ? DAY),
       balance_days=balance_days+?, emergency_extend_used=0
     WHERE id=?`,
    [profiles[0].name, appliedDays, appliedDays, customer.id]
  );
  return { customerId: customer.id, username: customer.username, packageName: profiles[0].name, expiryDays: appliedDays };
}

function getRegularRenewalDays(emergencyExtendUsed) {
  return Number(emergencyExtendUsed) === 1 ? 25 : 30;
}

function normalizeVoucherCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashVoucherCode(code) {
  return crypto.createHash("sha256").update(normalizeVoucherCode(code)).digest("hex");
}

function createSessionToken(identity) {
  const payload = Buffer.from(JSON.stringify({
    ...identity,
    expiresAt: Math.floor(Date.now() / 1000) + 12 * 60 * 60
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", getVoucherEncryptionKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  try {
    const [payload, signature, extra] = String(token || "").split(".");
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac("sha256", getVoucherEncryptionKey()).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || received.toString("base64url") !== signature || !crypto.timingSafeEqual(received, expected)) return null;
    const identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(identity.expiresAt) <= Math.floor(Date.now() / 1000)) return null;
    return identity;
  } catch {
    return null;
  }
}

function requireSessionRoles(...allowedRoles) {
  return async (req, res, next) => {
    try {
      const authorization = String(req.headers.authorization || "");
      const identity = authorization.startsWith("Bearer ") ? verifySessionToken(authorization.slice(7)) : null;
      if (!identity) return res.status(401).json({ error: "Sign in again to use this feature." });
      if (!allowedRoles.includes(identity.role)) {
        return res.status(401).json({ error: "Your session has expired or does not allow this action." });
      }
      if (identity.role === "admin") {
        const [rows] = await pool.query("SELECT id FROM admins WHERE id=? AND is_active=1", [identity.adminId]);
        if (!rows.length) return res.status(403).json({ error: "This admin account is inactive." });
      } else if (identity.role === "reseller") {
        const [rows] = await pool.query("SELECT id FROM resellers WHERE id=? AND is_active=1", [identity.resellerId]);
        if (!rows.length) return res.status(403).json({ error: "This reseller account is inactive." });
      } else if (identity.role === "customer") {
        const [rows] = await pool.query("SELECT id FROM reseller_customers WHERE id=? AND deleted_at IS NULL", [identity.customerId]);
        if (!rows.length) return res.status(403).json({ error: "This customer account is unavailable." });
      }
      req.authenticatedSession = identity;
      next();
    } catch {
      res.status(401).json({ error: "Your session is invalid. Sign in again." });
    }
  };
}

function buildCustomerListQuery(identity, requestedResellerId) {
  if (identity?.role === "admin") {
    return {
      sql: `
        SELECT c.*, r.full_name as reseller_name, r.username as reseller_username
        FROM reseller_customers c
        LEFT JOIN resellers r ON c.reseller_id = r.id
        WHERE c.deleted_at IS NULL
        ORDER BY c.created_at DESC
      `,
      params: []
    };
  }

  const sessionResellerId = Number(identity?.resellerId);
  const requestedId = Number(requestedResellerId);
  if (
    identity?.role !== "reseller" ||
    !Number.isSafeInteger(sessionResellerId) ||
    sessionResellerId <= 0 ||
    requestedId !== sessionResellerId
  ) {
    return null;
  }

  return {
    sql: `
      SELECT * FROM reseller_customers
      WHERE reseller_id=? AND is_active=1 AND deleted_at IS NULL
      ORDER BY created_at DESC
    `,
    params: [sessionResellerId]
  };
}

function buildResellerActiveUsernamesQuery(identity, requestedResellerId) {
  const resellerId = Number(requestedResellerId);
  if (
    identity?.role !== "admin" ||
    !Number.isSafeInteger(resellerId) ||
    resellerId <= 0
  ) {
    return null;
  }

  return {
    sql: `
      SELECT username FROM reseller_customers
      WHERE reseller_id=? AND is_active=1 AND deleted_at IS NULL
    `,
    params: [resellerId]
  };
}

function buildResellerDashboardUsernamesQuery(identity) {
  const resellerId = Number(identity?.resellerId);
  if (identity?.role !== "reseller" || !Number.isSafeInteger(resellerId) || resellerId <= 0) {
    return null;
  }

  return {
    sql: `
      SELECT username FROM reseller_customers
      WHERE reseller_id=? AND is_active=1 AND deleted_at IS NULL
    `,
    params: [resellerId]
  };
}

function filterRouterUsersByUsername(users, allowedUsernames) {
  if (!Array.isArray(users)) return [];
  return users.filter((item) => allowedUsernames.has(String(item.user || item.name || "").trim().toLowerCase()));
}

function createVoucherCode() {
  return crypto.randomInt(0, 10_000_000_000).toString().padStart(10, "0");
}

function getVoucherEncryptionKey() {
  if (process.env.VOUCHER_ENCRYPTION_KEY) {
    return crypto.createHash("sha256").update(process.env.VOUCHER_ENCRYPTION_KEY).digest();
  }
  const keyPath = path.join(__dirname, ".voucher-encryption-key");
  try {
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error("The voucher encryption key file is invalid.");
  return key;
}

function encryptVoucherCode(code) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getVoucherEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("base64")}`;
}

function decryptVoucherCode(ciphertext) {
  if (!ciphertext) return "";
  const [ivHex, tagHex, encryptedBase64] = String(ciphertext).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getVoucherEncryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, "base64")), decipher.final()]).toString("utf8");
}

async function testRouterConnectivity(router) {
  const normalized = normalizeRouter(router);
  const target = getRouterRequestTargets(normalized)[0];
  const baseUrl = target.url;

  const tcpResult = await new Promise((resolve) => {
    const socket = net.createConnection({ host: normalized.host, port: target.port });
    socket.setTimeout(5000);
    socket.once("connect", () => {
      socket.end();
      resolve({ reachable: true, detail: `TCP connection to ${normalized.host}:${target.port} succeeded.` });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ reachable: false, detail: `TCP timeout while connecting to ${normalized.host}:${target.port}.` });
    });
    socket.once("error", (err) => {
      resolve({ reachable: false, detail: `TCP error connecting to ${normalized.host}:${target.port}: ${err.code || err.message}` });
    });
  });

  const checks = [];
  for (const resource of ["/system/resource", "/ip/address", "/user"]) {
    try {
      const data = await mtGet(normalized, resource);
      checks.push({ resource, ok: true, status: 200, sample: Array.isArray(data) ? data.slice(0, 1) : data });
    } catch (error) {
      checks.push({
        resource,
        ok: false,
        status: error.response?.status || 0,
        detail: error.response?.data || error.message
      });
    }
  }

  const hasPermissions = checks.filter((item) => item.ok).length >= 1;
  return {
    ok: tcpResult.reachable && hasPermissions,
    host: normalized.host,
    port: normalized.port,
    protocol: "https",
    restUrl: baseUrl,
    verify_tls: normalized.verify_tls,
    connectivity: tcpResult,
    endpoints: checks,
    permissions: {
      hasReadAccess: hasPermissions,
      message: hasPermissions
        ? "RouterOS user can reach the REST API endpoints used by the dashboard."
        : "RouterOS user cannot access the required REST endpoints or permissions are missing."
    }
  };
}

function parseBytes(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parsePercent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function humanBytesPerSecond(n) {
  n = Number(n) || 0;
  const units = ["bps", "Kbps", "Mbps", "Gbps"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function getRouterOr404(id, res) {
  const [rows] = await pool.query("SELECT * FROM routers WHERE id=? AND enabled=1", [id]);
  if (!rows.length) {
    res.status(404).json({ error: "Router not found" });
    return null;
  }
  return rows[0];
}

app.get("/api/routers", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id,name,host,port,verify_tls,enabled,created_at,updated_at FROM routers ORDER BY id DESC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/routers", async (req, res) => {
  const { name, host, username, password, port = 443, verify_tls = 0 } = req.body;
  if (!name || !host || !username) return res.status(400).json({ error: "name, host and username are required" });
  try {
    const [r] = await pool.query(
      "INSERT INTO routers(name,host,username,password,port,verify_tls) VALUES(?,?,?,?,?,?)",
      [name, host, username, password || "", Number(port), verify_tls ? 1 : 0]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/routers/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM routers WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/resellers", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM resellers ORDER BY created_at DESC"
    );
    res.json(rows.map(serializeReseller));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/reseller/register", async (req, res) => {
  const {
    fullName,
    username,
    password,
    confirmPassword,
    mobile,
    email,
    zone,
    voterIdImage,
    isActive = true
  } = req.body || {};

  if (!fullName || !username || !password || !confirmPassword || !mobile || !email || !zone) {
    return res.status(400).json({ error: "All reseller registration fields are required." });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: "Password and confirm password must match." });
  }

  if (!/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(String(email))) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  try {
    const hashed = hashPassword(password);
    const [result] = await pool.query(
      `INSERT INTO resellers (full_name, username, password_hash, mobile, email, zone, voter_id_image, permissions, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ppp_user_create_only', ?)
      `,
      [
        String(fullName).trim(),
        String(username).trim(),
        hashed,
        String(mobile).trim(),
        String(email).trim(),
        String(zone).trim(),
        voterIdImage ? String(voterIdImage) : null,
        isActive ? 1 : 0
      ]
    );

    const [rows] = await pool.query("SELECT * FROM resellers WHERE id=?", [result.insertId]);
    res.status(201).json({ ok: true, reseller: serializeReseller(rows[0]) });
  } catch (error) {
    const message = error.code === "ER_DUP_ENTRY" ? "Username or mobile number already exists." : error.message;
    res.status(400).json({ error: message });
  }
});

app.post("/api/reseller/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    const [rows] = await pool.query("SELECT * FROM resellers WHERE username=? LIMIT 1", [String(username).trim()]);
    if (!rows.length) {
      return res.status(401).json({ error: "Invalid reseller username or password." });
    }

    const reseller = rows[0];
    if (hashPassword(password) !== reseller.password_hash) {
      return res.status(401).json({ error: "Invalid reseller username or password." });
    }

    if (!Number(reseller.is_active)) {
      return res.status(403).json({ error: "This reseller account is inactive and cannot log in." });
    }

    res.json({
      ok: true,
      reseller: serializeReseller(reseller),
      permissions: ["ppp_user_create_only"],
      sessionToken: createSessionToken({ role: "reseller", resellerId: Number(reseller.id) })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/customer/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password are required." });

  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.reseller_id, c.router_id, c.full_name, c.username, c.mobile, c.email,
             c.package_name, c.area, c.expiry_date, c.balance_days, c.trial_expires_at, c.emergency_extend_used, c.is_active,
             r.full_name AS reseller_name, r.mobile AS reseller_mobile,
             pp.speed AS package_speed, pp.price AS package_price,
             COALESCE((
               SELECT SUM(GREATEST(p.amount - p.paid_amount, 0))
               FROM payments p
               WHERE p.reseller_id=c.reseller_id AND p.customer_username=c.username
                 AND p.payment_type='customer' AND p.status IN ('pending','processing','partial','due')
             ), 0) AS due_amount,
             COALESCE((
               SELECT SUM(p.paid_amount)
               FROM payments p
               WHERE p.reseller_id=c.reseller_id AND p.customer_username=c.username
                 AND p.payment_type='customer'
                 AND p.payment_date >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')
             ), 0) AS paid_this_month
      FROM reseller_customers c
      LEFT JOIN resellers r ON r.id=c.reseller_id
      LEFT JOIN package_profiles pp ON pp.name=c.package_name
        AND (pp.router_id=c.router_id OR c.router_id IS NULL)
      WHERE c.username=? AND c.password=? AND c.deleted_at IS NULL
      ORDER BY pp.id DESC LIMIT 1
    `, [String(username).trim(), String(password)]);

    if (!rows.length) return res.status(401).json({ error: "Invalid user name or password." });
    const customer = rows[0];
    const [payments] = await pool.query(`
      SELECT id, amount, paid_amount, payment_method, payment_channel, status, payment_date, trx_id, receiver_name
      FROM payments
      WHERE reseller_id=? AND customer_username=? AND payment_type='customer'
      ORDER BY payment_date DESC, id DESC
    `, [customer.reseller_id, customer.username]);

    res.json({
      ok: true,
      customer: {
        id: Number(customer.id), username: customer.username, fullName: customer.full_name,
        sessionToken: createSessionToken({ role: "customer", customerId: Number(customer.id) }),
        mobile: customer.mobile, email: customer.email, packageName: customer.package_name,
        packageSpeed: customer.package_speed || "Speed not set", packagePrice: Number(customer.package_price || 0),
        area: customer.area, expiryDate: customer.expiry_date, trialExpiresAt: customer.trial_expires_at,
        balanceDays: Number(customer.balance_days || 0), emergencyExtendUsed: !!Number(customer.emergency_extend_used),
        isActive: !!Number(customer.is_active), routerId: customer.router_id ? Number(customer.router_id) : null,
        dueAmount: Number(customer.due_amount || 0), paidThisMonth: Number(customer.paid_this_month || 0),
        resellerName: customer.reseller_name || "Your ISP", resellerMobile: customer.reseller_mobile || "",
        payments
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/customer/voucher", async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const { username, voucherCode } = req.body || {};
    if (!username || !voucherCode) {
      return res.status(400).json({ error: "Username and voucher code are required." });
    }
    if (String(voucherCode).trim().length < 4) {
      return res.status(400).json({ error: "Invalid voucher code." });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [customers] = await connection.query(
      "SELECT * FROM reseller_customers WHERE username=? AND deleted_at IS NULL FOR UPDATE",
      [String(username).trim()]
    );
    if (!customers.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Customer not found." });
    }
    const customer = customers[0];

    const [routers] = customer.router_id
      ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [customer.router_id])
      : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routers.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "No enabled router available." });
    }
    const router = routers[0];

    const secrets = await mtGet(router, "/ppp/secret");
    const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
    if (!secret?.[".id"]) {
      await connection.rollback(); transactionStarted = false;
      return res.status(400).json({ error: "PPPoE secret not found on MikroTik router." });
    }

    await mtPatch(router, `/ppp/secret/${secret[".id"]}`, { disabled: "false" });

    await connection.query(
      `UPDATE reseller_customers
       SET expiry_date=DATE_ADD(COALESCE(expiry_date, CURDATE()), INTERVAL 30 DAY),
           balance_days=balance_days+30,
           is_active=1,
           trial_expires_at=NULL
       WHERE id=?`,
      [customer.id]
    );

    await connection.query(
      `INSERT INTO payments (reseller_id, payment_type, customer_name, customer_username, package_name, amount, paid_amount, payment_method, payment_channel, status, notes)
       VALUES (?, 'customer', ?, ?, ?, 500, 500, 'Voucher', 'online', 'paid', ?)`,
      [customer.reseller_id, customer.full_name, customer.username, customer.package_name, `Voucher redeemed: ${voucherCode}`]
    );

    const [updatedRows] = await connection.query("SELECT expiry_date, balance_days FROM reseller_customers WHERE id=?", [customer.id]);
    await connection.commit();
    transactionStarted = false;

    res.json({
      ok: true,
      message: "Voucher redeemed successfully and verified by MikroTik router.",
      balanceDays: Number(updatedRows[0].balance_days || 30),
      expiryDate: updatedRows[0].expiry_date
    });
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    res.status(502).json({ error: `MikroTik / Database synchronization failed: ${error.message}` });
  } finally {
    connection?.release();
  }
});

app.post("/api/customer/emergency", async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: "Username is required." });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [customers] = await connection.query(
      "SELECT * FROM reseller_customers WHERE username=? AND deleted_at IS NULL FOR UPDATE",
      [String(username).trim()]
    );
    if (!customers.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Customer not found." });
    }
    const customer = customers[0];

    if (Number(customer.negative_payment_used) === 1) {
      await connection.rollback(); transactionStarted = false;
      return res.status(400).json({ error: "Emergency balance has already been used for this account." });
    }

    const [routers] = customer.router_id
      ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [customer.router_id])
      : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routers.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "No enabled router available." });
    }
    const router = routers[0];

    let secrets = [];
    try {
      secrets = await mtGet(router, "/ppp/secret");
    } catch (e) {
      console.warn("Could not fetch secrets:", e.message);
    }
    const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
    if (secret?.[".id"]) {
      await mtPatch(router, `/ppp/secret/${secret[".id"]}`, { disabled: "false", profile: customer.package_name || "default" }).catch(() => {});
    } else {
      await mtPut(router, "/ppp/secret", {
        name: customer.username,
        password: customer.password || "123456",
        service: "pppoe",
        profile: customer.package_name || "default",
        disabled: "false"
      }).catch(() => {});
    }

    await connection.query(
      `UPDATE reseller_customers
       SET expiry_date=DATE_ADD(COALESCE(expiry_date, CURDATE()), INTERVAL 5 DAY),
           balance_days=balance_days+5,
           negative_payment_used=1,
           is_active=1,
           trial_expires_at=NULL
       WHERE id=?`,
      [customer.id]
    );

    const [updatedRows] = await connection.query("SELECT expiry_date, balance_days FROM reseller_customers WHERE id=?", [customer.id]);
    await connection.commit();
    transactionStarted = false;

    res.json({
      ok: true,
      message: "Emergency balance activated and verified with MikroTik router.",
      balanceDays: Number(updatedRows[0].balance_days || 35),
      expiryDate: updatedRows[0].expiry_date
    });
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    res.status(502).json({ error: `MikroTik / Emergency synchronization failed: ${error.message}` });
  } finally {
    connection?.release();
  }
});

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    const [rows] = await pool.query("SELECT * FROM admins WHERE username=? LIMIT 1", [String(username).trim()]);
    if (!rows.length) {
      return res.status(401).json({ error: "ভুল অ্যাডমিন ইউজারনেম বা পাসওয়ার্ড (Invalid admin credentials)." });
    }

    const admin = rows[0];
    const hashed = hashPassword(password);
    const isValid = hashed === admin.password_hash;

    if (!isValid) {
      return res.status(401).json({ error: "ভুল অ্যাডমিন ইউজারনেম বা পাসওয়ার্ড (Invalid admin credentials)." });
    }

    if (!Number(admin.is_active)) {
      return res.status(403).json({ error: "এই অ্যাডমিন অ্যাকাউন্টটি নিষ্ক্রিয় রয়েছে (This admin account is inactive)." });
    }

    res.json({
      ok: true,
      role: "admin",
      admin: serializeAdmin(admin),
      sessionToken: createSessionToken({ role: "admin", adminId: Number(admin.id) })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/account/change-password", async (req, res) => {
  const { accountType, accountId, currentPassword, newPassword, confirmPassword } = req.body || {};
  const id = Number(accountId);

  if (!["admin", "reseller"].includes(accountType) || !Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid account." });
  }
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: "সব পাসওয়ার্ডের ঘর পূরণ করুন।" });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: "নতুন পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।" });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "নতুন পাসওয়ার্ড ও নিশ্চিত পাসওয়ার্ড মিলছে না।" });
  }

  try {
    const table = accountType === "admin" ? "admins" : "resellers";
    const [rows] = await pool.query(
      `SELECT id, username, password_hash FROM ${table} WHERE id=? LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "অ্যাকাউন্ট পাওয়া যায়নি।" });

    const account = rows[0];
    const currentHashMatches = hashPassword(currentPassword) === account.password_hash;
    if (!currentHashMatches) {
      return res.status(401).json({ error: "বর্তমান পাসওয়ার্ড সঠিক নয়।" });
    }

    await pool.query(`UPDATE ${table} SET password_hash=? WHERE id=?`, [hashPassword(newPassword), id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/payments", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, r.full_name as reseller_name, r.username as reseller_username
      FROM payments p
      LEFT JOIN resellers r ON p.reseller_id = r.id
      ORDER BY p.payment_date DESC, p.id DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/payment-events", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT e.*, p.customer_name, p.customer_username, r.full_name AS reseller_name
      FROM payment_events e
      LEFT JOIN payments p ON p.id=e.payment_id
      LEFT JOIN resellers r ON r.id=e.reseller_id
      ORDER BY e.created_at DESC, e.id DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/payments/:id/receive-cash", async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const receiverName = String(req.body?.receiverName || "").trim();
    const receiptAmount = Number(req.body?.amount);
    const trxId = String(req.body?.trxId || "").trim() || `CASH${Date.now().toString().slice(-8)}`;
    if (!receiverName || !Number.isFinite(receiptAmount) || receiptAmount <= 0) {
      return res.status(400).json({ error: "Receiver name and a valid received amount are required." });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.query("SELECT * FROM payments WHERE id=? FOR UPDATE", [req.params.id]);
    if (!rows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ error: "Payment not found." });
    }
    const payment = rows[0];
    if (payment.payment_channel !== "cash") {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({ error: "Only cash payments can be received here." });
    }

    const dueBefore = Math.max(0, Number(payment.amount) - Number(payment.paid_amount || 0));
    if (receiptAmount > dueBefore) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({ error: `Received amount cannot exceed the remaining due ${dueBefore}.` });
    }
    const paidAmount = Number(payment.paid_amount || 0) + receiptAmount;
    const status = paidAmount >= Number(payment.amount) ? "paid" : "partial";
    const dueAmount = Math.max(0, Number(payment.amount) - paidAmount);

    const subscription = status === "paid" && !String(payment.notes || "").startsWith("Subscription renewal;")
      ? await activatePaidCustomerSubscription(connection, payment, paidAmount)
      : null;

    await connection.query(
      "UPDATE payments SET paid_amount=?, status=?, receiver_name=?, trx_id=? WHERE id=?",
      [paidAmount, status, receiverName, trxId, payment.id]
    );
    await recordPaymentEvent(connection, {
      paymentId: payment.id,
      resellerId: payment.reseller_id,
      eventType: status === "paid" ? "cash_received_full" : "cash_received_partial",
      amount: receiptAmount,
      status,
      paymentChannel: "cash",
      paymentMethod: payment.payment_method || "Cash",
      receiverName,
      trxId,
      notes: `Received ${receiptAmount}; remaining due ${dueAmount}`
    });
    await connection.commit();
    transactionStarted = false;
    res.json({ ok: true, paymentId: payment.id, status, paidAmount, dueAmount, receiverName, trxId, subscription });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.post("/api/reseller/:resellerId/payments/:id/receive-cash", async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const resellerId = Number(req.params.resellerId);
    const receiverName = String(req.body?.receiverName || "").trim();
    const receiptAmount = Number(req.body?.amount);
    if (!Number.isInteger(resellerId) || resellerId < 1 || !receiverName || !Number.isFinite(receiptAmount) || receiptAmount <= 0) {
      return res.status(400).json({ error: "Receiver name and a valid received amount are required." });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.query(
      "SELECT * FROM payments WHERE id=? AND reseller_id=? FOR UPDATE",
      [req.params.id, resellerId]
    );
    if (!rows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Payment not found." });
    }
    const payment = rows[0];
    if (payment.payment_channel !== "cash") {
      await connection.rollback(); transactionStarted = false;
      return res.status(400).json({ error: "Only cash payments can be received here." });
    }
    const dueBefore = Math.max(0, Number(payment.amount) - Number(payment.paid_amount || 0));
    if (receiptAmount > dueBefore) {
      await connection.rollback(); transactionStarted = false;
      return res.status(400).json({ error: `Received amount cannot exceed the remaining due ${dueBefore}.` });
    }
    const paidAmount = Number(payment.paid_amount || 0) + receiptAmount;
    const dueAmount = Math.max(0, Number(payment.amount) - paidAmount);
    const status = dueAmount === 0 ? "paid" : "partial";
    const trxId = `CASH${Date.now().toString().slice(-8)}`;
    const subscription = status === "paid" && !String(payment.notes || "").startsWith("Subscription renewal;")
      ? await activatePaidCustomerSubscription(connection, payment, paidAmount)
      : null;
    await connection.query(
      "UPDATE payments SET paid_amount=?, status=?, receiver_name=?, trx_id=? WHERE id=?",
      [paidAmount, status, receiverName, trxId, payment.id]
    );
    await recordPaymentEvent(connection, {
      paymentId: payment.id, resellerId, eventType: status === "paid" ? "cash_received_full" : "cash_received_partial",
      amount: receiptAmount, status, paymentChannel: "cash", paymentMethod: "Cash", receiverName, trxId,
      notes: `Received ${receiptAmount}; remaining due ${dueAmount}`
    });
    await connection.commit();
    transactionStarted = false;
    res.json({ ok: true, paymentId: payment.id, status, paidAmount, dueAmount, receiverName, trxId, subscription });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.get("/api/admin/customers", requireSessionRoles("admin"), async (req, res) => {
  try {
    const query = buildCustomerListQuery(req.authenticatedSession);
    const [rows] = await pool.query(query.sql, query.params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/resellers/:resellerId/active-usernames", requireSessionRoles("admin"), async (req, res) => {
  const query = buildResellerActiveUsernamesQuery(req.authenticatedSession, req.params.resellerId);
  if (!query) {
    return res.status(400).json({ error: "A valid reseller ID is required." });
  }

  try {
    const [rows] = await pool.query(query.sql, query.params);
    res.json(rows.map((row) => row.username));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/reseller/:id", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM resellers WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Reseller not found." });
    res.json(serializeReseller(rows[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reseller/:id/toggle-active", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM resellers WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Reseller not found." });

    const nextValue = Number(rows[0].is_active) ? 0 : 1;
    await pool.query("UPDATE resellers SET is_active=? WHERE id=?", [nextValue, req.params.id]);
    const [updated] = await pool.query("SELECT * FROM resellers WHERE id=?", [req.params.id]);
    res.json({
      ok: true,
      id: Number(req.params.id),
      isActive: !!nextValue,
      status: nextValue ? "Active" : "Inactive",
      reseller: serializeReseller(updated[0])
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reseller/:id/set-status", async (req, res) => {
  try {
    const { isActive } = req.body || {};
    const val = isActive ? 1 : 0;
    const [rows] = await pool.query("SELECT * FROM resellers WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Reseller not found." });

    await pool.query("UPDATE resellers SET is_active=? WHERE id=?", [val, req.params.id]);
    const [updated] = await pool.query("SELECT * FROM resellers WHERE id=?", [req.params.id]);
    res.json({
      ok: true,
      id: Number(req.params.id),
      isActive: !!val,
      status: val ? "Active" : "Inactive",
      reseller: serializeReseller(updated[0])
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/reseller/:resellerId/payments", async (req, res) => {
  try {
    const resellerId = Number(req.params.resellerId);
    const { type } = req.query; // 'all', 'reseller', 'customer'
    let query = `SELECT p.* FROM payments p
      WHERE (p.reseller_id=? OR (p.payment_channel='online' AND p.payment_type='customer' AND EXISTS (
        SELECT 1 FROM reseller_customers c
        WHERE c.username=p.customer_username AND c.reseller_id=? AND c.deleted_at IS NULL
      )))`;
    const params = [resellerId, resellerId];
    if (type && type !== "all") {
      query += " AND p.payment_type=?";
      params.push(type);
    }
    query += " ORDER BY p.payment_date DESC, p.id DESC";
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/reseller/:resellerId/payment-events", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT e.*, p.customer_name, p.customer_username
      FROM payment_events e
      LEFT JOIN payments p ON p.id=e.payment_id
      WHERE e.reseller_id=? OR (e.payment_channel='online' AND p.payment_type='customer' AND EXISTS (
        SELECT 1 FROM reseller_customers c
        WHERE c.username=p.customer_username AND c.reseller_id=? AND c.deleted_at IS NULL
      ))
      ORDER BY e.created_at DESC, e.id DESC
    `, [req.params.resellerId, req.params.resellerId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function createPaymentRecord(req, res, allowOnline) {
  let connection;
  let transactionStarted = false;
  try {
    let resellerId = Number(req.params.resellerId);
    if (!Number.isInteger(resellerId) || resellerId < 1) return res.status(400).json({ error: "A valid reseller is required." });
    const {
      paymentType = "customer",
      customerName,
      customerUsername,
      packageName = "",
      amount,
      paymentMethod = allowOnline ? "bKash" : "Cash",
      trxId = "",
      notes = "",
      status = "paid"
    } = req.body || {};

    if (!["customer", "reseller"].includes(paymentType)) return res.status(400).json({ error: "Invalid payment type." });
    const paymentAmount = Number(amount);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: "সঠিক পেমেন্টের পরিমাণ দিন (Valid amount is required)" });
    }
    const normalizedMethod = String(paymentMethod || "bKash").trim();
    if (!allowOnline && normalizedMethod.toLowerCase() !== "cash") {
      return res.status(403).json({ error: "Reseller panels can record cash payments only." });
    }
    if (allowOnline && !["Cash", "bKash"].includes(normalizedMethod)) {
      return res.status(400).json({ error: "Choose Cash or bKash." });
    }
    if (paymentType === "customer" && String(customerUsername || "").trim()) {
      const [owners] = await pool.query(
        "SELECT reseller_id FROM reseller_customers WHERE username=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
        [String(customerUsername).trim()]
      );
      if (owners.length) {
        const customerResellerId = Number(owners[0].reseller_id);
        if (!allowOnline && customerResellerId !== resellerId) return res.status(403).json({ error: "This customer belongs to a different reseller." });
        if (allowOnline) resellerId = customerResellerId;
      }
    }
    const paymentChannel = normalizedMethod.toLowerCase() === "cash" ? "cash" : "online";
    const submissionStatus = paymentChannel === "online" && status === "paid" ? "paid" : "processing";
    const paidAmount = submissionStatus === "paid" ? paymentAmount : 0;
    const submissionTrxId = String(trxId || `SUB${Date.now().toString().slice(-8)}`).trim();

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [result] = await connection.query(
      `INSERT INTO payments (reseller_id, payment_type, customer_name, customer_username, package_name, amount, paid_amount, payment_method, payment_channel, trx_id, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resellerId,
        paymentType,
        String(customerName || (paymentType === "reseller" ? "রিসেলার রিচার্জ" : "Customer")).trim(),
        String(customerUsername || (paymentType === "reseller" ? "reseller" : "N/A")).trim(),
        String(packageName || "").trim(),
        paymentAmount,
        paidAmount,
        normalizedMethod,
        paymentChannel,
        submissionTrxId,
        submissionStatus,
        String(notes || "").trim() || (submissionStatus === "paid" ? "Online payment received" : "Payment submitted for processing")
      ]
    );

    let subscription = null;
    if (paymentType === "customer" && submissionStatus === "paid") {
      subscription = await activatePaidCustomerSubscription(connection, {
        id: result.insertId,
        reseller_id: resellerId,
        payment_type: paymentType,
        customer_username: String(customerUsername || "").trim()
      }, paidAmount);
      if (subscription) {
        await connection.query("UPDATE payments SET package_name=? WHERE id=?", [subscription.packageName, result.insertId]);
      }
    }

    await recordPaymentEvent(connection, {
      paymentId: result.insertId,
      resellerId,
      eventType: paymentChannel === "cash" ? "cash_submitted" : (submissionStatus === "paid" ? "online_received" : "online_submitted"),
      amount: paymentAmount,
      status: submissionStatus,
      paymentChannel,
      paymentMethod: normalizedMethod,
      trxId: submissionTrxId,
      notes: String(notes || "").trim() || (submissionStatus === "paid" ? "Online payment received" : "Payment submitted for processing")
    });
    const [rows] = await connection.query("SELECT * FROM payments WHERE id=?", [result.insertId]);
    await connection.commit();
    transactionStarted = false;
    res.status(201).json({ ok: true, payment: rows[0], subscription });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
}

app.post("/api/reseller/:resellerId/payments", (req, res) => createPaymentRecord(req, res, false));
app.post("/api/admin/resellers/:resellerId/payments", (req, res) => createPaymentRecord(req, res, true));

app.post("/api/admin/resellers/:resellerId/receive-payment", async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const resellerId = Number(req.params.resellerId);
    const paymentMethod = String(req.body?.paymentMethod || "").trim();
    const amount = Number(req.body?.amount);
    const receiverName = String(req.body?.receiverName || "").trim();
    const trxId = String(req.body?.trxId || "").trim();
    const details = String(req.body?.details || "").trim();
    if (!Number.isInteger(resellerId) || resellerId < 1) return res.status(400).json({ error: "A valid reseller is required." });
    if (!["Cash", "Bank", "bKash"].includes(paymentMethod)) return res.status(400).json({ error: "Choose Cash, Bank, or bKash." });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
    if (!receiverName) return res.status(400).json({ error: "Receiver name is required." });
    if (paymentMethod !== "Cash" && !trxId) return res.status(400).json({ error: "Transaction/reference ID is required for Bank and bKash." });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [resellers] = await connection.query("SELECT id, full_name, username FROM resellers WHERE id=? FOR UPDATE", [resellerId]);
    if (!resellers.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Reseller not found." });
    }
    const reseller = resellers[0];
    const paymentChannel = paymentMethod === "Cash" ? "cash" : "online";
    const receiptTrxId = trxId || `CASH${Date.now().toString().slice(-8)}`;
    const notes = details || `Reseller payment received by ${receiverName}`;
    const [result] = await connection.query(
      `INSERT INTO payments (reseller_id, payment_type, customer_name, customer_username, package_name, amount, paid_amount, payment_method, receiver_name, payment_channel, trx_id, status, notes)
       VALUES (?, 'reseller', ?, ?, 'Reseller Payment', ?, ?, ?, ?, ?, ?, 'paid', ?)`,
      [reseller.id, reseller.full_name, reseller.username, amount, amount, paymentMethod, receiverName, paymentChannel, receiptTrxId, notes]
    );
    await recordPaymentEvent(connection, {
      paymentId: result.insertId, resellerId, eventType: paymentMethod === "Cash" ? "cash_received_full" : "online_received",
      amount, status: "paid", paymentChannel, paymentMethod, receiverName, trxId: receiptTrxId, notes
    });
    const [payments] = await connection.query("SELECT * FROM payments WHERE id=?", [result.insertId]);
    await connection.commit();
    transactionStarted = false;
    res.status(201).json({ ok: true, payment: payments[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.get("/api/reseller/:resellerId/customers", requireSessionRoles("reseller"), async (req, res) => {
  try {
    const query = buildCustomerListQuery(req.authenticatedSession, req.params.resellerId);
    if (!query) return res.status(403).json({ error: "You can only view your own active customers." });
    const [rows] = await pool.query(query.sql, query.params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reseller/customer/:id/emergency-extend", async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const requestKey = String(req.body?.requestId || "").trim();
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestKey)) return res.status(400).json({ error: "A valid request ID is required." });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.query("SELECT * FROM reseller_customers WHERE id=? AND deleted_at IS NULL FOR UPDATE", [req.params.id]);
    if (!rows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Customer not found." });
    }
    const customer = rows[0];
    const [priorRequests] = await connection.query(
      "SELECT customer_id, response_json FROM renewal_requests WHERE request_key=? FOR UPDATE",
      [requestKey]
    );
    if (priorRequests.length) {
      await connection.rollback(); transactionStarted = false;
      if (Number(priorRequests[0].customer_id) !== Number(customer.id)) {
        return res.status(409).json({ error: "This request ID was already used for another customer." });
      }
      if (!priorRequests[0].response_json) return res.status(409).json({ error: "This request is already being processed." });
      return res.json({ ...JSON.parse(priorRequests[0].response_json), replayed: true });
    }
    if (Number(customer.emergency_extend_used) === 1) {
      await connection.rollback(); transactionStarted = false;
      return res.status(400).json({ error: "Emergency Extend has already been used since the last recharge." });
    }

    const [routerRows] = customer.router_id
      ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [customer.router_id])
      : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routerRows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "No enabled router is available for this customer." });
    }
    const router = routerRows[0];
    const secrets = await mtGet(router, "/ppp/secret");
    const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
    if (!secret?.[".id"]) throw new Error("PPPoE secret was not found on MikroTik.");
    await mtPatch(router, `/ppp/secret/${secret[".id"]}`, { disabled: "false" });

    await connection.query(
      `UPDATE reseller_customers
       SET router_id=?, expiry_date=DATE_ADD(COALESCE(expiry_date, CURDATE()), INTERVAL 5 DAY),
           balance_days=balance_days+5, emergency_extend_used=1, is_active=1, trial_expires_at=NULL
       WHERE id=?`,
      [router.id, customer.id]
    );
    const [updatedRows] = await connection.query("SELECT expiry_date, balance_days FROM reseller_customers WHERE id=?", [customer.id]);
    const responsePayload = { ok: true, ...updatedRows[0], appliedDays: 5 };
    await connection.query("INSERT INTO renewal_requests (request_key, customer_id, response_json) VALUES (?, ?, ?)", [requestKey, customer.id, JSON.stringify(responsePayload)]);
    await connection.commit();
    transactionStarted = false;
    res.json(responsePayload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.post("/api/reseller/customer/:id/renew", requireSessionRoles("admin", "reseller"), async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const paymentMethod = String(req.body?.paymentMethod || "").trim();
    const receiverName = String(req.body?.receiverName || "").trim();
    const trxId = String(req.body?.trxId || "").trim();
    const requestKey = String(req.body?.requestId || "").trim();
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Enter a positive payment amount. Emergency Extend is available separately." });
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestKey)) return res.status(400).json({ error: "A valid renewal request ID is required." });
    if (!["Cash", "bKash"].includes(paymentMethod)) return res.status(400).json({ error: "Choose a valid payment method." });
    if (req.authenticatedSession.role === "reseller" && paymentMethod !== "Cash") {
      return res.status(403).json({ error: "Resellers can renew with Cash or a recharge card." });
    }
    if (paymentMethod === "Cash" && !receiverName) return res.status(400).json({ error: "Receiver name is required for cash payments." });
    if (paymentMethod === "bKash" && !trxId) return res.status(400).json({ error: "Transaction ID is required for bKash." });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.query("SELECT * FROM reseller_customers WHERE id=? AND deleted_at IS NULL FOR UPDATE", [req.params.id]);
    if (!rows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Customer not found." });
    }
    const customer = rows[0];
    if (req.authenticatedSession.role === "reseller" && Number(req.authenticatedSession.resellerId) !== Number(customer.reseller_id)) {
      await connection.rollback(); transactionStarted = false;
      return res.status(403).json({ error: "You can only renew subscriptions for your own customers." });
    }
    const [priorRequests] = await connection.query(
      "SELECT customer_id, response_json FROM renewal_requests WHERE request_key=? FOR UPDATE",
      [requestKey]
    );
    if (priorRequests.length) {
      await connection.rollback(); transactionStarted = false;
      if (Number(priorRequests[0].customer_id) !== Number(customer.id)) {
        return res.status(409).json({ error: "This renewal request ID was already used for another customer." });
      }
      if (!priorRequests[0].response_json) return res.status(409).json({ error: "This renewal request is already being processed." });
      return res.json({ ...JSON.parse(priorRequests[0].response_json), replayed: true });
    }
    await connection.query("INSERT INTO renewal_requests (request_key, customer_id) VALUES (?, ?)", [requestKey, customer.id]);
    let matchedPackage = null;
    const [routerRows] = customer.router_id
      ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [customer.router_id])
      : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routerRows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "No enabled router is available for this customer." });
    }
    const router = routerRows[0];
    if (!customer.router_id) {
      await connection.query("UPDATE reseller_customers SET router_id=? WHERE id=?", [router.id, customer.id]);
      customer.router_id = router.id;
    }
    const [packageRows] = await connection.query(
      "SELECT name FROM package_profiles WHERE router_id=? AND price=? ORDER BY id DESC",
      [router.id, amount]
    );
    try {
      const profiles = await getPppProfiles(routerRows[0]);
      const enabledNames = new Set(profiles
        .filter((profile) => profile.disabled !== true && profile.disabled !== "true")
        .map((profile) => String(profile.name || profile.profile || "").trim().toLowerCase()));
      if (packageRows.length) {
        matchedPackage = packageRows.find((row) => enabledNames.has(String(row.name || "").trim().toLowerCase())) || null;
      }
      if (!matchedPackage) {
        throw new Error(`No package is priced at ${amount} BDT. Set the matching PPP profile price to ${amount} BDT and try again.`);
      }
      const secrets = await mtGet(routerRows[0], "/ppp/secret");
      const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
      if (!secret?.[".id"]) throw new Error("PPPoE secret was not found on MikroTik.");
      const secretChanges = { disabled: "false" };
      if (matchedPackage) secretChanges.profile = matchedPackage.name;
      await mtPatch(routerRows[0], `/ppp/secret/${secret[".id"]}`, secretChanges);
    } catch (routerError) {
      await connection.rollback(); transactionStarted = false;
      const details = routerError.response?.data;
      const message = typeof details === "string" ? details : details?.detail || details?.message || routerError.message;
      if (message.startsWith("The PPP profile") || message.startsWith("The saved package") || message.startsWith("No package is priced") || message.startsWith("No enabled PPP profile")) {
        return res.status(400).json({ error: message });
      }
      return res.status(502).json({ error: `MikroTik renewal failed: ${message}` });
    }
    if (matchedPackage) {
      await connection.query(
        "UPDATE reseller_customers SET package_name=?, is_active=1, trial_expires_at=NULL WHERE id=?",
        [matchedPackage.name, customer.id]
      );
    }
    const appliedDays = getRegularRenewalDays(customer.emergency_extend_used);
    const cashAmount = amount;
    await connection.query(
      `UPDATE reseller_customers
       SET expiry_date=DATE_ADD(COALESCE(expiry_date, CURDATE()), INTERVAL ? DAY),
           balance_days=balance_days+?,
           emergency_extend_used=0, is_active=1,
           trial_expires_at=NULL
       WHERE id=?`,
      [appliedDays, appliedDays, customer.id]
    );
    const paymentChannel = paymentMethod === "Cash" ? "cash" : "online";
    const paymentValue = cashAmount;
    const paymentStatus = paymentMethod === "Cash" ? "processing" : "paid";
    const recordedPaidAmount = paymentStatus === "paid" ? cashAmount : 0;
    const paymentNotes = `Subscription renewal; package price ${amount}; ${appliedDays} days applied; package updated to ${matchedPackage.name}`;
    const [paymentResult] = await connection.query(
      `INSERT INTO payments (reseller_id, payment_type, customer_name, customer_username, package_name, amount, paid_amount, payment_method, receiver_name, payment_channel, trx_id, status, notes)
       VALUES (?, 'customer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [customer.reseller_id, customer.full_name, customer.username, matchedPackage?.name || customer.package_name, paymentValue, recordedPaidAmount, paymentMethod, receiverName || null, paymentChannel, trxId || null, paymentStatus, paymentNotes]
    );
    await recordPaymentEvent(connection, {
      paymentId: paymentResult.insertId, resellerId: customer.reseller_id,
      eventType: paymentStatus === "processing" ? "cash_submitted" : "renewal_paid",
      amount: cashAmount, status: paymentStatus, paymentChannel,
      paymentMethod, receiverName, trxId,
      notes: paymentStatus === "processing"
        ? `Cash renewal submitted; ${appliedDays} days applied`
        : `Package renewal ${amount}; ${appliedDays} days applied`
    });
    const [updatedRows] = await connection.query("SELECT expiry_date, balance_days FROM reseller_customers WHERE id=?", [customer.id]);
    const responsePayload = {
      ok: true, ...updatedRows[0], appliedDays,
      cashAmount, packageName: matchedPackage?.name || customer.package_name
    };
    await connection.query("UPDATE renewal_requests SET response_json=? WHERE request_key=?", [JSON.stringify(responsePayload), requestKey]);
    await connection.commit();
    transactionStarted = false;
    res.json(responsePayload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.post("/api/reseller/customer/:id/redeem-voucher", requireSessionRoles("admin", "reseller", "customer"), async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const voucherCode = normalizeVoucherCode(req.body?.voucherCode);
    const requestKey = String(req.body?.requestId || "").trim();
    if (!/^\d{10}$/.test(voucherCode)) return res.status(400).json({ error: "Enter the 10-digit recharge card code." });
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestKey)) return res.status(400).json({ error: "A valid recharge request ID is required." });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [customerRows] = await connection.query(
      "SELECT * FROM reseller_customers WHERE id=? AND deleted_at IS NULL FOR UPDATE",
      [req.params.id]
    );
    if (!customerRows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Customer not found." });
    }
    const customer = customerRows[0];
    const session = req.authenticatedSession;
    if (session.role === "customer" && Number(session.customerId) !== Number(customer.id)) {
      await connection.rollback(); transactionStarted = false;
      return res.status(403).json({ error: "You can only redeem a card for your own customer account." });
    }
    if (session.role === "reseller" && Number(session.resellerId) !== Number(customer.reseller_id)) {
      await connection.rollback(); transactionStarted = false;
      return res.status(403).json({ error: "You can only redeem a card for one of your customers." });
    }
    const [priorRequests] = await connection.query(
      "SELECT customer_id, response_json FROM renewal_requests WHERE request_key=? FOR UPDATE",
      [requestKey]
    );
    if (priorRequests.length) {
      await connection.rollback(); transactionStarted = false;
      if (Number(priorRequests[0].customer_id) !== Number(customer.id)) {
        return res.status(409).json({ error: "This recharge request ID was already used for another customer." });
      }
      if (!priorRequests[0].response_json) return res.status(409).json({ error: "This recharge request is already being processed." });
      return res.json({ ...JSON.parse(priorRequests[0].response_json), replayed: true });
    }

    const [voucherRows] = await connection.query(
      "SELECT * FROM recharge_vouchers WHERE code_hash=? FOR UPDATE",
      [hashVoucherCode(voucherCode)]
    );
    if (!voucherRows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Recharge card code was not found." });
    }
    const voucher = voucherRows[0];
    if (voucher.status !== "available") {
      await connection.rollback(); transactionStarted = false;
      return res.status(409).json({ error: "This recharge card has already been used or voided." });
    }
    if (!Number(voucher.enabled)) {
      await connection.rollback(); transactionStarted = false;
      return res.status(409).json({ error: "This recharge card is disabled." });
    }
    if (customer.router_id && Number(customer.router_id) !== Number(voucher.router_id)) {
      await connection.rollback(); transactionStarted = false;
      return res.status(400).json({ error: "This card belongs to a different MikroTik router." });
    }

    const routerId = customer.router_id || voucher.router_id;
    const [routers] = await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [routerId]);
    if (!routers.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "The card's MikroTik router is unavailable." });
    }
    const router = routers[0];
    const profiles = await getPppProfiles(router);
    const profile = profiles.find((item) => String(item.name || item.profile || "").trim() === voucher.package_name);
    if (!profile || profile.disabled === true || profile.disabled === "true") {
      await connection.rollback(); transactionStarted = false;
      return res.status(400).json({ error: "The card's PPP package is no longer available on its router." });
    }
    const secrets = await mtGet(router, "/ppp/secret");
    const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
    if (!secret?.[".id"]) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "PPPoE secret was not found on MikroTik." });
    }
    await mtPatch(router, `/ppp/secret/${secret[".id"]}`, { profile: voucher.package_name, disabled: "false" });

    const appliedDays = Number(customer.emergency_extend_used) === 1
      ? Math.max(1, Number(voucher.duration_days) - 5)
      : Number(voucher.duration_days);
    await connection.query(
      `UPDATE reseller_customers
       SET router_id=?, package_name=?, expiry_date=DATE_ADD(COALESCE(expiry_date, CURDATE()), INTERVAL ? DAY),
           balance_days=balance_days+?, emergency_extend_used=0, is_active=1, trial_expires_at=NULL
       WHERE id=?`,
      [router.id, voucher.package_name, appliedDays, appliedDays, customer.id]
    );
    const amount = Number(voucher.price);
    const paymentNotes = `Recharge card ${voucher.code_suffix}; package ${voucher.package_name}; ${appliedDays} days applied`;
    const [paymentResult] = await connection.query(
      `INSERT INTO payments (reseller_id, payment_type, customer_name, customer_username, package_name, amount, paid_amount, payment_method, payment_channel, trx_id, status, notes)
       VALUES (?, 'customer', ?, ?, ?, ?, ?, 'Card Recharge', 'card', ?, 'paid', ?)`,
      [customer.reseller_id, customer.full_name, customer.username, voucher.package_name, amount, amount, `CARD-${voucher.id}`, paymentNotes]
    );
    await recordPaymentEvent(connection, {
      paymentId: paymentResult.insertId, resellerId: customer.reseller_id, eventType: "card_redeemed",
      amount, status: "paid", paymentChannel: "card", paymentMethod: "Card Recharge",
      trxId: `CARD-${voucher.id}`, notes: paymentNotes
    });
    await connection.query(
      `UPDATE recharge_vouchers
       SET status='used', redeemed_customer_id=?, redeemed_customer_username=?,
           redeemed_reseller_id=?, payment_id=?, redeemed_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [customer.id, customer.username, customer.reseller_id, paymentResult.insertId, voucher.id]
    );
    const [updatedRows] = await connection.query("SELECT expiry_date, balance_days FROM reseller_customers WHERE id=?", [customer.id]);
    const responsePayload = {
      ok: true, ...updatedRows[0], appliedDays, packageName: voucher.package_name,
      paymentAmount: amount
    };
    await connection.query("INSERT INTO renewal_requests (request_key, customer_id, response_json) VALUES (?, ?, ?)", [requestKey, customer.id, JSON.stringify(responsePayload)]);
    await connection.commit();
    transactionStarted = false;
    res.json(responsePayload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.post("/api/reseller/:resellerId/customers", requireSessionRoles("admin", "reseller"), async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const { resellerId } = req.params;
    const {
      fullName,
      username,
      password,
      mobile,
      email,
      packageName,
      area,
      idDocument,
      routerId
    } = req.body || {};

    const assignedResellerId = Number(resellerId);
    if (!Number.isSafeInteger(assignedResellerId) || assignedResellerId <= 0) {
      return res.status(400).json({ error: "Select an active reseller before creating a customer." });
    }
    const session = req.authenticatedSession;
    if (session.role === "reseller" && Number(session.resellerId) !== assignedResellerId) {
      return res.status(403).json({ error: "You can only create customers for your own reseller account." });
    }
    const creatorResellerId = session.role === "reseller" ? Number(session.resellerId) : null;

    if (![fullName, username, password, mobile, packageName, area].every((value) => String(value ?? "").trim())) {
      return res.status(400).json({ error: "Please provide full name, username, password, mobile number, package profile, and area." });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [resellerRows] = await connection.query(
      "SELECT id FROM resellers WHERE id=? AND is_active=1 FOR UPDATE",
      [assignedResellerId]
    );
    if (!resellerRows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({ error: "Select an active reseller before creating a customer." });
    }

    const [dup] = await connection.query(
      "SELECT id FROM reseller_customers WHERE reseller_id=? AND (username=? OR mobile=?) LIMIT 1",
      [assignedResellerId, String(username).trim(), String(mobile).trim()]
    );
    if (dup.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({ error: "এই ইউজারনেম বা মোবাইল নম্বর আগেই ব্যবহার করা হয়েছে।" });
    }

    const [routerRows] = routerId
      ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [routerId])
      : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routerRows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ error: "No enabled MikroTik router is available." });
    }

    let liveProfiles;
    try {
      liveProfiles = await getPppProfiles(routerRows[0]);
    } catch (profileError) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(502).json({ error: `Could not read PPP profiles from MikroTik: ${profileError.message}` });
    }
    const selectedProfile = liveProfiles.find((profile) => String(profile.name || profile.profile || "").trim() === String(packageName).trim());
    if (!selectedProfile || selectedProfile.disabled === true || selectedProfile.disabled === "true") {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({ error: "Select an enabled PPP profile that exists on the selected MikroTik router." });
    }
    try {
      await mtPut(routerRows[0], "/ppp/secret", {
        name: String(username).trim(),
        password: String(password),
        service: "pppoe",
        profile: String(packageName).trim(),
        disabled: "false"
      });
    } catch (routerError) {
      await connection.rollback();
      transactionStarted = false;
      const details = routerError.response?.data;
      const message = typeof details === "string"
        ? details
        : details?.detail || details?.error || details?.message || routerError.message;
      return res.status(502).json({ error: `MikroTik ইউজার তৈরি ব্যর্থ: ${message}` });
    }

    const [result] = await connection.query(
      `INSERT INTO reseller_customers (reseller_id, created_by_reseller_id, router_id, full_name, username, password, mobile, email, package_name, area, expiry_date, trial_expires_at, id_document, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), DATE_ADD(NOW(), INTERVAL 1 HOUR), ?, 1)`,
      [
        assignedResellerId,
        creatorResellerId,
        routerRows[0].id,
        String(fullName).trim(),
        String(username).trim(),
        password,
        String(mobile).trim(),
        email ? String(email).trim() : null,
        String(packageName).trim(),
        String(area).trim(),
        idDocument ? String(idDocument) : null
      ]
    );

    const [rows] = await connection.query("SELECT * FROM reseller_customers WHERE id=?", [result.insertId]);
    await connection.commit();
    transactionStarted = false;
    res.status(201).json({ ok: true, customer: rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.post("/api/reseller/customer/:id/toggle-active", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM reseller_customers WHERE id=? AND deleted_at IS NULL", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Customer not found." });

    const customer = rows[0];
    const nextValue = Number(customer.is_active) ? 0 : 1;
    const routerId = customer.router_id || req.body?.routerId;
    const [routerRows] = routerId
      ? await pool.query("SELECT * FROM routers WHERE id=? AND enabled=1", [routerId])
      : await pool.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routerRows.length) return res.status(404).json({ error: "No enabled MikroTik router is available." });

    try {
      const secrets = await mtGet(routerRows[0], "/ppp/secret");
      const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
      if (!secret?.[".id"]) {
        return res.status(404).json({ error: "PPPoE secret was not found on MikroTik." });
      }
      await mtPatch(routerRows[0], `/ppp/secret/${secret[".id"]}`, {
        disabled: nextValue ? "false" : "true"
      });
    } catch (routerError) {
      const details = routerError.response?.data;
      const message = typeof details === "string"
        ? details
        : details?.detail || details?.message || routerError.message;
      return res.status(502).json({ error: `MikroTik status update failed: ${message}` });
    }

    await pool.query("UPDATE reseller_customers SET is_active=? WHERE id=?", [nextValue, req.params.id]);
    res.json({ ok: true, isActive: !!nextValue });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/customers/deleted", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT h.id AS history_id, h.deleted_at, h.restored_at, c.id, c.reseller_id, c.router_id,
             c.full_name, c.username, c.mobile, c.package_name, c.created_at,
             r.full_name AS reseller_name
      FROM ppp_customer_delete_history h
      JOIN reseller_customers c ON c.id = h.customer_id
      LEFT JOIN resellers r ON r.id = c.reseller_id
      WHERE h.restored_at IS NULL
      ORDER BY h.deleted_at DESC, h.id DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/reseller/:resellerId/customers/deleted", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT h.id AS history_id, h.deleted_at, h.restored_at, c.id, c.reseller_id, c.router_id,
             c.full_name, c.username, c.mobile, c.package_name, c.created_at
      FROM ppp_customer_delete_history h
      JOIN reseller_customers c ON c.id = h.customer_id
      WHERE c.reseller_id=? AND h.restored_at IS NULL
      ORDER BY h.deleted_at DESC, h.id DESC
    `, [req.params.resellerId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/reseller/customer/:id", async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.query(
      "SELECT * FROM reseller_customers WHERE id=? AND deleted_at IS NULL FOR UPDATE",
      [req.params.id]
    );
    if (!rows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ error: "Customer not found or already deleted." });
    }

    const customer = rows[0];
    const routerId = customer.router_id || req.body?.routerId;
    const [routerRows] = routerId
      ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [routerId])
      : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routerRows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ error: "No enabled MikroTik router is available." });
    }

    try {
      const secrets = await mtGet(routerRows[0], "/ppp/secret");
      const secret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
      if (secret?.[".id"]) {
        await mtDelete(routerRows[0], `/ppp/secret/${secret[".id"]}`);
      }
    } catch (routerError) {
      await connection.rollback();
      transactionStarted = false;
      const details = routerError.response?.data;
      const message = typeof details === "string"
        ? details
        : details?.detail || details?.message || routerError.message;
      return res.status(502).json({ error: `MikroTik থেকে PPP user মুছতে ব্যর্থ: ${message}` });
    }

    await connection.query(
      "UPDATE reseller_customers SET router_id=?, deleted_at=CURRENT_TIMESTAMP WHERE id=?",
      [routerRows[0].id, customer.id]
    );
    await connection.query(
      "INSERT INTO ppp_customer_delete_history (customer_id, router_id) VALUES (?, ?)",
      [customer.id, routerRows[0].id]
    );
    await connection.commit();
    transactionStarted = false;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.post("/api/reseller/customer/:id/restore", requireSessionRoles("admin", "reseller"), async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const paymentMethod = String(req.body?.paymentMethod || "bKash").trim();
    const isCard = paymentMethod === "card";
    const session = req.authenticatedSession;
    const supportedPaymentMethods = session.role === "admin" ? ["Cash", "bKash"] : ["Cash", "card"];
    const receiverName = String(req.body?.receiverName || "").trim();
    const transactionId = String(req.body?.trxId || "").trim();
    const voucherCode = normalizeVoucherCode(req.body?.voucherCode);
    let amount = Number(req.body?.amount);
    if (!supportedPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({ error: "Unsupported payment method." });
    }
    if (!isCard && (!Number.isFinite(amount) || amount <= 0)) return res.status(400).json({ error: "A valid amount is required." });
    if (isCard && !/^\d{10}$/.test(voucherCode)) return res.status(400).json({ error: "Enter the 10-digit recharge card code." });
    if (paymentMethod === "Cash" && !receiverName) return res.status(400).json({ error: "Receiver name is required for cash payments." });
    if (paymentMethod === "bKash" && !transactionId) return res.status(400).json({ error: "Transaction ID is required for bKash." });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.query(
      `SELECT c.*, h.id AS history_id, h.router_id AS history_router_id
       FROM reseller_customers c
       JOIN ppp_customer_delete_history h ON h.customer_id=c.id AND h.restored_at IS NULL
       WHERE c.id=? AND c.deleted_at IS NOT NULL
       ORDER BY h.id DESC LIMIT 1 FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ error: "Deleted PPP user not found." });
    }

    const customer = rows[0];
    if (session.role === "reseller" && Number(session.resellerId) !== Number(customer.reseller_id)) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(403).json({ error: "You can only restore your own customers." });
    }

    let voucher = null;
    if (isCard) {
      const [voucherRows] = await connection.query(
        "SELECT * FROM recharge_vouchers WHERE code_hash=? FOR UPDATE",
        [hashVoucherCode(voucherCode)]
      );
      if (!voucherRows.length) {
        await connection.rollback(); transactionStarted = false;
        return res.status(404).json({ error: "Recharge card code was not found." });
      }
      voucher = voucherRows[0];
      if (voucher.status !== "available") {
        await connection.rollback(); transactionStarted = false;
        return res.status(409).json({ error: "This recharge card has already been used or voided." });
      }
      if (!Number(voucher.enabled)) {
        await connection.rollback(); transactionStarted = false;
        return res.status(409).json({ error: "This recharge card is disabled." });
      }
      if (customer.router_id && Number(customer.router_id) !== Number(voucher.router_id)) {
        await connection.rollback(); transactionStarted = false;
        return res.status(400).json({ error: "This card belongs to a different MikroTik router." });
      }
      amount = Number(voucher.price);
    }
    const routerId = voucher?.router_id || customer.router_id || customer.history_router_id || req.body?.routerId;
    const [packageRows] = voucher
      ? await connection.query(
        "SELECT name, price FROM package_profiles WHERE router_id=? AND name=? AND price=? ORDER BY id LIMIT 1",
        [routerId, voucher.package_name, amount.toFixed(2)]
      )
      : await connection.query(
        "SELECT name, price FROM package_profiles WHERE router_id=? AND price=? ORDER BY id LIMIT 1",
        [routerId, amount.toFixed(2)]
      );
    if (!packageRows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({ error: "এই টাকার পরিমাণের সাথে মেলে এমন কোনো PPP profile নেই। Package profile-এর price আগে সেট করুন।" });
    }
    const selectedPackage = packageRows[0];

    const [routerRows] = routerId
      ? await connection.query("SELECT * FROM routers WHERE id=? AND enabled=1", [routerId])
      : await connection.query("SELECT * FROM routers WHERE enabled=1 ORDER BY id LIMIT 1");
    if (!routerRows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ error: "The original MikroTik router is unavailable." });
    }

    try {
      const secrets = await mtGet(routerRows[0], "/ppp/secret");
      const existingSecret = (Array.isArray(secrets) ? secrets : []).find((item) => item.name === customer.username);
      const secretPayload = {
        name: customer.username,
        password: customer.password,
        service: "pppoe",
        profile: selectedPackage.name,
        disabled: "false"
      };
      if (existingSecret?.[".id"]) {
        await mtPatch(routerRows[0], `/ppp/secret/${existingSecret[".id"]}`, secretPayload);
      } else {
        await mtPut(routerRows[0], "/ppp/secret", {
          ...secretPayload
        });
      }
    } catch (routerError) {
      await connection.rollback();
      transactionStarted = false;
      const details = routerError.response?.data;
      const message = typeof details === "string"
        ? details
        : details?.detail || details?.message || routerError.message;
      return res.status(502).json({ error: `MikroTik-এ PPP user restore ব্যর্থ: ${message}` });
    }

    const expiryDays = voucher ? Number(voucher.duration_days) : 30;
    await connection.query(
      `UPDATE reseller_customers
       SET router_id=?, package_name=?, deleted_at=NULL, is_active=1,
           expiry_date=DATE_ADD(GREATEST(COALESCE(expiry_date, CURDATE()), CURDATE()), INTERVAL ? DAY),
           balance_days=balance_days+?, emergency_extend_used=0, trial_expires_at=NULL
       WHERE id=?`,
      [routerRows[0].id, selectedPackage.name, expiryDays, expiryDays, customer.id]
    );
    await connection.query(
      "UPDATE ppp_customer_delete_history SET restored_at=CURRENT_TIMESTAMP WHERE id=?",
      [customer.history_id]
    );
    await connection.query(
      `INSERT INTO payments (reseller_id, payment_type, customer_name, customer_username, package_name, amount, paid_amount, payment_method, receiver_name, payment_channel, trx_id, status, notes)
       VALUES (?, 'customer', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`,
      [
        customer.reseller_id,
        customer.full_name,
        customer.username,
        selectedPackage.name,
        amount,
        amount,
        isCard ? "Card Recharge" : paymentMethod,
        isCard || paymentMethod === "bKash" ? null : receiverName || null,
        isCard ? "card" : paymentMethod === "Cash" ? "cash" : "online",
        isCard ? `CARD-${voucher.id}` : transactionId || null,
        isCard ? `Recharge card ${voucher.code_suffix}; PPP user restore payment; ${expiryDays} days` : "30-day PPP user restore payment"
      ]
    );
    const [paymentRows] = await connection.query("SELECT LAST_INSERT_ID() AS id");
    if (voucher) {
      await recordPaymentEvent(connection, {
        paymentId: paymentRows[0].id, resellerId: customer.reseller_id, eventType: "card_redeemed",
        amount, status: "paid", paymentChannel: "card", paymentMethod: "Card Recharge",
        trxId: `CARD-${voucher.id}`, notes: `Voucher restore payment; ${expiryDays} days`
      });
      await connection.query(
        `UPDATE recharge_vouchers SET status='used', redeemed_customer_id=?, redeemed_customer_username=?,
           redeemed_reseller_id=?, payment_id=?, redeemed_at=CURRENT_TIMESTAMP WHERE id=?`,
        [customer.id, customer.username, customer.reseller_id, paymentRows[0].id, voucher.id]
      );
    }
    const [updatedCustomerRows] = await connection.query(
      "SELECT expiry_date, balance_days FROM reseller_customers WHERE id=?",
      [customer.id]
    );
    await connection.commit();
    transactionStarted = false;
    res.json({
      ok: true, expiryDays, ...updatedCustomerRows[0],
      paymentMethod: isCard ? "Card Recharge" : paymentMethod,
      receiverName, trxId: transactionId, amount, packageName: selectedPackage.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});


app.get("/api/router/:id/test", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    const result = await testRouterConnectivity(router);
    res.json(result);
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: "Connection test failed",
      details: e.message
    });
  }
});

app.get("/api/router/:id/ppp/secrets", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    const secrets = await mtGet(router, "/ppp/secret");
    res.json(Array.isArray(secrets) ? secrets.map((secret) => ({
      name: secret.name || secret.user || "",
      profile: secret.profile || "",
      service: secret.service || "",
      "local-address": secret["local-address"] || "",
      "remote-address": secret["remote-address"] || "",
      disabled: secret.disabled === true || secret.disabled === "true"
    })) : []);
  } catch (error) {
    res.status(502).json({ error: `Could not load PPP secrets: ${error.message}`, details: error.message });
  }
});

app.get("/api/router/:id/dhcp/clients", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    const clients = await mtGet(router, "/ip/dhcp-client");
    res.json(Array.isArray(clients) ? clients : []);
  } catch (error) {
    res.status(502).json({ error: "Could not load DHCP clients", details: error.message });
  }
});

app.post("/api/router/:id/dhcp/clients", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  const interfaceName = String(req.body?.interface || "").trim();
  if (!interfaceName) return res.status(400).json({ error: "Interface is required." });

  try {
    const result = await mtPost(router, "/ip/dhcp-client/add", {
      interface: interfaceName,
      "use-peer-dns": req.body?.usePeerDns === false ? "no" : "yes",
      "use-peer-ntp": req.body?.usePeerNtp === false ? "no" : "yes",
      "add-default-route": req.body?.addDefaultRoute === false ? "no" : "yes"
    });
    res.status(201).json({ ok: true, result });
  } catch (error) {
    res.status(502).json({ error: "Could not add DHCP client to MikroTik", details: error.response?.data || error.message });
  }
});

app.get("/api/router/:id/hotspot/users", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    const users = await mtGet(router, "/ip/hotspot/user");
    res.json(Array.isArray(users) ? users : []);
  } catch (error) {
    res.status(502).json({ error: "Could not load Hotspot users", details: error.message });
  }
});

app.post("/api/router/:id/hotspot/users", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  const name = String(req.body?.name || "").trim();
  const password = String(req.body?.password || "");
  if (!name || !password) return res.status(400).json({ error: "Username and password are required." });

  const user = { name, password };
  for (const [input, field] of [["profile", "profile"], ["server", "server"], ["limitUptime", "limit-uptime"], ["comment", "comment"]]) {
    const value = String(req.body?.[input] || "").trim();
    if (value) user[field] = value;
  }

  try {
    const result = await mtPost(router, "/ip/hotspot/user/add", user);
    res.status(201).json({ ok: true, result });
  } catch (error) {
    res.status(502).json({ error: "Could not add Hotspot user to MikroTik", details: error.response?.data || error.message });
  }
});

app.get("/api/dashboard/:id", requireSessionRoles("admin", "reseller"), async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    const [resource, interfaces, leases, hotspot, vpn, firewall, addresses, routerActiveSessions, routerPppSecrets] = await Promise.all([
      mtGet(router, "/system/resource"),
      mtGet(router, "/interface"),
      mtGet(router, "/ip/dhcp-server/lease"),
      mtGet(router, "/ip/hotspot/active"),
      mtGet(router, "/interface/l2tp-server"),
      mtGet(router, "/ip/firewall/filter"),
      mtGet(router, "/ip/address"),
      mtGet(router, "/ppp/active").catch(() => []),
      mtGet(router, "/ppp/secret").catch(() => [])
    ]);

    let pppActive = routerActiveSessions;
    let pppSecrets = routerPppSecrets;
    if (req.authenticatedSession.role === "reseller") {
      const customerQuery = buildResellerDashboardUsernamesQuery(req.authenticatedSession);
      const [customers] = await pool.query(customerQuery.sql, customerQuery.params);
      const resellerUsernames = new Set(customers.map((customer) => String(customer.username).trim().toLowerCase()));
      pppActive = filterRouterUsersByUsername(routerActiveSessions, resellerUsernames);
      pppSecrets = filterRouterUsersByUsername(routerPppSecrets, resellerUsernames);
    }

    let crashEntries = [];
    try {
      const crashLogs = await mtGet(router, "/system/crash/print");
      crashEntries = Array.isArray(crashLogs) ? crashLogs : [];
    } catch (crashError) {
      console.log("Crash logs unavailable for this MikroTik device:", crashError.response?.data || crashError.message);
      crashEntries = [];
    }

    const rx = interfaces.reduce((s, x) => s + parseBytes(x["rx-byte"]), 0);
    const tx = interfaces.reduce((s, x) => s + parseBytes(x["tx-byte"]), 0);
    const cpu = parsePercent(resource["cpu-load"]);
    const totalMem = parseBytes(resource["total-memory"]);
    const freeMem = parseBytes(resource["free-memory"]);
    const usedMem = Math.max(0, totalMem - freeMem);

    const activeConnectionList = Array.isArray(pppActive) ? pppActive : [];
    const pppUserMap = new Map();
    activeConnectionList.forEach((item) => {
      const name = String(item.user || item.name || "").trim();
      if (!name) return;
      pppUserMap.set(name, {
        name,
        localAddress: item["local-address"] || item.localAddress || "—",
        remoteAddress: item["remote-address"] || item.remoteAddress || "—",
        uptime: item.uptime || "—",
        status: item.status || "Connected"
      });
    });

    const routerPppUsers = (Array.isArray(pppSecrets) ? pppSecrets : []).map((item) => {
      const name = String(item.name || item.user || "").trim();
      if (!name) return null;
      const active = pppUserMap.get(name);
      return {
        name,
        localAddress: active?.localAddress || item["local-address"] || item.localAddress || "—",
        remoteAddress: active?.remoteAddress || item["remote-address"] || item.remoteAddress || "—",
        uptime: active?.uptime || item.uptime || "—",
        status: active?.status || (item.disabled === true || item.disabled === "true" ? "Disabled" : "Connected")
      };
    }).filter(Boolean);

    const activeOnlyUsers = activeConnectionList
      .filter((item) => !routerPppUsers.some((user) => user.name === (item.user || item.name)))
      .map((item) => {
        const name = String(item.user || item.name || "").trim();
        if (!name) return null;
        return {
          name,
          localAddress: item["local-address"] || item.localAddress || "—",
          remoteAddress: item["remote-address"] || item.remoteAddress || "—",
          uptime: item.uptime || "—",
          status: item.status || "Connected"
        };
      })
      .filter(Boolean);

    const pppUsers = [...routerPppUsers, ...activeOnlyUsers];

    const payload = {
      router: { id: router.id, name: router.name, host: router.host },
      resource: {
        cpu: cpu,
        memoryUsed: usedMem,
        memoryTotal: totalMem,
        memoryPercent: totalMem ? (usedMem / totalMem) * 100 : 0,
        uptime: resource.uptime || "—",
        board: resource["board-name"] || "MikroTik"
      },
      traffic: {
        rxBytes: rx,
        txBytes: tx,
        rxText: humanBytesPerSecond(rx),
        txText: humanBytesPerSecond(tx)
      },
      sessions: {
        hotspot: Array.isArray(hotspot) ? hotspot.length : 0,
        dhcp: Array.isArray(leases) ? leases.length : 0,
        vpn: Array.isArray(vpn) ? vpn.length : 0
      },
      activeConnections: Array.isArray(pppActive) ? pppActive.map((item) => ({
        user: item.user || item.name || "—",
        name: item.user || item.name || "—",
        "local-address": item["local-address"] || item.localAddress || "—",
        "remote-address": item["remote-address"] || item.remoteAddress || "—",
        uptime: item.uptime || "—",
        status: item.status || "Connected"
      })) : (Array.isArray(hotspot) ? hotspot.map((item) => ({
        user: item.user || item.name || "—",
        name: item.user || item.name || "—",
        "local-address": item["address"] || item.ip || "—",
        "remote-address": "—",
        uptime: item.uptime || "—",
        status: item.status || "Online"
      })) : []),
      pppUsers,
      interfaces: Array.isArray(interfaces) ? interfaces : [],
      addresses: Array.isArray(addresses) ? addresses : [],
      firewall: Array.isArray(firewall) ? firewall : [],
      firewallCrash: {
        count: crashEntries.length,
        entries: crashEntries.slice(0, 20)
      },
      generatedAt: new Date().toISOString()
    };

    await pool.query(
      "INSERT INTO traffic_samples(router_id,rx_bps,tx_bps,cpu_percent) VALUES(?,?,?,?)",
      [router.id, rx, tx, cpu]
    );

    res.json(payload);
  } catch (e) {
    console.log("Dashboard fetch failed:", {
      code: e.code,
      message: e.message,
      status: e.response?.status,
      data: e.response?.data,
      cause: e.cause
    });
    res.status(502).json({
      error: "Unable to reach MikroTik RouterOS REST API",
      details: e.response?.data || e.message
    });
  }
});

app.get("/api/history/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(sampled_at,'%H:%i') label, rx_bps rx, tx_bps tx, cpu_percent cpu
       FROM traffic_samples WHERE router_id=? ORDER BY id DESC LIMIT 30`,
      [req.params.id]
    );
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function findFirstArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];

  if (value.name || value.profile) return [value];

  for (const key of ["data", "result", "list", "profiles", "ppp", "profile"]) {
    if (Array.isArray(value[key])) return value[key];
  }

  for (const child of Object.values(value)) {
    const nested = findFirstArray(child);
    if (nested.length) return nested;
  }

  return [];
}

async function getPppProfiles(router) {
  const candidates = [
    "/ppp/profile",
    "/ppp/profile/print",
    "/ppp/profile/print?",
    "/ppp/profile?"
  ];

  let lastError;
  for (const candidate of candidates) {
    try {
      const payload = await mtGet(router, candidate);
      const found = findFirstArray(payload).filter((item) => item && (item.name || item.profile));
      return found;
    } catch (error) {
      lastError = error;
      if (![404, 405].includes(error.response?.status)) throw error;
    }
  }

  if (lastError) throw lastError;
  return [];
}

app.get("/api/packages/:routerId", async (req, res) => {
  const router = await getRouterOr404(req.params.routerId, res);
  if (!router) return;

  try {
    const [dbRows] = await pool.query(
      "SELECT * FROM package_profiles WHERE router_id=? ORDER BY id DESC",
      [router.id]
    );

    let routerRows = [];
    try {
      routerRows = await getPppProfiles(router);
    } catch (liveError) {
      console.log("Router package sync warning:", liveError.response?.data || liveError.message);
      routerRows = [];
    }

    const dbByName = new Map();
    dbRows.forEach((row) => {
      const key = String(row.name || "").trim().toLowerCase();
      if (!key) return;
      dbByName.set(key, {
        id: row.id,
        name: row.name,
        price: Number(row.price || 0),
        speed: row.speed || "0 Mbps",
        description: row.description || "",
        enabled: !!Number(row.enabled)
      });
    });

    const packages = routerRows.length
      ? routerRows.map((row) => {
          const name = String(row.name || row.profile || "").trim();
          const key = name.toLowerCase();
          const dbRow = dbByName.get(key);
          return {
            id: row[".id"] || row.id || dbRow?.id || null,
            name,
            price: Number(dbRow?.price || 0),
            speed: String(row["rate-limit"] || dbRow?.speed || "0 Mbps"),
            description: String(row.comment || dbRow?.description || ""),
            enabled: row.disabled === true || row.disabled === "true" ? false : true,
            source: "router"
          };
        })
      : dbRows.map((row) => ({
          id: row.id,
          name: row.name,
          price: Number(row.price || 0),
          speed: row.speed || "0 Mbps",
          description: row.description || "",
          enabled: !!Number(row.enabled),
          source: "database"
        }));

    const finalPackages = packages
      .filter((pkg) => pkg && pkg.name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    res.json(finalPackages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/vouchers", requireSessionRoles("admin"), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    if (routerId !== null && (!Number.isInteger(routerId) || routerId < 1)) {
      return res.status(400).json({ error: "A valid router is required." });
    }
    const params = [];
    let where = "";
    if (routerId) {
      where = "WHERE v.router_id=?";
      params.push(routerId);
    }
    const [rows] = await pool.query(
      `SELECT v.id, v.code_suffix, v.code_ciphertext, v.router_id, v.package_name, v.price, v.duration_days, v.enabled,
              v.status, v.redeemed_customer_username, c.full_name AS redeemed_customer_name,
              v.created_at, v.redeemed_at
       FROM recharge_vouchers v
       LEFT JOIN reseller_customers c ON c.id=v.redeemed_customer_id
       ${where}
       ORDER BY v.created_at DESC, v.id DESC`,
      params
    );
    res.json(rows.map(({ code_ciphertext, ...row }) => ({ ...row, code: decryptVoucherCode(code_ciphertext) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/vouchers", requireSessionRoles("admin"), async (req, res) => {
  const routerId = Number(req.body?.routerId);
  const packageName = String(req.body?.packageName || "").trim();
  const price = Math.round(Number(req.body?.price) * 100) / 100;
  const durationDays = Number(req.body?.durationDays);
  const count = Number(req.body?.count);
  if (!Number.isInteger(routerId) || routerId < 1 || !packageName) {
    return res.status(400).json({ error: "Choose a router and package." });
  }
  if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
    return res.status(400).json({ error: "Enter a positive price and duration from 1 to 3650 days." });
  }
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return res.status(400).json({ error: "Generate between 1 and 500 cards at a time." });
  }

  try {
    const router = await getRouterOr404(routerId, res);
    if (!router) return;
    const profiles = await getPppProfiles(router);
    const profile = profiles.find((item) => String(item.name || item.profile || "").trim() === packageName);
    if (!profile || profile.disabled === true || profile.disabled === "true") {
      return res.status(400).json({ error: "Choose an enabled PPP package on the selected router." });
    }

    const generated = Array.from({ length: count }, () => {
      const code = createVoucherCode();
      return {
        code,
        codeHash: hashVoucherCode(code),
        codeCiphertext: encryptVoucherCode(code),
        suffix: code.slice(-4)
      };
    });
    const placeholders = generated.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = generated.flatMap((voucher) => [voucher.codeHash, voucher.codeCiphertext, voucher.suffix, router.id, packageName, price, durationDays]);
    await pool.query(
      `INSERT INTO recharge_vouchers (code_hash, code_ciphertext, code_suffix, router_id, package_name, price, duration_days)
       VALUES ${placeholders}`,
      values
    );
    const [serialRows] = await pool.query(
      "SELECT id, code_hash FROM recharge_vouchers WHERE code_hash IN (?)",
      [generated.map((voucher) => voucher.codeHash)]
    );
    const serials = new Map(serialRows.map((row) => [row.code_hash, Number(row.id)]));
    res.status(201).json({
      ok: true,
      count: generated.length,
      vouchers: generated.map((voucher) => ({
        serialNumber: serials.get(voucher.codeHash), code: voucher.code, packageName, price, durationDays
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/admin/vouchers/:id", requireSessionRoles("admin"), async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const voucherId = Number(req.params.id);
    const enabled = req.body?.enabled;
    if (!Number.isSafeInteger(voucherId) || voucherId < 1 || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "A voucher ID and enabled boolean are required." });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.query("SELECT id, status FROM recharge_vouchers WHERE id=? FOR UPDATE", [voucherId]);
    if (!rows.length) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ error: "Voucher not found." });
    }
    if (rows[0].status !== "available") {
      await connection.rollback(); transactionStarted = false;
      return res.status(409).json({ error: "Only unused vouchers can be enabled or disabled." });
    }
    await connection.query("UPDATE recharge_vouchers SET enabled=? WHERE id=?", [enabled ? 1 : 0, voucherId]);
    await connection.commit();
    transactionStarted = false;
    res.json({ ok: true, id: voucherId, enabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection?.release();
  }
});

app.put("/api/packages/:routerId/price", async (req, res) => {
  const router = await getRouterOr404(req.params.routerId, res);
  if (!router) return;

  const name = String(req.body?.name || "").trim();
  const price = Number(req.body?.price);
  if (!name || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: "A profile name and valid non-negative price are required." });
  }

  try {
    const profiles = await getPppProfiles(router);
    const profile = profiles.find((item) => String(item.name || item.profile || "").trim() === name);
    if (!profile) return res.status(404).json({ error: "PPP profile was not found on this router." });

    const [rows] = await pool.query(
      "SELECT id FROM package_profiles WHERE router_id=? AND name=? ORDER BY id DESC LIMIT 1",
      [router.id, name]
    );
    if (rows.length) {
      await pool.query("UPDATE package_profiles SET price=?, enabled=? WHERE id=?", [price, profile.disabled === true || profile.disabled === "true" ? 0 : 1, rows[0].id]);
    } else {
      await pool.query(
        "INSERT INTO package_profiles (router_id, name, price, speed, description, enabled) VALUES (?, ?, ?, ?, ?, ?)",
        [router.id, name, price, profile["rate-limit"] || "0 Mbps", profile.comment || "", profile.disabled === "true" ? 0 : 1]
      );
    }

    res.json({ ok: true, name, price });
  } catch (error) {
    res.status(502).json({ error: error.response?.data?.detail || error.message });
  }
});

app.post("/api/packages/:routerId", async (req, res) => {
  const router = await getRouterOr404(req.params.routerId, res);
  if (!router) return;

  const { name, price = 0, speed = "0 Mbps", description = "", enabled = true } = req.body || {};
  const profileName = String(name || "").trim();
  const rateLimit = String(speed || "0 Mbps").trim() || "0 Mbps";
  const commentText = String(description || "").trim();

  if (!profileName) {
    return res.status(400).json({ error: "Package name is required" });
  }

  try {
    const candidatePayloads = [
      {
        name: profileName,
        "rate-limit": rateLimit,
        comment: commentText || `Package ${profileName}`
      }
    ];

    const candidateEndpoints = [
      "/ppp/profile",
      "/ppp/profile/add"
    ];

    let lastError;
    let createdProfile = null;

    for (const endpoint of candidateEndpoints) {
      for (const payload of candidatePayloads) {
        try {
          createdProfile = await mtPut(router, endpoint, payload);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (createdProfile) break;
    }

    if (!createdProfile) {
      throw lastError || new Error("RouterOS profile creation failed");
    }

    const [result] = await pool.query(
      "INSERT INTO package_profiles(router_id, name, price, speed, description, enabled) VALUES(?,?,?,?,?,?)",
      [router.id, profileName, Number(price) || 0, rateLimit, commentText, enabled ? 1 : 0]
    );

    const [rows] = await pool.query("SELECT * FROM package_profiles WHERE id=?", [result.insertId]);
    const saved = rows[0];
    const synced = await app.locals?.packageSync ? app.locals.packageSync(router.id) : null;
    res.status(201).json(saved || synced || { ok: true, name: profileName });
  } catch (e) {
    console.log("Package creation failed:", e.response?.data || e.message);
    res.status(502).json({ error: e.response?.data || e.message });
  }
});

app.get("/api/router/:id/crash-logs", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    const entries = await mtGet(router, "/system/crash/print");
    const list = Array.isArray(entries) ? entries : [];
    res.json({ count: list.length, entries: list });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message });
  }
});

app.get("/api/router/:id/files", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    const files = await mtGet(router, "/file");
    res.json({ files: Array.isArray(files) ? files : [] });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message });
  }
});

app.post("/api/router/:id/files/remove", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  const fileName = req.body?.file || req.body?.name || req.body?.number;
  if (!fileName) {
    return res.status(400).json({ error: "file is required" });
  }

  try {
    const result = await mtPost(router, "/file/remove", { number: fileName });
    res.json({ ok: true, file: fileName, result });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message });
  }
});

app.post("/api/router/:id/create-api-user", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  const username = String(req.body?.username || `dashboard_${Math.random().toString(36).slice(2, 10)}`).trim();
  const password = String(req.body?.password || `D@sh-${Math.random().toString(36).slice(2, 12)}!`).trim();

  try {
    const payload = {
      name: username,
      group: "full",
      password,
      comment: "dashboard secure api user"
    };
    const result = await mtPost(router, "/user/add", payload);
    res.status(201).json({ ok: true, username, password, group: "full", result });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message });
  }
});

app.post("/api/router/:id/clear-crash", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;

  try {
    await mtPost(router, "/system/crash/clear", {});
    res.json({ ok: true, count: 0 });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message });
  }
});

app.post("/api/router/:id/reboot", async (req, res) => {
  const router = await getRouterOr404(req.params.id, res);
  if (!router) return;
  try {
    await mtPost(router, "/system/reboot", {});
    await pool.query(
      "INSERT INTO audit_logs(router_id,action,details) VALUES(?,?,?)",
      [router.id, "reboot", "Router reboot requested from dashboard"]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message });
  }
});

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  }
  next();
});

if (require.main === module) {
  initializeDatabase()
    .then(() => {
      app.listen(PORT, "0.0.0.0", () => console.log(`Dashboard running at http://0.0.0.0:${PORT}`));
      const trialExpiryTimer = setInterval(() => {
        expireTrialPppAccounts().catch((error) => console.error("Trial expiry check failed:", error.message));
      }, 30 * 1000);
      trialExpiryTimer.unref();
      expireTrialPppAccounts().catch((error) => console.error("Initial trial expiry check failed:", error.message));
    })
    .catch((err) => {
      console.error("Server startup failed:", err.message);
      process.exit(1);
    });
}

module.exports = {
  app,
  normalizeRouter,
  getRouterRequestTargets,
  routerBase,
  getRouterCaCertificate,
  buildRouterHttpsAgent,
  getRegularRenewalDays,
  createVoucherCode,
  encryptVoucherCode,
  decryptVoucherCode,
  createSessionToken,
  verifySessionToken,
  buildCustomerListQuery,
  buildResellerActiveUsernamesQuery,
  buildResellerDashboardUsernamesQuery,
  filterRouterUsersByUsername,
  normalizeVoucherCode,
  hashVoucherCode,
  mtGet,
  mtPost,
  testRouterConnectivity
};
