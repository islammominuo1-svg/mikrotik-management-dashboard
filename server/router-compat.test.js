const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildRouterHttpsAgent,
  getRouterCaCertificate,
  getRouterRequestTargets,
  getRegularRenewalDays,
  createVoucherCode,
  encryptVoucherCode,
  decryptVoucherCode,
  createSessionToken,
  verifySessionToken,
  normalizeVoucherCode,
  hashVoucherCode
} = require('./server');

test('regular recharge completes the 30-day term after a 5-day emergency extension', () => {
  assert.equal(getRegularRenewalDays(1), 25);
  assert.equal(5 + getRegularRenewalDays(1), 30);
});

test('regular recharge adds 30 days when emergency extension was not used', () => {
  assert.equal(getRegularRenewalDays(0), 30);
});

test('voucher codes normalize case and separators before hashing', () => {
  const formattedCode = '0012-345678';
  assert.equal(normalizeVoucherCode(formattedCode), '0012345678');
  assert.equal(hashVoucherCode(formattedCode), hashVoucherCode('0012345678'));
});

test('generated recharge voucher codes contain exactly ten digits', () => {
  for (let index = 0; index < 25; index += 1) {
    assert.match(createVoucherCode(), /^\d{10}$/);
  }
});

test('voucher card codes are encrypted in storage and recoverable for reprinting', () => {
  const previousKey = process.env.VOUCHER_ENCRYPTION_KEY;
  process.env.VOUCHER_ENCRYPTION_KEY = 'voucher-test-key';
  try {
    const code = '0012345678';
    const ciphertext = encryptVoucherCode(code);
    assert.notEqual(ciphertext, code);
    assert.equal(decryptVoucherCode(ciphertext), code);
  } finally {
    if (previousKey === undefined) delete process.env.VOUCHER_ENCRYPTION_KEY;
    else process.env.VOUCHER_ENCRYPTION_KEY = previousKey;
  }
});

test('signed sessions validate and reject tampering', () => {
  const previousKey = process.env.VOUCHER_ENCRYPTION_KEY;
  process.env.VOUCHER_ENCRYPTION_KEY = 'voucher-session-test-key';
  try {
    const token = createSessionToken({ role: 'customer', customerId: 123 });
    assert.deepEqual(verifySessionToken(token).customerId, 123);
    assert.equal(verifySessionToken(`${token.slice(0, -1)}x`), null);
  } finally {
    if (previousKey === undefined) delete process.env.VOUCHER_ENCRYPTION_KEY;
    else process.env.VOUCHER_ENCRYPTION_KEY = previousKey;
  }
});

test('RouterOS requests use HTTPS only, including routers configured on port 80', () => {
  assert.deepEqual(getRouterRequestTargets({ host: 'router.invalid', port: 443 }), [
    { protocol: 'https', port: 443, url: 'https://router.invalid:443/rest' }
  ]);
  assert.deepEqual(getRouterRequestTargets({ host: 'router.invalid', port: 80 }), [
    { protocol: 'https', port: 443, url: 'https://router.invalid:443/rest' }
  ]);
  assert.deepEqual(getRouterRequestTargets({ host: 'router.invalid', port: 8443 }), [
    { protocol: 'https', port: 8443, url: 'https://router.invalid:8443/rest' }
  ]);
});

test('buildRouterHttpsAgent enables legacy-compatible TLS for older RouterOS devices', () => {
  const agent = buildRouterHttpsAgent({ host: '10.164.135.87', port: 443, verify_tls: true });

  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(agent.options.ciphers, 'DEFAULT:@SECLEVEL=0');
  assert.equal(agent.options.minVersion, 'TLSv1');
  assert.equal(agent.options.servername, undefined);
});

test('buildRouterHttpsAgent keeps SNI for DNS router hosts', () => {
  const agent = buildRouterHttpsAgent({ host: 'router.example.test', port: 443, verify_tls: true });

  assert.equal(agent.options.servername, 'router.example.test');
});

test('buildRouterHttpsAgent loads the configured local CA certificate', () => {
  const certificatePath = path.join(__dirname, 'certs', 'mikrotik-ca.crt');
  assert.equal(fs.existsSync(certificatePath), true);

  const agent = buildRouterHttpsAgent({
    host: 'ServerCert',
    port: 443,
    verify_tls: true
  });

  assert.equal(Buffer.isBuffer(agent.options.ca), true);
  assert.equal(agent.options.ca.length > 0, true);
  assert.equal(getRouterCaCertificate().equals(agent.options.ca), true);
});
