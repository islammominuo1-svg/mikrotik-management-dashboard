# MikroTik Management Dashboard

A full-stack MikroTik management dashboard styled after the supplied RouterOS dashboard image.

## Stack
- Frontend: HTML5, CSS3, Vanilla JavaScript
- Node.js: Express API + MySQL
- PHP: alternative REST API implementation using MySQLi + cURL
- Database: MySQL 8+
- MikroTik: RouterOS v7 REST API over HTTPS

## Features
- Router list / selection
- System resource cards: CPU, memory, uptime
- Total RX/TX traffic
- Active sessions: Hotspot, DHCP leases, VPN
- CPU history chart
- Live bandwidth chart
- Firewall activity chart
- Interfaces table
- IP addresses table
- Firewall rules table
- Dark RouterOS-style responsive UI
- Stores router connection profiles in MySQL
- Node.js API and PHP API are both included

## 1. Database
Create a database and import:

```sql
CREATE DATABASE mikrotik_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mikrotik_manager;
SOURCE database/schema.sql;
```

Create the first administrator directly in MySQL, using your own credentials, then sign in and add routers through the dashboard. For example: `INSERT INTO admins (username, password_hash, full_name, email, role, is_active) VALUES ('your-admin', SHA2('choose-a-strong-password', 256), 'Administrator', 'admin@your-domain', 'superadmin', 1);`. The schema and server startup do not create demo accounts, routers, customers, or payments.

## 2. Node.js API
PowerShell (run these commands from the repository root; existing `.env` files are preserved):
```powershell
Set-Location server
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd install
npm.cmd start
```

Linux/macOS:
```bash
cd server
[ -f .env ] || cp .env.example .env
npm install
npm start
```

The customer list is role-scoped on the API: admins can see all non-deleted customers, while a reseller can see only active, non-deleted PPPoE customers assigned to that reseller. Active PPPoE sessions are filtered against the same reseller assignment, so one reseller cannot see another reseller's sessions.

Open:
http://localhost:3000

Voucher codes are encrypted in the database. The Node API creates
`server/.voucher-encryption-key` on first admin sign-in or voucher generation unless
`VOUCHER_ENCRYPTION_KEY` is configured. Back up that key together with the
database; losing it prevents previously generated voucher codes from being
viewed or printed again.

## 3. MikroTik RouterOS REST API
For RouterOS v7, enable the HTTPS REST service and create a management user.

Example RouterOS commands (adjust to your security policy):
```routeros
/ip service set www-ssl disabled=no
```

The dashboard expects a base URL such as:
`https://192.168.88.1/rest`

For a real deployment, use HTTPS and a dedicated least-privilege RouterOS account. Do not expose RouterOS management ports to the public internet.

When `verify_tls` is enabled for a router using a private RouterOS CA, set
`MIKROTIK_CA_CERT` in `server/.env` to a local PEM CA certificate path. The
dashboard keeps hostname verification enabled; configure the router `host` to
match a DNS name or IP address present in the server certificate. A certificate
whose subject does not match the configured host cannot be safely used by the
dashboard without reissuing the RouterOS certificate.

RouterOS REST GET requests wait up to 15 seconds by default. If a router needs
more time to respond, set `MIKROTIK_GET_TIMEOUT_MS` in `server/.env` to a
larger positive value and restart the Node.js API. A timeout with no HTTP status
means the router did not respond within that interval; also verify network
reachability and that its HTTPS REST service is available.

Router connections are saved in the dashboard's database; `MIKROTIK_HOST` and
related variables in `.env` do not automatically create or select a router.
The Node API uses HTTPS only: a router reachable on HTTP port 80 must also have
its HTTPS REST service enabled on port 443 (or another configured HTTPS port).

## 4. PHP version
Put the `php` folder under Apache/Nginx/PHP or PHP's built-in server:

```bash
php -S localhost:8080 -t php
```

Set the database/MikroTik values in `php/config.php`.

The PHP dashboard API is intentionally kept separate from the Node API so you can choose either backend.

## Important
The dashboard displays records stored in the database and live RouterOS data from configured routers. No demo records or default credentials are created. Create an administrator account in MySQL before signing in.
