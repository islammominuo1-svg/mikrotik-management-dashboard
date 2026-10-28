const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCustomerListQuery,
  buildResellerActiveUsernamesQuery,
  buildResellerDashboardUsernamesQuery,
  filterRouterUsersByUsername
} = require("./server");

test("admin customer listing includes active and inactive non-deleted customers", () => {
  const query = buildCustomerListQuery({ role: "admin", adminId: 7 });

  assert.deepEqual(query.params, []);
  assert.match(query.sql, /WHERE c\.deleted_at IS NULL/);
  assert.doesNotMatch(query.sql, /is_active\s*=\s*1/i);
  assert.match(query.sql, /LEFT JOIN resellers/);
});

test("reseller customer listing limits results to its own assigned active non-deleted customers", () => {
  const query = buildCustomerListQuery({ role: "reseller", resellerId: 12 }, "12");

  assert.deepEqual(query.params, [12]);
  assert.match(query.sql, /reseller_id=\?/);
  assert.match(query.sql, /is_active=1/);
  assert.match(query.sql, /deleted_at IS NULL/);
});

test("reseller cannot list another reseller's customers", () => {
  assert.equal(buildCustomerListQuery({ role: "reseller", resellerId: 12 }, "13"), null);
});

test("non-reseller sessions cannot use the reseller customer-list policy", () => {
  assert.equal(buildCustomerListQuery({ role: "customer", customerId: 12 }, "12"), null);
  assert.equal(buildCustomerListQuery(null, "12"), null);
});

test("only admins can query a reseller's own active usernames", () => {
  const query = buildResellerActiveUsernamesQuery({ role: "admin", adminId: 7 }, "12");

  assert.deepEqual(query.params, [12]);
  assert.match(query.sql, /reseller_id=\?/);
  assert.match(query.sql, /is_active=1/);
  assert.match(query.sql, /deleted_at IS NULL/);
  assert.equal(buildResellerActiveUsernamesQuery({ role: "reseller", resellerId: 12 }, "12"), null);
  assert.equal(buildResellerActiveUsernamesQuery({ role: "admin", adminId: 7 }, "invalid"), null);
});

test("reseller dashboard only queries its own active PPPoE usernames", () => {
  const query = buildResellerDashboardUsernamesQuery({ role: "reseller", resellerId: 12 });

  assert.deepEqual(query.params, [12]);
  assert.match(query.sql, /reseller_id=\?/);
  assert.match(query.sql, /is_active=1/);
  assert.match(query.sql, /deleted_at IS NULL/);
  assert.equal(buildResellerDashboardUsernamesQuery({ role: "admin", adminId: 7 }), null);
});

test("reseller dashboard router users are limited to its active customer usernames", () => {
  const allowedUsernames = new Set(["reseller-user"]);
  const routerUsers = [
    { user: "Reseller-User" },
    { name: "other-reseller-user" }
  ];

  assert.deepEqual(filterRouterUsersByUsername(routerUsers, allowedUsernames), [{ user: "Reseller-User" }]);
  assert.deepEqual(filterRouterUsersByUsername(null, allowedUsernames), []);
});
