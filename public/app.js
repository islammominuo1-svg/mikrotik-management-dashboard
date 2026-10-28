const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  user: null,
  userRole: null,
  activePage: "dashboard",
  selectedRouter: null,
  routers: [],
  dashboard: {},
  activeConnections: [],
  activeUserResellerFilter: "",
  activeUserResellerUsernames: null,
  customers: [],
  deletedCustomers: [],
  resellers: [],
  packages: [],
  payments: [],
  paymentEvents: [],
  vouchers: [],
  generatedVouchers: [],
  voucherView: "list",
  paymentFilterTab: "all"
};

const renewalsInFlight = new Set();

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value ?? "";
}

function showToast(message, type = "success") {
  let toast = $(".toast-msg");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast-msg";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

function showStatus(message, visible = true) {
  const element = $("#status");
  if (!element) return;
  element.textContent = message || "";
  element.classList.toggle("show", !!visible && !!message);
}

function fmtMoney(value) {
  return `BDT ${Number(value || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString("en-GB");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function fmtMem(value) {
  let bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let unit = -1;
  do { bytes /= 1024; unit += 1; } while (bytes >= 1024 && unit < units.length - 1);
  return `${bytes.toFixed(1)} ${units[unit]}`;
}

async function api(url, options = {}) {
  let sessionToken = "";
  for (const key of ["userSession", "adminSession", "resellerSession"]) {
    try {
      sessionToken = JSON.parse(localStorage.getItem(key) || "null")?.sessionToken || "";
    } catch { sessionToken = ""; }
    if (sessionToken) break;
  }
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function checkAuth() {
  const session = localStorage.getItem("userSession") || localStorage.getItem("adminSession") || localStorage.getItem("resellerSession");
  if (!session) {
    window.location.href = "/login.html";
    return false;
  }
  try {
    state.user = JSON.parse(session);
  } catch {
    localStorage.removeItem("userSession");
    window.location.href = "/login.html";
    return false;
  }
  state.userRole = state.user.role === "admin"
    ? "admin"
    : state.user.role === "reseller"
      ? "reseller"
      : localStorage.getItem("adminSession") ? "admin" : "reseller";
  renderUserInterface();
  return true;
}

function renderUserInterface() {
  const isAdmin = state.userRole === "admin";
  setText("#headerUserName", state.user?.fullName || state.user?.username || "User");
  setText("#headerAvatar", (state.user?.fullName || state.user?.username || "U").slice(0, 1).toUpperCase());
  setText("#headerRoleTag", isAdmin ? "Administrator" : "Reseller");
  setText("#topbarPortalBadge", isAdmin ? "Admin Portal" : "Reseller Portal");
  setText("#summaryOnlineLabel", isAdmin ? "Total Online Payments" : "Total Admin Online Received Payment");
  setText("#summaryCashLabel", isAdmin ? "Total Cash Receive" : "Total Admin Cash Receive");
  setText("#summaryPendingLabel", isAdmin ? "Total Pending Reseller Funds" : "Total Cash in Hand");
  $$(".admin-only").forEach((element) => element.classList.toggle("hidden", !isAdmin));
  $$(".reseller-only").forEach((element) => element.classList.toggle("hidden", isAdmin));
  if (!isAdmin) updateResellerAccountStatusUI(state.user?.isActive !== false);
}

function updateResellerAccountStatusUI(isActive) {
  const headerToggle = $("#accountStatusToggle");
  const bannerToggle = $("#bannerStatusToggle");
  if (headerToggle) headerToggle.checked = !!isActive;
  if (bannerToggle) bannerToggle.checked = !!isActive;
  setText("#accountStatusBadge", isActive ? "Active" : "Inactive");
  setText("#bannerTitle", isActive ? "Reseller Account: Active" : "Reseller Account: Inactive");
  setText("#bannerDesc", isActive ? "Your account is active." : "Your account is inactive.");
  const banner = $("#accountStatusBanner");
  if (banner) banner.classList.toggle("deactivated", !isActive);
}

async function handleResellerSelfToggle(event) {
  const toggles = [$("#accountStatusToggle"), $("#bannerStatusToggle")].filter(Boolean);
  try {
    const result = await api(`/api/reseller/${state.user.id}/toggle-active`, { method: "POST" });
    state.user.isActive = !!result.isActive;
    localStorage.setItem("userSession", JSON.stringify(state.user));
    localStorage.setItem("resellerSession", JSON.stringify(state.user));
    updateResellerAccountStatusUI(result.isActive);
  } catch (error) {
    toggles.forEach((toggle) => { toggle.checked = !event.target.checked; });
    showToast(error.message, "error");
  }
}

function getSelectedRouterId() {
  return state.selectedRouter || $("#routerSelect")?.value || state.routers?.[0]?.id || null;
}

async function loadRouters() {
  state.routers = await api("/api/routers");
  const select = $("#routerSelect");
  if (select) select.innerHTML = state.routers.map((router) => `<option value="${router.id}">${router.name}</option>`).join("");

  const preferred = state.routers.find((router) => String(router.id) === String(state.selectedRouter));
  const candidates = preferred
    ? [preferred, ...state.routers.filter((router) => String(router.id) !== String(preferred.id))]
    : state.routers;
  state.selectedRouter = null;
  for (const router of candidates) {
    try {
      await api(`/api/router/${router.id}/ppp/secrets`);
      state.selectedRouter = router.id;
      break;
    } catch (error) {
      console.warn(`Router ${router.id} is unavailable for PPPoE management:`, error.message);
    }
  }
  if (!state.selectedRouter && candidates.length) state.selectedRouter = candidates[0].id;
  if (select && state.selectedRouter) select.value = String(state.selectedRouter);
}

async function loadDashboardData() {
  if (!state.selectedRouter) return;
  state.dashboard = await api(`/api/dashboard/${state.selectedRouter}`);
  const data = state.dashboard;
  state.activeConnections = data.activeConnections || [];
  setText("#uptime", data.resource?.uptime || "—");
  setText("#freeMem", fmtMem(Math.max(0, Number(data.resource?.memoryTotal || 0) - Number(data.resource?.memoryUsed || 0))));
  setText("#rx", data.traffic?.rxText || fmtMem(data.traffic?.rxBytes));
  setText("#tx", data.traffic?.txText || fmtMem(data.traffic?.txBytes));
  setText("#activeUsersCount", data.activeConnections?.length || 0);
  setText("#adminTotalUserCount", data.pppUsers?.length || 0);
  setText("#adminActiveUserCount", data.activeConnections?.length || 0);
  setText("#adminInactiveUserCount", Math.max(0, (data.pppUsers?.length || 0) - (data.activeConnections?.length || 0)));
  const cpu = Number(data.resource?.cpu || 0);
  setText("#systemCpuValue", `${cpu}%`);
  setText("#cpuLegend", `${cpu}%`);
  setText("#memLegend", `${Number(data.resource?.memoryPercent || 0).toFixed(0)}%`);
  drawTrafficAreaChart($("#trafficChart"), [Number(data.traffic?.rxBytes || 0)], [Number(data.traffic?.txBytes || 0)]);
}

function drawTrafficAreaChart(canvas, rxSeries = [], txSeries = []) {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width = canvas.clientWidth || 300;
  const height = canvas.height = canvas.clientHeight || 160;
  context.clearRect(0, 0, width, height);
  const max = Math.max(1, ...rxSeries, ...txSeries);
  [rxSeries, txSeries].forEach((series, index) => {
    context.beginPath();
    context.strokeStyle = index ? "#8aa0b0" : "#3fc1ff";
    context.lineWidth = 2;
    series.forEach((value, point) => {
      const x = series.length < 2 ? width / 2 : (point / (series.length - 1)) * width;
      const y = height - (Number(value) / max) * (height - 10) - 5;
      if (point === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  });
}

function renderDashboardPaymentSummary() {
  const payments = state.payments || [];
  const events = state.paymentEvents || [];
  const online = payments.filter((payment) => payment.payment_channel === "online")
    .reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0);
  const cashReceived = payments.filter((payment) => payment.payment_channel === "cash")
    .reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0);
  const cardRechargePayments = payments.filter((payment) => payment.payment_channel === "card")
    .reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0);
  const pendingResellerFunds = payments
    .filter((payment) => payment.payment_channel === "cash" && ["processing", "partial", "pending"].includes(payment.status))
    .reduce((sum, payment) => sum + Math.max(0, Number(payment.amount || 0) - Number(payment.paid_amount || 0)), 0);
  const emergencyUsers = (state.customers || []).filter((customer) => Number(customer.emergency_extend_used) === 1).length;
  setText("#summaryTotalPayments", fmtMoney(online + cashReceived + cardRechargePayments));
  setText("#summaryOnlinePayments", fmtMoney(online));
  setText("#summaryProcessingCash", fmtMoney(cashReceived));
  setText("#summaryCardRechargePayments", fmtMoney(cardRechargePayments));
  setText("#summaryPendingResellerFunds", fmtMoney(pendingResellerFunds));
  setText("#summaryEmergencyUsers", emergencyUsers);

  const now = new Date();
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const isInMonth = (value, monthStart) => {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.getFullYear() === monthStart.getFullYear() && date.getMonth() === monthStart.getMonth();
  };
  const cashReceiptEvents = events.filter((event) => ["cash_received_full", "cash_received_partial"].includes(event.event_type));
  const cashReceiptPaymentIds = new Set(cashReceiptEvents.map((event) => Number(event.payment_id)).filter(Boolean));
  const receivedForMonth = (monthStart) => {
    const onlineAmount = payments.filter((payment) => payment.payment_channel === "online" && isInMonth(payment.payment_date, monthStart))
      .reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0);
    const cashEventAmount = cashReceiptEvents.filter((event) => isInMonth(event.created_at, monthStart))
      .reduce((sum, event) => sum + Number(event.amount || 0), 0);
    const legacyCashAmount = payments.filter((payment) => payment.payment_channel === "cash" && !cashReceiptPaymentIds.has(Number(payment.id)) && isInMonth(payment.payment_date, monthStart))
      .reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0);
    const cardRechargeAmount = payments.filter((payment) => payment.payment_channel === "card" && isInMonth(payment.payment_date, monthStart))
      .reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0);
    return onlineAmount + cashEventAmount + legacyCashAmount + cardRechargeAmount;
  };
  const currentAmount = receivedForMonth(currentStart);
  const previousAmount = receivedForMonth(previousStart);
  setText("#summaryPreviousMonthAmount", fmtMoney(previousAmount));
  const trend = $("#summaryMonthTrend");
  if (trend) {
    let label;
    let trendClass;
    if (previousAmount === 0 && currentAmount > 0) {
      label = String.fromCharCode(8593) + " New income this month - " + fmtMoney(currentAmount);
      trendClass = "trend-new";
    } else if (previousAmount === 0) {
      label = String.fromCharCode(8594) + " No income in either month - " + fmtMoney(currentAmount);
      trendClass = "trend-even";
    } else {
      const change = ((currentAmount - previousAmount) / previousAmount) * 100;
      const arrow = change > 0 ? String.fromCharCode(8593) : change < 0 ? String.fromCharCode(8595) : String.fromCharCode(8594);
      const sign = change > 0 ? "+" : "";
      label = arrow + " Current month " + sign + change.toFixed(1) + "% - " + fmtMoney(currentAmount);
      trendClass = change > 0 ? "trend-up" : change < 0 ? "trend-down" : "trend-even";
    }
    trend.className = "summary-kpi-desc " + trendClass;
    setText("#summaryMonthTrend", label);
  }
}

async function loadResellers() {
  state.resellers = await api("/api/resellers");
}

async function loadCustomers() {
  const endpoint = state.userRole === "admin" ? "/api/admin/customers" : `/api/reseller/${state.user.id}/customers`;
  const customers = await api(endpoint);
  state.customers = Array.isArray(customers) ? customers : [];
  setText("#summaryEmergencyUsers", state.customers.filter((customer) => Number(customer.emergency_extend_used) === 1).length);
  setText("#kpiTotalPppUsers", state.customers.length);
  setText("#kpiActivePppUsers", state.customers.filter((customer) => Number(customer.is_active ?? customer.isActive) === 1).length);
  setText("#kpiInactivePppUsers", state.customers.filter((customer) => Number(customer.is_active ?? customer.isActive) !== 1).length);
}

async function loadDeletedCustomers() {
  const endpoint = state.userRole === "admin" ? "/api/admin/customers/deleted" : `/api/reseller/${state.user.id}/customers/deleted`;
  state.deletedCustomers = await api(endpoint);
}

async function loadPayments() {
  const endpoint = state.userRole === "admin" ? "/api/admin/payments" : `/api/reseller/${state.user.id}/payments`;
  state.payments = await api(endpoint);
  const eventEndpoint = state.userRole === "admin" ? "/api/admin/payment-events" : `/api/reseller/${state.user.id}/payment-events`;
  state.paymentEvents = await api(eventEndpoint);
  setText("#kpiTotalPayments", fmtMoney((state.payments || []).reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0)));
  renderDashboardPaymentSummary();
}

async function loadPackages() {
  if (!state.selectedRouter) return;
  state.packages = await api(`/api/packages/${state.selectedRouter}`);
}

async function loadVouchers() {
  if (state.userRole !== "admin" || !state.selectedRouter) return;
  state.vouchers = await api("/api/admin/vouchers");
}

function renderResellerManagementPage() {
  const panel = $("#detailPanel");
  if (!panel) return;
  const resellers = state.resellers || [];
  panel.innerHTML = `
    <div class="table-head"><div><h2 style="font-size:20px;">Reseller List</h2></div>
      <div style="display:flex;gap:10px;"><input id="resellerSearch" class="search-input" placeholder="Search resellers..."><button class="primary" id="openAddResellerBtn">+ Add Reseller</button></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Full Name</th><th>Username</th><th>Mobile</th><th>Email</th><th>Zone</th><th>User Count</th><th>Total Payments</th><th>Online Payments</th><th>Cash Receive Payment</th><th>Voucher Recharge Payment</th><th>Pending Reseller Funds</th><th>Status</th><th>Toggle</th><th>Action</th></tr></thead><tbody id="resellerTableBody">${renderResellerRows(resellers)}</tbody></table></div>`;
  $("#resellerSearch")?.addEventListener("input", (event) => {
    const query = event.target.value.toLowerCase().trim();
    const filtered = resellers.filter((reseller) => [reseller.fullName, reseller.username, reseller.mobile, reseller.zone].some((value) => String(value || "").toLowerCase().includes(query)));
    const tbody = $("#resellerTableBody");
    if (tbody) tbody.innerHTML = renderResellerRows(filtered);
  });
  $("#openAddResellerBtn")?.addEventListener("click", () => $("#addResellerModal")?.classList.remove("hidden"));
}

function renderResellerDashboardPage() {
  const panel = $("#detailPanel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="table-head"><div><h2>My Customers</h2><span>Manage your customer accounts and subscription status.</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Full Name</th><th>Username</th><th>Mobile</th><th>Package</th><th>Expiry Date</th><th>Emergency Data</th><th>Status</th></tr></thead>
    <tbody>${renderResellerDashboardRows(state.customers || [])}</tbody></table></div>`;
}

function renderResellerDashboardRows(customers) {
  if (!customers?.length) return '<tr><td colspan="8">No customers found.</td></tr>';
  return customers.map((customer, index) => `<tr><td>${index + 1}</td><td>${customer.full_name || "—"}</td><td>${customer.username || "—"}</td><td>${customer.mobile || "—"}</td><td>${customer.package_name || "—"}</td><td>${fmtDate(customer.expiry_date)}</td><td>${Number(customer.emergency_extend_used) ? "Used" : "Available"}</td><td>${Number(customer.is_active) ? "Active" : "Inactive"}</td></tr>`).join("");
}

function renderAdminDashboardPage() {
  const panel = $("#detailPanel");
  if (!panel) return;
  const data = state.dashboard || {};
  if (state.activePage === "interfaces") {
    const rows = (data.interfaces || []).map((item) => `<tr><td>${item.name || "—"}</td><td>${item.type || "—"}</td><td>${item.disabled === "true" ? "Disabled" : "Enabled"}</td><td>${fmtMem(item["rx-byte"])}</td><td>${fmtMem(item["tx-byte"])}</td><td>${item["mac-address"] || "—"}</td></tr>`).join("");
    panel.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Interface</th><th>Type</th><th>Status</th><th>Download</th><th>Upload</th><th>MAC Address</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No interfaces found.</td></tr>'}</tbody></table></div>`;
    return;
  }
  panel.innerHTML = "";
}

function renderRouterControlPage() {
  const panel = $("#detailPanel");
  if (!panel) return;
  const routerId = state.selectedRouter || 1;
  panel.innerHTML = `<div class="table-head"><h2>Router Diagnostics</h2><button class="search" id="clearCrashDirectBtn">Clear Crash Logs</button><button class="search" id="rebootRouterDirectBtn">Reboot Router</button></div><pre id="diagnosticOutput">Checking router connectivity...</pre>`;
  api(`/api/router/${routerId}/test`).then((result) => setText("#diagnosticOutput", result.ok ? `Connected to ${result.host}:${result.port}` : (result.error || "Router connection failed"))).catch((error) => setText("#diagnosticOutput", error.message));
  $("#clearCrashDirectBtn")?.addEventListener("click", async () => { try { await api(`/api/router/${routerId}/clear-crash`, { method: "POST" }); showToast("Crash logs cleared."); } catch (error) { showToast(error.message, "error"); } });
  $("#rebootRouterDirectBtn")?.addEventListener("click", async () => { if (!confirm("Reboot this router?")) return; try { await api(`/api/router/${routerId}/reboot`, { method: "POST" }); showToast("Reboot command sent."); } catch (error) { showToast(error.message, "error"); } });
}

function renderResellerRows(resellers) {
  if (!resellers || !resellers.length) {
    return '<tr><td colspan="15" style="text-align:center;padding:24px;color:#8ea4b3;">কোনো রিসেলার পাওয়া যায়নি।</td></tr>';
  }

  return resellers.map((r, i) => {
    const customerCount = (state.customers || []).filter((customer) => Number(customer.reseller_id) === Number(r.id)).length;
    const resellerPayments = (state.payments || []).filter((payment) => {
      if (payment.payment_type === "customer" && payment.customer_username) {
        const customer = (state.customers || []).find((item) => item.username === payment.customer_username);
        if (customer) return Number(customer.reseller_id) === Number(r.id);
      }
      return Number(payment.reseller_id) === Number(r.id);
    });
    const onlinePayment = resellerPayments
      .filter((payment) => payment.payment_channel === "online")
      .reduce((total, payment) => total + Number(payment.paid_amount || (payment.status === "paid" ? payment.amount : 0) || 0), 0);
    const cashReceivePayment = resellerPayments
      .filter((payment) => payment.payment_channel === "cash")
      .reduce((total, payment) => total + Number(payment.paid_amount || 0), 0);
    const voucherRechargePayment = resellerPayments
      .filter((payment) => payment.payment_channel === "card")
      .reduce((total, payment) => total + Number(payment.paid_amount || 0), 0);
    const totalPayment = cashReceivePayment + onlinePayment + voucherRechargePayment;
    const pendingResellerFunds = resellerPayments
      .filter((payment) => payment.payment_channel === "cash" && ["processing", "partial", "pending"].includes(payment.status))
      .reduce((total, payment) => total + Math.max(0, Number(payment.amount || 0) - Number(payment.paid_amount || 0)), 0);
    return `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${r.fullName || "—"}</strong></td>
      <td><code>${r.username || "—"}</code></td>
      <td>${r.mobile || "—"}</td>
      <td>${r.email || "—"}</td>
      <td>${r.zone || "—"}</td>
      <td>${customerCount}</td>
      <td class="money-total">${fmtMoney(totalPayment)}</td>
      <td class="money-online">${fmtMoney(onlinePayment)}</td>
      <td class="money-cash-receive-payment">${fmtMoney(cashReceivePayment)}</td>
      <td class="money-voucher-recharge-payment">${fmtMoney(voucherRechargePayment)}</td>
      <td class="money-pending-reseller-funds">${fmtMoney(pendingResellerFunds)}${pendingResellerFunds > 0 ? ` <button class="primary" style="padding:3px 8px;font-size:11px;" onclick="openResellerCashWaiting(${r.id})">Confirm Cash</button>` : ""}</td>
      <td>
        <span class="badge-status ${r.isActive ? 'badge-active' : 'badge-inactive'}">
          ${r.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td>
        <label class="switch" title="রিসেলার অ্যাকাউন্ট অ্যাক্টিভ বা ডিঅ্যাক্টিভ করুন">
          <input type="checkbox" ${r.isActive ? 'checked' : ''} onchange="toggleResellerStatusByAdmin(${r.id}, this)">
          <span class="slider"></span>
        </label>
      </td>
      <td>
        
        <button class="search" style="padding:2px 8px;font-size:11px;" onclick="showToast('${r.fullName || r.username} রিসেলার আইডি: ${r.id}')">বিবরণ</button>
      </td>
    </tr>
  `;
  }).join("");
}

window.openResellerReceivePayment = function(resellerId) {
  const reseller = (state.resellers || []).find((item) => Number(item.id) === Number(resellerId));
  const modal = $("#resellerReceivePaymentModal");
  const form = $("#resellerReceivePaymentForm");
  if (!reseller || !modal || !form) return;
  form.reset();
  form.dataset.resellerId = String(resellerId);
  setText("#resellerReceivePaymentName", `${reseller.fullName || reseller.username} (${reseller.username})`);
  modal.classList.remove("hidden");
};

window.toggleResellerStatusByAdmin = async function(resellerId, checkbox) {
  try {
    const res = await api(`/api/reseller/${resellerId}/toggle-active`, { method: "POST" });
    showToast(`রিসেলার অ্যাকাউন্ট সফলভাবে ${res.isActive ? "অ্যাক্টিভ" : "ডিঅ্যাক্টিভ"} করা হয়েছে!`);
    await loadResellers();
    renderResellerManagementPage();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    showToast(`স্ট্যাটাস পরিবর্তন ব্যর্থ: ${err.message}`, "error");
  }
};

// Packages Page (Synced to MikroTik RouterOS /ppp/profile)
function renderPackagePage() {
  const panel = $("#detailPanel");
  if (!panel) return;

  const packages = state.packages || [];

  panel.innerHTML = `
    <div class="table-head">
      <div>
        <h2 style="font-size:20px;color:#fff;">Package Profile</h2>
      </div>
      <button class="primary" id="openPackageModalBtn">+ নতুন প্যাকেজ তৈরি করুন</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>প্যাকেজ নাম</th>
            <th>BDT</th>
            <th>Rate Limit</th>
            <th>স্ট্যাটাস</th>
            <th>কমেন্ট / বিবরণ</th>
          </tr>
        </thead>
        <tbody>
          ${packages.map(p => `
            <tr>
              <td><strong>${p.name}</strong></td>
              <td>
                <div style="display:flex;align-items:center;gap:6px;">
                  <input class="package-price-input" type="number" min="0" step="0.01" value="${Number(p.price) || 0}" aria-label="${p.name} price" style="width:100px;height:30px;background:#111a21;color:#fff;border:1px solid #43515a;border-radius:4px;padding:0 8px;">
                  <button class="search save-package-price-btn" type="button" data-profile-name="${encodeURIComponent(p.name)}" style="height:30px;">Save</button>
                </div>
              </td>
              <td><code>${p.speed || "—"}</code></td>
              <td><span class="badge-pill paid">Active</span></td>
              <td>${p.description || "MikroTik Sync"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  panel.querySelectorAll(".save-package-price-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const profileName = decodeURIComponent(button.dataset.profileName || "");
      const price = Number(button.closest("tr")?.querySelector(".package-price-input")?.value);
      const routerId = getSelectedRouterId();
      if (!routerId) { showToast("Add a router before saving package prices.", "error"); return; }
      try {
        await api(`/api/packages/${routerId}/price`, {
          method: "PUT",
          body: JSON.stringify({ name: profileName, price })
        });
        showToast(`${profileName} profile-এর মূল্য ${fmtMoney(price)} সংরক্ষণ হয়েছে।`);
        await loadPackages();
        renderPackagePage();
      } catch (err) {
        showToast(`Profile price সংরক্ষণ ব্যর্থ: ${err.message}`, "error");
      }
    });
  });

  const openBtn = $("#openPackageModalBtn");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      const modal = $("#packageModal");
      if (modal) modal.classList.remove("hidden");
    });
  }
}

function renderVoucherGeneratorPage() {
  const panel = $("#detailPanel");
  if (!panel) return;
  const packages = (state.packages || []).filter((item) => item.name && item.enabled !== false);
  const cards = (state.vouchers || []).map((voucher) => `
    <article class="voucher-card">
      <div class="voucher-card-top"><div class="voucher-brand">Ena It Net<small>Internet Service</small></div><span class="voucher-serial">Serial No. ${Number(voucher.id)}</span></div>
      <h3>Recharge Card</h3>
      <div class="voucher-package-name">${escapeHtml(voucher.package_name)}</div>
      <div class="voucher-card-details"><span>Recharge Amount<strong>${fmtMoney(voucher.price)}</strong></span><span>Validity<strong>${Number(voucher.duration_days)} days</strong></span></div>
      <div class="voucher-code-label">10-Digit Voucher Code</div><code class="voucher-code">${escapeHtml(voucher.code || "Code unavailable")}</code>
      <div class="voucher-card-footer">${fmtDate(voucher.created_at)} · ${voucher.status === "used" ? "Used" : Number(voucher.enabled) ? "Enabled" : "Disabled"}</div>
    </article>
  `).join("");
  const voucherRows = (state.vouchers || []).map((voucher) => `
    <tr>
      <td>${Number(voucher.id)}</td>
      <td><code>******${escapeHtml(voucher.code_suffix)}</code></td>
      <td>${escapeHtml(voucher.package_name)}</td>
      <td>${fmtMoney(voucher.price)}</td>
      <td>${Number(voucher.duration_days)} days</td>
      <td><span class="badge-pill ${voucher.status === "available" && Number(voucher.enabled) ? "paid" : "due"}">${voucher.status === "used" ? "Used" : voucher.status === "available" ? Number(voucher.enabled) ? "Enabled" : "Disabled" : escapeHtml(voucher.status)}</span></td>
      <td>${escapeHtml(voucher.redeemed_customer_name || voucher.redeemed_customer_username || "—")}</td>
      <td>${fmtDate(voucher.created_at)}</td>
      <td>${voucher.status === "available" ? `<button class="search" type="button" data-toggle-voucher="${Number(voucher.id)}" data-enabled="${Number(voucher.enabled) ? "false" : "true"}">${Number(voucher.enabled) ? "Disable" : "Enable"}</button>` : "—"}</td>
    </tr>
  `).join("");

  panel.innerHTML = `
    <div class="table-head voucher-toolbar"><div><h2 style="font-size:20px;color:#fff;">Voucher Generator</h2></div><button class="primary" id="voucherPagePdfBtn" type="button">Download Full Page PDF</button></div>
    <form id="voucherGeneratorForm" class="package-form">
      <div class="package-form-grid">
        <label>Package<select name="packageName" required ${packages.length ? "" : "disabled"}>
          ${packages.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join("") || '<option value="">No enabled PPP packages</option>'}
        </select></label>
        <label>Card Count<input name="count" type="number" min="1" max="500" value="10" required></label>
        <label>Price (BDT)<input name="price" type="number" min="0.01" step="0.01" value="${Number(packages[0]?.price) || ""}" required></label>
        <label>Validity (days)<input name="durationDays" type="number" min="1" max="3650" value="30" required></label>
      </div>
      <div class="package-form-actions"><button class="primary" type="submit" ${packages.length ? "" : "disabled"}>Generate Cards</button></div>
    </form>
    <div class="table-head voucher-toolbar" style="margin-top:24px;"><div><h2 style="font-size:16px;color:#fff;">All Cards (${state.vouchers.length})</h2></div><div style="display:flex;gap:8px;"><button class="search" id="voucherListViewBtn" type="button">List View</button><button class="search" id="voucherCardViewBtn" type="button">Card View</button><button class="search" id="copyVoucherCodesBtn" type="button">Copy Codes</button><button class="search" id="downloadVoucherCodesBtn" type="button">Download CSV</button><button class="primary" id="printVoucherCardsBtn" type="button">Print Cards</button><button class="search" id="refreshVouchersBtn" type="button">Refresh</button></div></div>
    ${state.voucherView === "cards"
      ? `<div class="voucher-grid" id="voucherCardsView">${cards || '<div class="empty-state">No cards generated.</div>'}</div>`
      : `<div class="table-wrap" id="voucherListView"><table><thead><tr><th>Serial</th><th>Code</th><th>Package</th><th>Price</th><th>Validity</th><th>Date</th><th>Status</th><th>Used By</th><th>Action</th></tr></thead><tbody>${voucherRows || '<tr><td colspan="9" style="text-align:center;padding:20px;">No cards generated.</td></tr>'}</tbody></table></div>`}`;

  const form = $("#voucherGeneratorForm");
  form?.elements.packageName?.addEventListener("change", () => {
    const selected = packages.find((item) => item.name === form.elements.packageName.value);
    if (selected && Number(selected.price) > 0) form.elements.price.value = Number(selected.price);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    if (!submitButton || submitButton.disabled) return;
    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = "Generating...";
    try {
      const values = new FormData(form);
      const result = await api("/api/admin/vouchers", {
        method: "POST",
        body: JSON.stringify({
          routerId: Number(state.selectedRouter),
          packageName: String(values.get("packageName") || ""),
          count: Number(values.get("count")),
          price: Number(values.get("price")),
          durationDays: Number(values.get("durationDays"))
        })
      });
      state.generatedVouchers = result.vouchers || [];
      await loadVouchers();
      state.voucherView = "cards";
      renderVoucherGeneratorPage();
      showToast(`${result.count} recharge cards generated.`);
    } catch (error) {
      showToast(`Voucher generation failed: ${error.message}`, "error");
      submitButton.disabled = false;
      submitButton.textContent = originalText;
    }
  });
  $("#refreshVouchersBtn")?.addEventListener("click", async () => {
    try { await loadVouchers(); renderVoucherGeneratorPage(); }
    catch (error) { showToast(error.message, "error"); }
  });
  $("#copyVoucherCodesBtn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.vouchers.map((voucher) => voucher.code).filter(Boolean).join("\n"));
      showToast("Voucher codes copied.");
    } catch { showToast("Could not copy voucher codes.", "error"); }
  });
  $("#printVoucherCardsBtn")?.addEventListener("click", () => {
    if (state.voucherView !== "cards") {
      state.voucherView = "cards";
      renderVoucherGeneratorPage();
    }
    const clearPrintMode = () => document.body.classList.remove("voucher-printing");
    document.body.classList.add("voucher-printing");
    window.addEventListener("afterprint", clearPrintMode, { once: true });
    window.print();
  });
  $("#voucherListViewBtn")?.addEventListener("click", () => { state.voucherView = "list"; renderVoucherGeneratorPage(); });
  $("#voucherCardViewBtn")?.addEventListener("click", () => { state.voucherView = "cards"; renderVoucherGeneratorPage(); });
  $("#voucherPagePdfBtn")?.addEventListener("click", () => {
    const clearPrintMode = () => document.body.classList.remove("voucher-page-printing");
    document.body.classList.add("voucher-page-printing");
    window.addEventListener("afterprint", clearPrintMode, { once: true });
    window.print();
  });
  panel.querySelectorAll("[data-toggle-voucher]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/admin/vouchers/${button.dataset.toggleVoucher}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: button.dataset.enabled === "true" })
        });
        await loadVouchers();
        renderVoucherGeneratorPage();
        showToast("Voucher status updated.");
      } catch (error) {
        button.disabled = false;
        showToast(error.message, "error");
      }
    });
  });
  $("#downloadVoucherCodesBtn")?.addEventListener("click", () => {
    const csv = ["SerialNumber,Code,Package,Price,ValidityDays,CreatedAt,Status", ...state.vouchers.map((voucher) =>
      [voucher.id, voucher.code, voucher.package_name, voucher.price, voucher.duration_days, voucher.created_at, voucher.status === "used" ? "Used" : Number(voucher.enabled) ? "Enabled" : "Disabled"].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")
    )].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "recharge-vouchers.csv";
    link.click();
    URL.revokeObjectURL(url);
  });
}

// Router Action & Logs Page (Admin)
function renderRouterControlPage() {
  const panel = $("#detailPanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="table-head">
      <div>
        <h2 style="font-size:15px;color:#fff;">Admin Access</h2>
        <span style="font-size:12px;color:#8ba2b2;">সরাসরি RouterOS নিয়ন্ত্রণ, লগ পরিষ্কার ও রিবুট সুবিধা</span>
      </div>
      <div style="display:flex;gap:10px;">
        <button class="search" id="rebootRouterDirectBtn" style="color:#fca5a5;border-color:#7d3535;">⚡ রাউটার রিবুট করুন</button>
        <button class="primary" id="clearCrashDirectBtn">🧹 ক্যাশ ও জাঙ্ক লগ ক্লিন</button>
      </div>
    </div>
    <div style="padding:16px;background:#15222c;border:1px solid #293a47;border-radius:8px;margin-top:10px;">
      <h3 style="font-size:14px;color:#eaf2f8;margin-bottom:10px;">রাউটার কানেক্টিভিটি ও ডায়াগনস্টিক রিপোর্ট</h3>
      <div id="diagnosticOutput" style="font-family:monospace;font-size:12px;color:#9eb5c4;background:#0d1822;padding:12px;border-radius:6px;line-height:1.6;">
        ডায়াগনস্টিক তথ্য লোড হচ্ছে...
      </div>
    </div>
  `;

  // Test Connectivity
  const routerId = state.selectedRouter || 1;
  api(`/api/router/${routerId}/test`)
    .then((diag) => {
      const out = $("#diagnosticOutput");
      if (out) {
        out.innerHTML = `
          Host IP: <b>${diag.host}:${diag.port}</b><br>
          TCP Connection: <span style="color:#3fe497;">${diag.connectivity?.detail || 'Reachable'}</span><br>
          REST API Status: <span style="color:${diag.ok ? '#3fe497' : '#fca5a5'}">${diag.permissions?.message || 'Ready'}</span><br>
          Connected User: <b>admin</b> (Full Access Permission)
        `;
      }
    })
    .catch(() => {
      const out = $("#diagnosticOutput");
      if (out) out.innerHTML = `<span style="color:#fca5a5;">MikroTik রাউটারে সরাসরি যুক্ত হতে পারেনি। লোকাল ডেমো মোডে সক্রিয় আছে।</span>`;
    });

  // Reboot Handler
  const rebBtn = $("#rebootRouterDirectBtn");
  if (rebBtn) {
    rebBtn.addEventListener("click", async () => {
      if (!confirm("আপনি কি নিশ্চিত MikroTik রাউটারটি রিবুট করতে চান?")) return;
      try {
        await api(`/api/router/${routerId}/reboot`, { method: "POST" });
        showToast("MikroTik রাউটার রিবুট কমান্ড সফলভাবে পাঠানো হয়েছে!", "success");
      } catch (err) {
        showToast(`রিবুট ব্যর্থ: ${err.message}`, "error");
      }
    });
  }

  // Clear Junk Handler
  const clrBtn = $("#clearCrashDirectBtn");
  if (clrBtn) {
    clrBtn.addEventListener("click", async () => {
      try {
        await api(`/api/router/${routerId}/clear-crash`, { method: "POST" });
        showToast("রাউটার জাঙ্ক ও ক্র্যাশ ফাইল সফলভাবে ক্লিন করা হয়েছে!");
      } catch (err) {
        showToast(`ক্লিন ব্যর্থ: ${err.message}`, "error");
      }
    });
  }
}

// Active Users Page
function renderActiveUsersPage() {
  const panel = $("#detailPanel");
  if (!panel) return;

  const resellerActiveUsernames = state.userRole === "reseller"
    ? new Set((state.customers || [])
      .filter((customer) => Number(customer.is_active ?? customer.isActive) === 1)
      .map((customer) => String(customer.username || "").trim().toLowerCase()))
    : null;
  const users = (state.activeConnections || []).filter((user) =>
    !resellerActiveUsernames ||
    resellerActiveUsernames.has(String(user.user || user.name || "").trim().toLowerCase())
  );
  const resellerFilter = state.userRole === "admin"
    ? `<select id="activeUserResellerFilter" class="search-input" aria-label="Filter active users by reseller">
        <option value="">All resellers</option>
        ${(state.resellers || []).map((reseller) => `<option value="${escapeHtml(reseller.id)}" ${String(reseller.id) === state.activeUserResellerFilter ? "selected" : ""}>${escapeHtml(reseller.fullName || reseller.username || `Reseller ${reseller.id}`)}</option>`).join("")}
      </select>`
    : "";

  panel.innerHTML = `
    <div class="table-head">
      <div>
        <h2 style="font-size:20px;color:#fff;">Active Users</h2>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        ${resellerFilter}
        <input type="text" id="activeUserSearch" class="search-input" placeholder="ইউজারনেম বা আইপি খুঁজুন...">
        <button class="search" id="detailRefresh">রিফ্রেশ ↻</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Username</th>
            <th>Local IP</th>
            <th>Remote IP</th>
            <th>Uptime</th>
            <th>সার্ভিস</th>
            <th>স্ট্যাটাস</th>
            <th>অ্যাকশন</th>
          </tr>
        </thead>
        <tbody id="activeUsersTbody">
          ${renderActiveUsersRows(users)}
        </tbody>
      </table>
    </div>
  `;

  const updateRows = () => {
    const query = ($("#activeUserSearch")?.value || "").toLowerCase().trim();
    const selectedResellerId = state.userRole === "admin" ? state.activeUserResellerFilter : "";
    const ownedActiveUsernames = selectedResellerId && Array.isArray(state.activeUserResellerUsernames)
      ? new Set(state.activeUserResellerUsernames.map((username) => String(username).trim().toLowerCase()))
      : selectedResellerId ? new Set() : null;
    const filtered = users.filter((user) => {
      const name = String(user.user || user.name || "");
      const remoteAddress = String(user["remote-address"] || user.remoteAddress || "");
      const localAddress = String(user["local-address"] || user.localAddress || "");
      const matchesSearch = name.toLowerCase().includes(query) ||
        remoteAddress.toLowerCase().includes(query) ||
        localAddress.toLowerCase().includes(query);
      const matchesReseller = !ownedActiveUsernames || ownedActiveUsernames.has(name.trim().toLowerCase());
      return matchesSearch && matchesReseller;
    });
    const tbody = $("#activeUsersTbody");
    if (tbody) tbody.innerHTML = renderActiveUsersRows(filtered);
  };

  const searchInput = $("#activeUserSearch");
  searchInput?.addEventListener("input", updateRows);
  $("#activeUserResellerFilter")?.addEventListener("change", async (event) => {
    const resellerId = event.target.value;
    state.activeUserResellerFilter = resellerId;
    state.activeUserResellerUsernames = null;
    if (!resellerId) {
      updateRows();
      return;
    }
    updateRows();
    try {
      const usernames = await api(`/api/admin/resellers/${encodeURIComponent(resellerId)}/active-usernames`);
      if (state.activeUserResellerFilter !== resellerId) return;
      state.activeUserResellerUsernames = Array.isArray(usernames) ? usernames : [];
      updateRows();
    } catch (error) {
      if (state.activeUserResellerFilter !== resellerId) return;
      state.activeUserResellerUsernames = [];
      updateRows();
      showToast(`রিসেলারের অ্যাক্টিভ ইউজার লোড করা যায়নি: ${error.message}`, "error");
    }
  });
  if (state.userRole === "admin" && state.activeUserResellerFilter && state.activeUserResellerUsernames === null) {
    $("#activeUserResellerFilter").dispatchEvent(new Event("change"));
  } else {
    updateRows();
  }

  const refreshBtn = $("#detailRefresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      await loadDashboardData();
      renderActiveUsersPage();
      showToast("অ্যাক্টিভ ইউজার তালিকা রিফ্রেশ করা হয়েছে।");
    });
  }
}

function renderActiveUsersRows(users) {
  if (!users || !users.length) {
    return '<tr><td colspan="8" style="text-align:center;padding:24px;color:#8ea4b3;">বর্তমানে কোনো সক্রিয় (অনলাইন) ইউজার নেই।</td></tr>';
  }

  return users.map((u, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${u.user || u.name || "—"}</strong></td>
      <td><code>${u["local-address"] || u.localAddress || "—"}</code></td>
      <td><code>${u["remote-address"] || u.remoteAddress || "—"}</code></td>
      <td>${u.uptime || "—"}</td>
      <td>${u.service || "PPPoE"}</td>
      <td><span class="badge-pill online">Online</span></td>
      <td>
        <button class="search" style="padding:3px 8px;font-size:11px;" onclick="showToast('${u.user || u.name} সেশন সক্রিয় রয়েছে', 'success')">বিবরণ</button>
      </td>
    </tr>
  `).join("");
}

// PPUsers Page
function renderPppPage() {
  const panel = $("#detailPanel");
  if (!panel) return;

  const customers = state.customers || [];
  const isAdmin = state.userRole === "admin";
  const availableResellers = (state.resellers || []).filter((reseller) => Number(reseller.is_active ?? reseller.isActive) === 1);
  const routerProfiles = (state.packages || []).filter((pkg) => pkg.source === "router" && pkg.enabled !== false && pkg.name);

  panel.innerHTML = `
    <div class="table-head">
      <div>
        <h2 style="font-size:20px;color:#fff;">PPPoE User List</h2>
      </div>
      <div style="display:flex;gap:10px;">
        <input type="text" id="customerSearch" class="search-input" placeholder="Search customers...">
        <button class="primary" id="showAddCustomerBtn">+ Add Customer</button>
      </div>
    </div>

    <!-- Add Customer Form -->
    <div id="addCustomerWrap" class="package-form-wrap hidden">
      <form id="addCustomerForm" class="package-form">
        <h3 style="margin:0 0 10px;font-size:14px;color:#eaf2f8;">+ Add PPPoE Customer</h3>
        <div class="package-form-grid">
          <label>Full Name*
            <input name="fullName" required placeholder="মোঃ জহিরুল ইসলাম">
          </label>
          <label>Username / User ID*
            <input name="username" required>
          </label>
          <label>Password*
            <input name="password" type="password" required placeholder="******">
          </label>
          <label>Confirm Password*
            <input name="confirmPassword" type="password" required placeholder="******">
          </label>
          <label>Mobile*
            <input name="mobile" required placeholder="017XXXXXXXX">
          </label>
          <label>Email
            <input name="email" type="email">
          </label>
          <label>Package Profile*
            <select name="packageName" required style="height:35px;background:#111a21;color:#fff;border:1px solid #43515a;border-radius:4px;padding:0 9px;">
              ${routerProfiles.length
                ? routerProfiles.map((pkg) => `<option value="${pkg.name}">${pkg.name}${Number(pkg.price) ? ` (${fmtMoney(pkg.price)})` : ""}</option>`).join("")
                : '<option value="" disabled selected>রাউটারে কোনো PPP profile পাওয়া যায়নি</option>'}
            </select>
          </label>
          ${isAdmin ? `
            <label>Assign to Reseller*
              <select name="resellerId" required style="height:35px;background:#111a21;color:#fff;border:1px solid #43515a;border-radius:4px;padding:0 9px;">
                <option value="" disabled selected>${availableResellers.length ? "Select reseller" : "No active reseller available"}</option>
                ${availableResellers.map((reseller) => `<option value="${reseller.id}">${reseller.fullName || reseller.username}</option>`).join("")}
              </select>
              ${availableResellers.length ? "" : '<small class="hint">Create or activate a reseller before adding a customer.</small>'}
            </label>
          ` : ""}
          <label>Area*
            <input name="area" required placeholder="ধানমন্ডি, ঢাকা">
          </label>
        </div>
        <div class="package-form-actions">
          <button class="primary" type="submit" ${isAdmin && !availableResellers.length ? "disabled" : ""}>Save Customer</button>
          <button type="button" class="search" id="cancelAddCustomerBtn">Cancel</button>
        </div>
      </form>
    </div>

    <div class="table-wrap">
      <table>
                <thead>
          <tr>
            <th>#</th><th>Full Name</th><th>Username</th>
            ${isAdmin ? '<th>Reseller</th>' : ''}
            <th>Mobile</th><th>Package</th><th>Expiry</th><th>Emergency Data</th><th>Status</th><th>On/Off</th><th>Subscription</th><th>Action</th>
          </tr>
        </thead>
        <tbody id="customersTbody">
          ${renderCustomersRows(customers, isAdmin)}
        </tbody>
      </table>
    </div>

    <div class="table-head" style="margin-top:20px;">
      <div>
        <h2 style="font-size:15px;color:#fff;">Deleted PPPoE Users</h2>
        <span style="font-size:12px;color:#8ba2b2;">Deleted users are saved here and can be restored.</span>
      </div>
      <button class="search" id="refreshDeletedCustomersBtn">Refresh ↻</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Username</th>${isAdmin ? "<th>Reseller</th>" : ""}<th>Package</th><th>Deleted At</th><th>Action</th></tr></thead>
        <tbody>${renderDeletedCustomerRows(state.deletedCustomers, isAdmin)}</tbody>
      </table>
    </div>

    <div id="restorePaymentModal" class="modal hidden">
      <div class="modal-box">
        <button id="closeRestorePaymentModal" class="close" type="button">×</button>
        <h2>PPPoE Restore Payment</h2>
        <p id="restoreCustomerLabel" style="color:#9fb0bb;margin:0 0 12px;"></p>
        <form id="restorePaymentForm">
          <label>Payment Method*
            <select name="paymentMethod" id="restorePaymentMethod" required style="width:100%;height:35px;background:#111a21;color:#fff;border:1px solid #43515a;border-radius:4px;padding:0 9px;">
              <option value="Cash">Cash</option>
              <option value="bKash">bKash</option>
              <option value="card">Card Recharge</option>
            </select>
          </label>
          <label id="restoreReceiverLabel">Receiver Name
            <input name="receiverName" id="restoreReceiverName">
          </label>
          <label id="restoreAmountLabel">Amount (BDT)*
            <input name="amount" id="restorePaymentAmount" type="number" min="0.01" step="0.01" required placeholder="500">
          </label>
          <label id="restorePackageLabel">Matched PPP Profile*
            <select name="packageName" id="restorePaymentPackage" required disabled style="width:100%;height:35px;background:#111a21;color:#fff;border:1px solid #43515a;border-radius:4px;padding:0 9px;">
              <option value="">Enter payment amount</option>
              ${routerProfiles.map((pkg) => `<option value="${pkg.name}" data-price="${Number(pkg.price) || 0}">${pkg.name} — ${fmtMoney(pkg.price)}</option>`).join("")}
            </select>
          </label>
          <small id="restoreProfileMatchMessage" style="display:block;color:#9fb0bb;margin-top:-6px;">A profile will be selected when the amount matches its price.</small>
          <label id="restoreTrxLabel" class="hidden">Transaction ID<input name="trxId" id="restoreTrxId" placeholder="bKash / Nagad / Rocket TrxID"></label>
          <label id="restoreVoucherCodeLabel" class="hidden">Recharge Card Code<input name="voucherCode" id="restoreVoucherCode" type="text" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" minlength="10" autocomplete="off" placeholder="10-digit card code"></label>
          <div class="package-form-actions">
            <button class="primary" type="submit">Save Payment & Restore</button>
            <button class="search" id="cancelRestorePayment" type="button">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const refreshDeletedBtn = $("#refreshDeletedCustomersBtn");
  if (refreshDeletedBtn) {
    refreshDeletedBtn.addEventListener("click", async () => {
      await loadDeletedCustomers();
      renderPppPage();
    });
  }

  const restorePaymentModal = $("#restorePaymentModal");
  const restorePaymentForm = $("#restorePaymentForm");
  const restoreMethod = restorePaymentForm?.elements.paymentMethod;
  if (restoreMethod) {
    const methods = state.userRole === "admin"
      ? [{ value: "Cash", label: "Cash" }, { value: "bKash", label: "bKash" }]
      : [{ value: "Cash", label: "Cash" }, { value: "card", label: "Card Recharge" }];
    restoreMethod.replaceChildren(...methods.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
  }
  const updateRestoreMethodFields = () => {
    const isCard = restoreMethod?.value === "card";
    const isBkash = state.userRole === "admin" && restoreMethod?.value === "bKash";
    $("#restoreAmountLabel")?.classList.toggle("hidden", isCard);
    $("#restorePackageLabel")?.classList.toggle("hidden", isCard);
    $("#restoreProfileMatchMessage")?.classList.toggle("hidden", isCard);
    $("#restoreTrxLabel")?.classList.toggle("hidden", !isBkash);
    $("#restoreVoucherCodeLabel")?.classList.toggle("hidden", !isCard);
    $("#restoreReceiverLabel")?.classList.toggle("hidden", isBkash || isCard);
    if ($("#restoreTrxId")) $("#restoreTrxId").required = isBkash;
    if ($("#restoreReceiverName")) $("#restoreReceiverName").required = !isBkash && !isCard;
    if ($("#restorePaymentAmount")) $("#restorePaymentAmount").required = !isCard;
    if ($("#restorePaymentPackage")) $("#restorePaymentPackage").required = !isCard;
    if ($("#restoreVoucherCode")) $("#restoreVoucherCode").required = isCard;
  };
  restoreMethod?.addEventListener("change", updateRestoreMethodFields);
  updateRestoreMethodFields();
  const closeRestorePayment = () => restorePaymentModal?.classList.add("hidden");
  $("#closeRestorePaymentModal")?.addEventListener("click", closeRestorePayment);
  $("#cancelRestorePayment")?.addEventListener("click", closeRestorePayment);
  restorePaymentModal?.addEventListener("click", (event) => {
    if (event.target === restorePaymentModal) closeRestorePayment();
  });

  $("#restorePaymentAmount")?.addEventListener("input", () => {
    const amount = Number($("#restorePaymentAmount").value);
    const matched = routerProfiles.find((pkg) => Number(pkg.price) === amount);
    const packageSelect = $("#restorePaymentPackage");
    const message = $("#restoreProfileMatchMessage");
    if (packageSelect) packageSelect.value = matched?.name || "";
    if (message) {
      message.textContent = matched
        ? `৳ ${amount} এর profile: ${matched.name}`
        : "এই amount-এর সমান price profile পাওয়া যায়নি। আগে Package Profile-এ price সেট করুন।";
      message.style.color = matched ? "#57c7aa" : "#e3a45c";
    }
  });

  restorePaymentForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const customerId = restorePaymentForm.dataset.customerId;
    const formData = new FormData(restorePaymentForm);
    const isCard = formData.get("paymentMethod") === "card";
    const payment = isCard ? {
      paymentMethod: "card",
      voucherCode: String(formData.get("voucherCode") || "").trim()
    } : {
      receiverName: String(formData.get("receiverName") || "").trim(),
      paymentMethod: String(formData.get("paymentMethod") || "Cash"),
      amount: Number(formData.get("amount")),
      packageName: $("#restorePaymentPackage")?.value || "",
      trxId: String(formData.get("trxId") || "").trim()
    };
    if (!isCard && !payment.packageName) {
      showToast("এই টাকার পরিমাণের PPP profile পাওয়া যায়নি।", "error");
      return;
    }
    await restoreDeletedCustomer(customerId, payment);
  });

  const showBtn = $("#showAddCustomerBtn");
  const cancelBtn = $("#cancelAddCustomerBtn");
  const formWrap = $("#addCustomerWrap");
  const form = $("#addCustomerForm");

  if (showBtn) showBtn.addEventListener("click", () => formWrap && formWrap.classList.remove("hidden"));
  if (cancelBtn) cancelBtn.addEventListener("click", () => formWrap && formWrap.classList.add("hidden"));

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const fullName = String(fd.get("fullName") || "").trim();
      const username = String(fd.get("username") || "").trim();
      const password = String(fd.get("password") || "").trim();
      const confirmPassword = String(fd.get("confirmPassword") || "").trim();
      const mobile = String(fd.get("mobile") || "").trim();
      const email = String(fd.get("email") || "").trim();
      const packageName = String(fd.get("packageName") || "").trim();
      const area = String(fd.get("area") || "").trim();

      if (!fullName || !username || !password || !mobile || !packageName || !area) {
        showToast("অনুগ্রহ করে সকল প্রয়োজনীয় তথ্য প্রদান করুন।", "error");
        return;
      }

      if (password !== confirmPassword) {
        showToast("পাসওয়ার্ড এবং কনফার্ম পাসওয়ার্ড মিলছে না।", "error");
        return;
      }

      const resId = state.userRole === "admin" ? Number(fd.get("resellerId")) : Number(state.user.id);
      const routerId = state.selectedRouter || $("#routerSelect")?.value || null;

      try {
        if (!Number.isSafeInteger(resId) || resId <= 0) {
          throw new Error("একজন সক্রিয় reseller নির্বাচন করুন।");
        }
        if (!routerId) throw new Error("কোনো MikroTik রাউটার নির্বাচন করা নেই।");

        await api(`/api/reseller/${resId}/customers`, {
          method: "POST",
          body: JSON.stringify({
            fullName,
            username,
            password,
            mobile,
            email,
            packageName,
            area,
            routerId,
            isActive: 1
          })
        });

        showToast("নতুন পিপিইউজার সফলভাবে তৈরি হয়েছে!");
        form.reset();
        formWrap.classList.add("hidden");
        await loadCustomers();
        await loadPayments();
        renderPppPage();
      } catch (err) {
        showToast(`পিপিইউজার তৈরি ব্যর্থ: ${err.message}`, "error");
      }
    });
  }

  const searchInput = $("#customerSearch");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase().trim();
      const filtered = customers.filter((c) => {
        return (
          (c.full_name || "").toLowerCase().includes(q) ||
          (c.username || "").toLowerCase().includes(q) ||
          (c.mobile || "").toLowerCase().includes(q) ||
          (c.package_name || "").toLowerCase().includes(q)
        );
      });
      const tbody = $("#customersTbody");
      if (tbody) tbody.innerHTML = renderCustomersRows(filtered, isAdmin);
    });
  }

  const renewModal = $("#renewCustomerModal");
  const renewForm = $("#renewCustomerForm");
  const renewMethod = $("#renewPaymentMethod");
  const renewSubmit = renewForm?.querySelector('button[type="submit"]');
  const updateRenewMethodFields = () => {
    const isCard = renewMethod?.value === "card";
    const isBkash = state.userRole === "admin" && renewMethod?.value === "bKash";
    $("#renewAmountLabel")?.classList.toggle("hidden", isCard);
    $("#renewTrxLabel")?.classList.toggle("hidden", !isBkash);
    $("#renewReceiverLabel")?.classList.toggle("hidden", isBkash || isCard);
    $("#renewVoucherCodeLabel")?.classList.toggle("hidden", !isCard);
    const trxInput = $("#renewTrxId");
    const receiverInput = $("#renewReceiverName");
    const amountInput = renewForm?.elements.amount;
    const voucherInput = $("#renewVoucherCode");
    if (trxInput) trxInput.required = isBkash;
    if (receiverInput) receiverInput.required = !isBkash && !isCard;
    if (amountInput) amountInput.required = !isCard;
    if (voucherInput) voucherInput.required = isCard;
  };
  renewMethod?.addEventListener("change", updateRenewMethodFields);
  $("#closeRenewCustomerModal")?.addEventListener("click", () => renewModal?.classList.add("hidden"));
  renewForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!renewSubmit || renewSubmit.disabled) return;
    const renewalCustomerId = String(renewForm.dataset.customerId);
    if (renewalsInFlight.has(renewalCustomerId)) return;
    renewalsInFlight.add(renewalCustomerId);
    const submitLabel = renewSubmit.textContent;
    renewSubmit.disabled = true;
    renewSubmit.textContent = "Saving Renewal...";
    const formData = new FormData(renewForm);
    let renewalSaved = false;
    try {
      const isCard = formData.get("paymentMethod") === "card";
      const result = await api(isCard
        ? `/api/reseller/customer/${renewForm.dataset.customerId}/redeem-voucher`
        : `/api/reseller/customer/${renewForm.dataset.customerId}/renew`, {
        method: "POST",
        body: JSON.stringify(isCard ? {
          requestId: renewForm.dataset.requestId,
          voucherCode: String(formData.get("voucherCode") || "").trim()
        } : {
          requestId: renewForm.dataset.requestId,
          paymentMethod: formData.get("paymentMethod"), amount: Number(formData.get("amount")),
          receiverName: String(formData.get("receiverName") || "").trim(),
          trxId: String(formData.get("trxId") || "").trim()
        })
      });
      renewalSaved = true;
      renewModal?.classList.add("hidden");
      showToast(`${isCard ? "Card recharge" : "Subscription renewal"} applied through ${fmtDate(result.expiry_date)} (${result.appliedDays > 0 ? "+" : ""}${result.appliedDays} days).${result.packageName ? ` Package: ${result.packageName}.` : ""}`);
      await loadCustomers();
      await loadPayments();
      renderPppPage();
    } catch (error) {
      showToast(renewalSaved ? `Renewal saved, but the customer list could not be refreshed: ${error.message}` : `Renewal failed: ${error.message}`, "error");
      if (!renewalSaved) {
        renewSubmit.disabled = false;
        renewSubmit.textContent = submitLabel;
      }
    } finally {
      renewalsInFlight.delete(renewalCustomerId);
      renewSubmit.disabled = false;
      renewSubmit.textContent = submitLabel;
    }
  });
  updateRenewMethodFields();
}

function renderCustomersRows(customers, isAdmin) {
  if (!customers || !customers.length) {
    return `<tr><td colspan="${isAdmin ? 12 : 11}" style="text-align:center;padding:24px;color:#8ea4b3;">No customers found.</td></tr>`;
  }

  return customers.map((c, i) => {
    const expiryDate = String(c.expiry_date || "").slice(0, 10);
    const trialExpiry = c.trial_expires_at
      ? new Date(String(c.trial_expires_at).replace(" ", "T")).toLocaleString()
      : "";
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const deactivated = !Number(c.is_active);
    const expired = !deactivated && expiryDate && expiryDate < todayKey;
    const statusText = deactivated ? "Deactivated" : expired ? "Expired" : "Active";
    return `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${c.full_name || "—"}</strong></td>
      <td><code>${c.username || "—"}</code></td>
      ${isAdmin ? `<td><span class="badge-pill reseller-type">${c.reseller_name || 'Reseller #' + c.reseller_id}</span></td>` : ''}
      <td>${c.mobile || "—"}</td>
      <td><span class="badge-pill paid">${c.package_name || "Standard"}</span></td>
      <td>${trialExpiry ? `Trial until ${trialExpiry}` : fmtDate(c.expiry_date)}<br><small style="color:#91a3ad">Balance: ${Number(c.balance_days || 0)} days</small></td>
      <td><span class="badge-pill ${Number(c.emergency_extend_used) ? 'due' : 'paid'}">${Number(c.emergency_extend_used) ? 'Used' : 'Available'}</span></td>
      <td>
        <span class="badge-pill ${expired || deactivated ? 'due' : 'paid'}" style="${expired || deactivated ? 'color:#ff6b6b' : ''}">
          ${statusText}
        </span>
      </td>
      <td>
        <label class="switch" title="Toggle customer account">
          <input type="checkbox" ${Number(c.is_active) ? 'checked' : ''} onchange="toggleCustomerStatus(${c.id}, this, ${Number(c.router_id) || "null"})">
          <span class="slider"></span>
        </label>
      </td>
      <td style="padding-right:12px;min-width:132px;">
        <button class="primary" data-renew-customer="${c.id}" style="padding:2px 8px;font-size:11px;width:100%;" onclick="openRenewCustomerModal(${c.id})">Renew</button>
        <button class="search" style="padding:2px 8px;font-size:11px;width:100%;margin-top:4px;" onclick="emergencyExtendCustomer(${c.id})" ${Number(c.emergency_extend_used) ? 'disabled title="Available after next recharge"' : ''}>Emergency Extend</button>
      </td>
      <td style="padding-left:12px;"><button class="search" style="padding:2px 8px;font-size:11px;color:#e87070;width:100%;" onclick="deleteCustomer(${c.id}, ${Number(c.router_id) || "null"})">Delete</button>
      </td>
    </tr>
  `;
  }).join("");
}

function renderDeletedCustomerRows(customers, isAdmin) {
  if (!customers || !customers.length) {
    return `<tr><td colspan="${isAdmin ? 6 : 5}" style="text-align:center;padding:24px;color:#8ea4b3;">No deleted PPPoE customers.</td></tr>`
  }

  return customers.map((customer) => `
    <tr>
      <td><strong>${customer.full_name || "—"}</strong></td>
      <td><code>${customer.username || "—"}</code></td>
      ${isAdmin ? `<td>${customer.reseller_name || `Reseller #${customer.reseller_id}`}</td>` : ""}
      <td>${customer.package_name || "—"}</td>
      <td>${fmtDate(customer.deleted_at)}</td>
      <td><button class="primary" style="padding:3px 9px;font-size:11px;" onclick="openRestorePaymentModal(${customer.id})">Restore</button></td>
    </tr>
  `).join("");
}

window.openRenewCustomerModal = function(customerId) {
  const customer = (state.customers || []).find((item) => Number(item.id) === Number(customerId));
  const modal = $("#renewCustomerModal");
  const form = $("#renewCustomerForm");
  const paymentMethodSelect = form?.elements.paymentMethod;
  if (!customer || !modal || !form) return;
  if (renewalsInFlight.has(String(customerId))) { showToast("This customer renewal is already processing.", "error"); return; }
  form.reset();
  const paymentMethods = state.userRole === "admin"
    ? [{ value: "Cash", label: "Cash" }, { value: "bKash", label: "bKash" }, { value: "card", label: "Card Recharge" }]
    : [{ value: "Cash", label: "Cash" }, { value: "card", label: "Card Recharge" }];
  paymentMethodSelect?.replaceChildren(...paymentMethods.map(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  if (paymentMethodSelect) paymentMethodSelect.value = "Cash";
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) { submitButton.disabled = false; submitButton.textContent = "Save Renewal"; }
  form.dataset.customerId = String(customerId);
  form.dataset.requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  setText("#renewCustomerLabel", `${customer.full_name} (${customer.username}) · expires ${fmtDate(customer.expiry_date)}`);
  modal.classList.remove("hidden");
  $("#renewPaymentMethod")?.dispatchEvent(new Event("change"));
};

window.emergencyExtendCustomer = async function(customerId) {
  const customer = (state.customers || []).find((item) => Number(item.id) === Number(customerId));
  if (!customer || Number(customer.emergency_extend_used)) return;
  if (renewalsInFlight.has(String(customerId))) return;
  if (!confirm(`Add 5 emergency days for ${customer.full_name} (${customer.username})?`)) return;
  renewalsInFlight.add(String(customerId));
  try {
    const result = await api(`/api/reseller/customer/${customerId}/emergency-extend`, {
      method: "POST",
      body: JSON.stringify({ requestId: globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}` })
    });
    showToast(`Emergency Extend added 5 days through ${fmtDate(result.expiry_date)}.`);
    await loadCustomers();
    await loadPayments();
    renderPppPage();
  } catch (error) {
    showToast(`Emergency Extend failed: ${error.message}`, "error");
  } finally {
    renewalsInFlight.delete(String(customerId));
  }
};

window.toggleCustomerStatus = async function(customerId, checkbox, routerId) {
  try {
    const result = await api(`/api/reseller/customer/${customerId}/toggle-active`, {
      method: "POST",
      body: JSON.stringify({ routerId: routerId || state.selectedRouter })
    });
    showToast(`কাস্টমার অ্যাকাউন্ট ${result.isActive ? "অ্যাক্টিভ" : "ডিঅ্যাক্টিভ"} করা হয়েছে।`);
    await loadCustomers();
    renderPppPage();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    showToast(`স্ট্যাটাস পরিবর্তন ব্যর্থ: ${err.message}`, "error");
  }
};

window.deleteCustomer = async function(customerId, routerId) {
  if (!confirm("আপনি কি নিশ্চিত এই কাস্টমার ইউজার মুছে ফেলতে চান?")) return;
  try {
    await api(`/api/reseller/customer/${customerId}`, {
      method: "DELETE",
      body: JSON.stringify({ routerId: routerId || state.selectedRouter })
    });
    showToast("MikroTik ও user list থেকে সরানো হয়েছে; Delete History-তে রাখা হয়েছে।");
    await loadCustomers();
    await loadDeletedCustomers();
    renderPppPage();
  } catch (err) {
    showToast(`কাস্টমার মোছা ব্যর্থ: ${err.message}`, "error");
  }
};

window.openRestorePaymentModal = function(customerId) {
  const customer = state.deletedCustomers.find((item) => Number(item.id) === Number(customerId));
  const modal = $("#restorePaymentModal");
  const form = $("#restorePaymentForm");
  if (!customer || !modal || !form) return;

  form.reset();
  form.dataset.customerId = String(customerId);
  setText("#restoreCustomerLabel", `${customer.full_name} (${customer.username})`);
  const originalPackage = state.packages.find((pkg) => pkg.name === customer.package_name && Number(pkg.price) > 0);
  const amountInput = $("#restorePaymentAmount");
  if (amountInput && originalPackage) {
    amountInput.value = String(originalPackage.price);
    amountInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  modal.classList.remove("hidden");
};

window.restoreDeletedCustomer = async function(customerId, payment) {
  try {
    const result = await api(`/api/reseller/customer/${customerId}/restore`, {
      method: "POST",
      body: JSON.stringify(payment)
    });
    showToast(`PPPoE user restored for ${result.expiryDays} days through ${fmtDate(result.expiry_date)}; ${result.packageName}, ${result.paymentMethod} ${fmtMoney(result.amount)} added to payment history.`);
    await loadCustomers();
    await loadDeletedCustomers();
    await loadPayments();
    renderPppPage();
  } catch (err) {
    showToast(`Restore ব্যর্থ: ${err.message}`, "error");
  }
};

// Payment History Page
function renderPaymentHistoryPage() {
  const panel = $("#detailPanel");
  if (!panel) return;

  const payments = state.payments || [];

  let filtered = payments;
  if (state.paymentFilterTab === "reseller") {
    filtered = payments.filter((p) => p.payment_type === "reseller");
  } else if (state.paymentFilterTab === "customer") {
    filtered = payments.filter((p) => p.payment_type === "customer");
  }

  const totalAmount = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const onlineTracked = payments.filter((p) => p.payment_channel === "online").reduce((sum, p) => sum + Number(p.paid_amount || 0), 0);
  const cashWaiting = payments.filter((p) => p.payment_channel === "cash" && ["processing", "partial", "pending"].includes(p.status)).reduce((sum, p) => sum + Math.max(0, Number(p.amount || 0) - Number(p.paid_amount || 0)), 0);
  const dueAmount = payments.filter((p) => p.status === "due").reduce((sum, p) => sum + Math.max(0, Number(p.amount || 0) - Number(p.paid_amount || 0)), 0);

  panel.innerHTML = `
    <div class="tabs-header">
      <div class="tab-group">
        <button class="tab-pill ${state.paymentFilterTab === 'all' ? 'active' : ''}" data-paytab="all">
          সকল পেমেন্ট (${payments.length})
        </button>
        <button class="tab-pill ${state.paymentFilterTab === 'reseller' ? 'active' : ''}" data-paytab="reseller">
          রিসেলারের নিজস্ব পেমেন্ট (${payments.filter(p => p.payment_type === 'reseller').length})
        </button>
        <button class="tab-pill ${state.paymentFilterTab === 'customer' ? 'active' : ''}" data-paytab="customer">
          কাস্টমারদের পেমেন্ট (${payments.filter(p => p.payment_type === 'customer').length})
        </button>
      </div>

      <div style="display:flex;gap:10px;align-items:center;">
        <input type="text" id="paymentSearchInput" class="search-input" placeholder="ইনভয়েস বা নাম খুঁজুন...">
        <button class="primary" id="openPaymentModalBtn">+ পেমেন্ট রেকর্ড করুন</button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ইনভয়েস / Trx ID</th>
            <th>পেমেন্ট ধরন</th>
            <th>গ্রাহক / রিসেলার নাম</th>
            <th>ইউজার আইডি</th>
            <th>প্যাকেজ / বিবরণ</th>
            <th>BDT</th>
            <th>পেমেন্ট মাধ্যম</th>
            <th>Receiver Name</th>
            <th>তারিখ ও সময়</th>
            <th>স্ট্যাটাস</th>
            ${state.userRole === "reseller" ? "<th>অ্যাকশন</th>" : ""}
          </tr>
        </thead>
        <tbody id="paymentsTbody">
          ${renderPaymentRows(filtered)}
        </tbody>
      </table>
    </div>
  `;

  const eventRows = state.paymentEvents.map(e => `<tr><td>${fmtDate(e.created_at)}</td><td>${e.trx_id || `#${e.payment_id}`}</td><td>${e.event_type}</td><td>${fmtMoney(e.amount)}</td><td>${e.status}</td><td>${e.receiver_name || "—"}</td><td>${e.notes || "—"}</td></tr>`).join("") || '<tr><td colspan="7">No payment events recorded.</td></tr>';
  panel.insertAdjacentHTML("beforeend", `<h3 style="margin:18px 0 8px;color:#fff">Payment and processing history</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Transaction</th><th>Event</th><th>Amount</th><th>Status</th><th>Receiver</th><th>Notes</th></tr></thead><tbody>${eventRows}</tbody></table></div>`);

  panel.querySelectorAll("[data-paytab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.paymentFilterTab = btn.getAttribute("data-paytab");
      renderPaymentHistoryPage();
    });
  });

  const searchInput = $("#paymentSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase().trim();
      const searched = filtered.filter((p) => {
        return (
          (p.trx_id || "").toLowerCase().includes(q) ||
          (p.customer_name || "").toLowerCase().includes(q) ||
          (p.customer_username || "").toLowerCase().includes(q) ||
          (p.package_name || "").toLowerCase().includes(q) ||
          (p.payment_method || "").toLowerCase().includes(q) ||
          (p.receiver_name || "").toLowerCase().includes(q)
        );
      });
      const tbody = $("#paymentsTbody");
      if (tbody) tbody.innerHTML = renderPaymentRows(searched);
    });
  }

  const openModalBtn = $("#openPaymentModalBtn");
  if (openModalBtn) {
    openModalBtn.addEventListener("click", () => {
      const resellerSelect = $("#paymentResellerSelect");
      if (resellerSelect) {
        resellerSelect.innerHTML = '<option value="">Select reseller</option>' + (state.resellers || []).map((reseller) =>
          `<option value="${Number(reseller.id)}">${escapeTableValue(reseller.fullName || reseller.username || `Reseller #${reseller.id}`)}</option>`
        ).join("");
      }
      const modal = $("#paymentModal");
      if (modal) modal.classList.remove("hidden");
    });
  }
}

function renderPaymentRows(payments) {
  if (!payments || !payments.length) {
    return `<tr><td colspan="${state.userRole === "reseller" ? 11 : 10}" style="text-align:center;padding:24px;color:#8ea4b3;">No payment records found.</td></tr>`;
  }

  return payments.map((p) => `
    <tr>
      <td><code>${p.trx_id || "TRX-" + p.id}</code></td>
      <td>
        <span class="badge-pill ${p.payment_type === 'reseller' ? 'reseller-type' : 'customer-type'}">
          ${p.payment_type === 'reseller' ? 'রিসেলার পেমেন্ট' : 'কাস্টমার পেমেন্ট'}
        </span>
      </td>
      <td><strong>${p.customer_name || (p.reseller_name ? p.reseller_name : "—")}</strong></td>
      <td><code>${p.customer_username || "—"}</code></td>
      <td>${p.package_name || p.notes || "Standard"}</td>
      <td style="font-weight:700;color:#59e49e;">${fmtMoney(p.amount)} (paid ${fmtMoney(p.paid_amount)})<br><small style="color:#ffb86b">due ${fmtMoney(Math.max(0, Number(p.amount || 0) - Number(p.paid_amount || 0)))}</small></td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:4px;color:#d5e2eb;">
          🏷️ ${p.payment_method || "bKash"}
        </span>
      </td>
      <td>${p.receiver_name || "—"}</td>
      <td>${fmtDate(p.payment_date)}</td>
      <td>
        <span class="badge-pill ${p.status === 'paid' ? 'paid' : 'due'}" style="${p.status === 'paid' ? '' : 'color:#ff6b6b;background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.35);'}">
          ${p.status === 'paid' ? 'পরিশোধিত (Paid)' : 'রিসেলার কানেকশন'}
        </span>
      </td>
      ${state.userRole === "reseller" ? `<td>${p.payment_channel === "cash" && Math.max(0, Number(p.amount || 0) - Number(p.paid_amount || 0)) > 0 ? `<button class="primary" style="padding:3px 8px;font-size:11px;" onclick="openReceiveCashModal(${p.id})">Receive Cash</button>` : "—"}</td>` : ""}
    </tr>
  `).join("");
}

window.openResellerCashWaiting = function(resellerId) {
  const pending = (state.payments || []).filter((payment) =>
    Number(payment.reseller_id) === Number(resellerId) && payment.payment_channel === "cash"
    && ["processing", "partial", "pending"].includes(payment.status)
    && Math.max(0, Number(payment.amount || 0) - Number(payment.paid_amount || 0)) > 0
  ).sort((a, b) => new Date(a.payment_date) - new Date(b.payment_date));
  if (!pending.length) { showToast("No cash is waiting for this reseller."); return; }
  window.openReceiveCashModal(pending[0].id);
};

window.openReceiveCashModal = function(paymentId) {
  const payment = (state.payments || []).find((item) => Number(item.id) === Number(paymentId));
  const modal = $("#receiveCashModal");
  const form = $("#receiveCashForm");
  if (!payment || !modal || !form) return;
  const due = Math.max(0, Number(payment.amount || 0) - Number(payment.paid_amount || 0));
  form.reset();
  form.dataset.paymentId = String(paymentId);
  const amountInput = form.elements.amount;
  amountInput.max = String(due);
  amountInput.value = String(due);
  $("#receiveCashPaymentLabel").textContent = `${payment.customer_name || payment.customer_username} · due ${fmtMoney(due)}`;
  modal.classList.remove("hidden");
};

// -------------------------------------------------------------
// Setup Modals & Action Listeners
// -------------------------------------------------------------
function setupModals() {
  const changePasswordModal = $("#changePasswordModal");
  const changePasswordForm = $("#changePasswordForm");
  const closeChangePassword = () => changePasswordModal?.classList.add("hidden");

  $("#openPasswordModalBtn")?.addEventListener("click", () => {
    changePasswordForm?.reset();
    changePasswordModal?.classList.remove("hidden");
  });
  $("#closeChangePasswordModal")?.addEventListener("click", closeChangePassword);
  changePasswordModal?.addEventListener("click", (event) => {
    if (event.target === changePasswordModal) closeChangePassword();
  });

  changePasswordForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(changePasswordForm);
    const currentPassword = String(formData.get("currentPassword") || "");
    const newPassword = String(formData.get("newPassword") || "");
    const confirmPassword = String(formData.get("confirmPassword") || "");
    if (newPassword !== confirmPassword) {
      showToast("নতুন পাসওয়ার্ড ও নিশ্চিত পাসওয়ার্ড মিলছে না।", "error");
      return;
    }

    try {
      await api("/api/account/change-password", {
        method: "POST",
        body: JSON.stringify({
          accountType: state.userRole,
          accountId: state.user?.id,
          currentPassword,
          newPassword,
          confirmPassword
        })
      });
      changePasswordForm.reset();
      closeChangePassword();
      showToast("পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে।");
    } catch (error) {
      showToast(`পাসওয়ার্ড পরিবর্তন ব্যর্থ: ${error.message}`, "error");
    }
  });

  // Payment Modal
  const payModal = $("#paymentModal");
  const closePayBtn = $("#closePaymentModal");
  const payForm = $("#recordPaymentForm");
  const typeSelect = $("#paymentTypeSelect");
  const paymentMethodSelect = payForm?.elements.paymentMethod;
  const renewalMethodSelect = $("#renewPaymentMethod");
  if (state.userRole === "reseller") {
    [paymentMethodSelect, renewalMethodSelect].forEach((select) => {
      if (!select) return;
      [...select.options].forEach((option) => {
        if (option.value.toLowerCase() !== "cash") option.remove();
      });
      if (select.options[0]) {
        select.options[0].value = "Cash";
        select.options[0].textContent = "Cash Payment";
      }
      select.value = "Cash";
    });
  }

  if (state.userRole === "admin" && payForm && !$("#paymentResellerSelect")) {
    const resellerLabel = document.createElement("label");
    resellerLabel.id = "paymentResellerLabel";
    resellerLabel.textContent = "Reseller";
    const resellerSelect = document.createElement("select");
    resellerSelect.id = "paymentResellerSelect";
    resellerSelect.name = "resellerId";
    resellerSelect.required = true;
    resellerSelect.innerHTML = '<option value="">Select reseller</option>';
    resellerLabel.appendChild(resellerSelect);
    payForm.insertBefore(resellerLabel, payForm.firstChild);
  }

  if (closePayBtn && payModal) {
    closePayBtn.addEventListener("click", () => payModal.classList.add("hidden"));
  }

  if (typeSelect) {
    typeSelect.addEventListener("change", () => {
      const isReseller = typeSelect.value === "reseller";
      const nameInput = $("#paymentCustomerNameInput");
      const userInput = $("#paymentCustomerUsernameInput");

      if (isReseller) {
        if (nameInput) nameInput.value = state.user?.fullName || "রিসেলার ব্যালেন্স রিচার্জ";
        if (userInput) userInput.value = state.user?.username || "reseller";
      } else {
        if (nameInput) nameInput.value = "";
        if (userInput) userInput.value = "";
      }
    });
  }

  if (payForm) {
    payForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(payForm);
      const paymentType = fd.get("paymentType") || "customer";
      const customerName = fd.get("customerName");
      const customerUsername = fd.get("customerUsername");
      const packageName = fd.get("packageName");
      const amount = fd.get("amount");
      const paymentMethod = fd.get("paymentMethod");
      const trxId = fd.get("trxId");
      const status = fd.get("status") || "paid";
      const notes = fd.get("notes");
      const resellerId = state.userRole === "admin"
        ? Number(fd.get("resellerId"))
        : Number(state.user.id);

      if (!amount || Number(amount) <= 0 || !resellerId) {
        showToast("সঠিক পেমেন্টের পরিমাণ দিন।", "error");
        return;
      }

      try {
        const endpoint = state.userRole === "admin"
          ? `/api/admin/resellers/${resellerId}/payments`
          : `/api/reseller/${resellerId}/payments`;
        await api(endpoint, {
          method: "POST",
          body: JSON.stringify({
            paymentType,
            customerName,
            customerUsername,
            packageName,
            amount: Number(amount),
            paymentMethod,
            trxId,
            status,
            notes
          })
        });

        showToast("পেমেন্ট সফলভাবে সংরক্ষিত হয়েছে!");
        payForm.reset();
        if (payModal) payModal.classList.add("hidden");
        await loadPayments();
        if (state.activePage === "paymentHistory") {
          renderPaymentHistoryPage();
        }
      } catch (err) {
        showToast(`পেমেন্ট সংরক্ষণ ব্যর্থ: ${err.message}`, "error");
      }
    });
  }

  const receiveCashModal = $("#receiveCashModal");
  const receiveCashForm = $("#receiveCashForm");
  $("#closeReceiveCashModal")?.addEventListener("click", () => receiveCashModal?.classList.add("hidden"));
  receiveCashForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(receiveCashForm);
    try {
      const receiveEndpoint = state.userRole === "admin"
        ? `/api/admin/payments/${receiveCashForm.dataset.paymentId}/receive-cash`
        : `/api/reseller/${state.user.id}/payments/${receiveCashForm.dataset.paymentId}/receive-cash`;
      const result = await api(receiveEndpoint, {
        method: "POST",
        body: JSON.stringify({ receiverName: String(formData.get("receiverName") || "").trim(), amount: Number(formData.get("amount")) })
      });
      receiveCashModal?.classList.add("hidden");
      showToast(`Cash confirmed. Cash Receive Payment updated; Pending Reseller Funds remaining: ${fmtMoney(result.dueAmount)}.`);
      await loadPayments();
      if (state.activePage === "paymentHistory") renderPaymentHistoryPage();
      if (state.activePage === "resellerManagement") renderResellerManagementPage();
    } catch (error) {
      showToast(`Cash receipt failed: ${error.message}`, "error");
    }
  });

  const resellerReceivePaymentModal = $("#resellerReceivePaymentModal");
  const resellerReceivePaymentForm = $("#resellerReceivePaymentForm");
  $("#closeResellerReceivePaymentModal")?.addEventListener("click", () => resellerReceivePaymentModal?.classList.add("hidden"));
  const resellerMethod = resellerReceivePaymentForm?.elements.paymentMethod;
  const resellerTrx = resellerReceivePaymentForm?.elements.trxId;
  const updateResellerTrxRequirement = () => {
    const needsTrx = resellerMethod?.value !== "Cash";
    if (resellerTrx) resellerTrx.required = needsTrx;
    $("#resellerReceiveTrxField")?.classList.toggle("hidden", !needsTrx);
  };
  resellerMethod?.addEventListener("change", updateResellerTrxRequirement);
  updateResellerTrxRequirement();
  resellerReceivePaymentForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(resellerReceivePaymentForm);
    try {
      await api(`/api/admin/resellers/${resellerReceivePaymentForm.dataset.resellerId}/receive-payment`, {
        method: "POST",
        body: JSON.stringify({
          paymentMethod: data.get("paymentMethod"), amount: Number(data.get("amount")),
          trxId: String(data.get("trxId") || "").trim(), receiverName: String(data.get("receiverName") || "").trim(),
          details: String(data.get("details") || "").trim()
        })
      });
      resellerReceivePaymentModal?.classList.add("hidden");
      showToast("Reseller payment received and added to total payments.");
      await loadPayments();
      if (state.activePage === "resellerManagement") renderResellerManagementPage();
      if (state.activePage === "paymentHistory") renderPaymentHistoryPage();
    } catch (error) {
      showToast(`Reseller payment receive failed: ${error.message}`, "error");
    }
  });

  // Admin Add Reseller Modal
  const addResModal = $("#addResellerModal");
  const closeResBtn = $("#closeAddResellerModal");
  const addResForm = $("#addResellerForm");

  if (closeResBtn && addResModal) {
    closeResBtn.addEventListener("click", () => addResModal.classList.add("hidden"));
  }

  if (addResForm) {
    addResForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(addResForm);
      const fullName = String(fd.get("fullName") || "").trim();
      const username = String(fd.get("username") || "").trim();
      const password = String(fd.get("password") || "").trim();
      const confirmPassword = String(fd.get("confirmPassword") || "").trim();
      const mobile = String(fd.get("mobile") || "").trim();
      const email = String(fd.get("email") || "").trim();
      const zone = String(fd.get("zone") || "").trim();
      const isActive = fd.has("isActive");

      if (!fullName || !username || !password || !mobile || !email || !zone) {
        showToast("সকল প্রয়োজনীয় তথ্য প্রদান করুন।", "error");
        return;
      }

      if (password !== confirmPassword) {
        showToast("পাসওয়ার্ড এবং কনফার্ম পাসওয়ার্ড মিলছে না।", "error");
        return;
      }

      try {
        await api("/api/reseller/register", {
          method: "POST",
          body: JSON.stringify({
            fullName,
            username,
            password,
            confirmPassword,
            mobile,
            email,
            zone,
            isActive
          })
        });

        showToast(`রিসেলার "${fullName}" সফলভাবে তৈরি হয়েছে!`);
        addResForm.reset();
        if (addResModal) addResModal.classList.add("hidden");
        await loadResellers();
        if (state.activePage === "resellerManagement") {
          renderResellerManagementPage();
        }
      } catch (err) {
        showToast(`রিসেলার তৈরি ব্যর্থ: ${err.message}`, "error");
      }
    });
  }

  // Admin Add Router Modal
  const routerModal = $("#routerModal");
  const closeRouterBtn = $("#closeRouterModal");
  const routerForm = $("#routerForm");
  const addRouterBtn = $("#addRouterBtn");

  if (addRouterBtn && routerModal) {
    addRouterBtn.addEventListener("click", () => routerModal.classList.remove("hidden"));
  }
  if (closeRouterBtn && routerModal) {
    closeRouterBtn.addEventListener("click", () => routerModal.classList.add("hidden"));
  }
  if (routerForm) {
    routerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(routerForm);
      const name = fd.get("name");
      const host = fd.get("host");
      const username = fd.get("username");
      const password = fd.get("password");
      const port = fd.get("port") || 443;

      try {
        await api("/api/routers", {
          method: "POST",
          body: JSON.stringify({ name, host, username, password, port, verify_tls: 0 })
        });
        showToast(`MikroTik রাউটার "${name}" সফলভাবে যুক্ত হয়েছে!`);
        routerForm.reset();
        if (routerModal) routerModal.classList.add("hidden");
        await loadRouters();
        await loadDashboardData();
      } catch (err) {
        showToast(`রাউটার যোগ ব্যর্থ: ${err.message}`, "error");
      }
    });
  }

  // Admin Add Package Modal
  const pkgModal = $("#packageModal");
  const closePkgBtn = $("#closePackageModal");
  const pkgForm = $("#packageForm");

  if (closePkgBtn && pkgModal) {
    closePkgBtn.addEventListener("click", () => pkgModal.classList.add("hidden"));
  }
  if (pkgForm) {
    pkgForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(pkgForm);
      const name = fd.get("name");
      const price = fd.get("price");
      const speed = fd.get("speed");
      const description = fd.get("description");

      const routerId = getSelectedRouterId();
      if (!routerId) { showToast("Add a router before creating a package.", "error"); return; }
      try {
        await api(`/api/packages/${routerId}`, {
          method: "POST",
          body: JSON.stringify({ name, price, speed, description, enabled: true })
        });
        showToast(`প্যাকেজ "${name}" সফলভাবে তৈরি ও MikroTik-এ সিঙ্ক হয়েছে!`);
        pkgForm.reset();
        if (pkgModal) pkgModal.classList.add("hidden");
        await loadPackages();
        if (state.activePage === "package") renderPackagePage();
      } catch (err) {
        showToast(`প্যাকেজ তৈরি ব্যর্থ: ${err.message}`, "error");
      }
    });
  }

  // Admin Clear Junk Button
  const clearJunkBtn = $("#clearJunkBtn");
  if (clearJunkBtn) {
    clearJunkBtn.addEventListener("click", async () => {
      const routerId = state.selectedRouter || 1;
      try {
        await api(`/api/router/${routerId}/clear-crash`, { method: "POST" });
        showToast("রাউটার ক্র্যাশ ও জাঙ্ক লগ ফাইল সফলভাবে ক্লিন করা হয়েছে!");
      } catch (err) {
        showToast(`ক্লিন ব্যর্থ: ${err.message}`, "error");
      }
    });
  }

  // Admin Reboot Button
  const rebootBtn = $("#rebootBtn");
  if (rebootBtn) {
    rebootBtn.addEventListener("click", async () => {
      if (!confirm("আপনি কি নিশ্চিত এই MikroTik রাউটারটি রিবুট করতে চান?")) return;
      const routerId = state.selectedRouter || 1;
      try {
        await api(`/api/router/${routerId}/reboot`, { method: "POST" });
        showToast("MikroTik রাউটারে রিবুট সিগন্যাল পাঠানো হয়েছে!", "success");
      } catch (err) {
        showToast(`রিবুট ব্যর্থ: ${err.message}`, "error");
      }
    });
  }
}

// -------------------------------------------------------------
// Page Switcher
// -------------------------------------------------------------
function switchPage(page) {
  state.activePage = page;

  $$(".nav").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });

  const titleEl = $("#pageMainTitle");
  const adminCards = $("#adminDashboardCards");
  const resellerCards = $("#resellerSummaryCards");
  const paymentSummary = $("#dashboardPaymentSummary");
  if (paymentSummary) paymentSummary.style.display = ["dashboard", "paymentHistory", "resellerManagement"].includes(page) ? "grid" : "none";

  const isAdmin = state.userRole === "admin";

  // Control visibility of top overview cards
  if (isAdmin) {
    if (adminCards) adminCards.classList.toggle("hidden", page !== "dashboard");
    if (resellerCards) resellerCards.classList.add("hidden");
  } else {
    if (adminCards) adminCards.classList.add("hidden");
    if (resellerCards) resellerCards.classList.remove("hidden");
  }

  if (page === "dashboard") {
    if (isAdmin) {
      if (titleEl) titleEl.textContent = "Dashboard Overview (MikroTik Full Control)";
      renderAdminDashboardPage();
    } else {
      if (titleEl) titleEl.textContent = "Dashboard";
      renderResellerDashboardPage();
    }
  } else if (page === "interfaces") {
    if (titleEl) titleEl.textContent = "Interfaces";
    renderAdminDashboardPage();
  } else if (page === "resellerManagement") {
    if (titleEl) titleEl.textContent = "Reseller Management";
    renderResellerManagementPage();
  } else if (page === "package") {
    if (titleEl) titleEl.textContent = "";
    renderPackagePage();
  } else if (page === "vouchers") {
    if (titleEl) titleEl.textContent = "Voucher Generator";
    renderVoucherGeneratorPage();
  } else if (page === "routerControl") {
    if (titleEl) titleEl.textContent = "Router Control & Diagnostics";
    renderRouterControlPage();
  } else if (page === "dhcp") {
    if (titleEl) titleEl.textContent = "";
    renderDhcpPage();
  } else if (page === "hotspot") {
    if (titleEl) titleEl.textContent = "";
    renderHotspotPage();
  } else if (page === "activeUsers") {
    if (titleEl) titleEl.textContent = "";
    renderActiveUsersPage();
  } else if (page === "ppp") {
    if (titleEl) titleEl.textContent = "";
    renderPppPage();
  } else if (page === "paymentHistory") {
    if (titleEl) titleEl.textContent = "Payment History";
    renderPaymentHistoryPage();
  }
}

function renderDhcpPage() {
  const panel = $("#detailPanel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="table-head">
      <h2 style="font-size:20px;color:#fff;">DHCP Client List</h2>
      <input type="text" id="dhcpSearch" class="search-input" placeholder="Search DHCP clients...">
      <div style="display:flex;gap:10px;">
        <button class="primary" id="showAddDhcpClient">+ Add DHCP Client</button>
      </div>
    </div>
    <div id="addDhcpClientWrap" class="package-form-wrap hidden">
      <form id="addDhcpClientForm" class="package-form">
        <h3 style="margin:0 0 10px;font-size:14px;color:#eaf2f8;">Add DHCP Client to MikroTik</h3>
        <div class="package-form-grid">
          <label>Interface*<input name="interface" required placeholder="Router interface"></label>
          <label>Use peer DNS<input name="usePeerDns" type="checkbox" checked></label>
          <label>Use peer NTP<input name="usePeerNtp" type="checkbox" checked></label>
          <label>Add default route<input name="addDefaultRoute" type="checkbox" checked></label>
        </div>
        <div class="package-form-actions">
          <button class="primary" type="submit">Add DHCP Client</button>
          <button class="search" id="cancelAddDhcpClient" type="button">Cancel</button>
        </div>
      </form>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Interface</th><th>Status</th><th>Address</th><th>Gateway</th><th>Peer DNS</th><th>Default Route</th></tr></thead>
      <tbody id="dhcpClientsTbody"></tbody>
    </table></div>`;
  $("#dhcpSearch")?.addEventListener("input", loadDhcpClientList);
  $("#showAddDhcpClient")?.addEventListener("click", () => $("#addDhcpClientWrap")?.classList.remove("hidden"));
  $("#cancelAddDhcpClient")?.addEventListener("click", () => $("#addDhcpClientWrap")?.classList.add("hidden"));
  $("#addDhcpClientForm")?.addEventListener("submit", addDhcpClient);
  loadDhcpClientList();
}

function escapeTableValue(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

async function loadDhcpClientList() {
  const tbody = $("#dhcpClientsTbody");
  if (!tbody) return;
  if (!state.selectedRouter) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#8ea4b3;">No router selected.</td></tr>';
    return;
  }
  try {
    const clients = await api(`/api/router/${state.selectedRouter}/dhcp/clients`);
    const query = String($("#dhcpSearch")?.value || "").trim().toLowerCase();
    const visible = clients.filter((client) => [client.interface, client.status, client.address, client.gateway, client["use-peer-dns"]]
      .some((value) => String(value || "").toLowerCase().includes(query)));
    tbody.innerHTML = visible.length ? visible.map((client, index) => `
      <tr><td>${index + 1}</td><td><strong>${escapeTableValue(client.interface || "�")}</strong></td>
      <td><span class="badge-pill ${String(client.status).toLowerCase() === "bound" ? "online" : "due"}">${escapeTableValue(client.status || "Unknown")}</span></td>
      <td><code>${escapeTableValue(client.address || "�")}</code></td><td><code>${escapeTableValue(client.gateway || "�")}</code></td>
      <td>${escapeTableValue(client["use-peer-dns"] || "�")}</td><td>${escapeTableValue(client["add-default-route"] || "�")}</td></tr>`).join("")
      : '<tr><td colspan="7" style="text-align:center;padding:24px;color:#8ea4b3;">No DHCP clients found.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#ff9b9b;">${escapeTableValue(error.message || "Could not load DHCP clients")}</td></tr>`;
  }
}

async function addDhcpClient(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api(`/api/router/${state.selectedRouter}/dhcp/clients`, {
      method: "POST",
      body: JSON.stringify({
        interface: data.get("interface"),
        usePeerDns: data.has("usePeerDns"),
        usePeerNtp: data.has("usePeerNtp"),
        addDefaultRoute: data.has("addDefaultRoute")
      })
    });
    showToast("DHCP client added to MikroTik.");
    form.reset();
    $("#addDhcpClientWrap")?.classList.add("hidden");
    await loadDhcpClientList();
  } catch (error) {
    showToast(error.message, "error");
  }
}
function renderHotspotPage() {
  const panel = $("#detailPanel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="table-head">
      <h2 style="font-size:20px;color:#fff;">Hotspot User List</h2>
      <input type="text" id="hotspotSearch" class="search-input" placeholder="Search Hotspot users...">
      <div style="display:flex;gap:10px;">
        <button class="primary" id="showAddHotspotUser">+ Add Hotspot User</button>
      </div>
    </div>
    <div id="addHotspotUserWrap" class="package-form-wrap hidden">
      <form id="addHotspotUserForm" class="package-form">
        <h3 style="margin:0 0 10px;font-size:14px;color:#eaf2f8;">Add Hotspot User to MikroTik</h3>
        <div class="package-form-grid">
          <label>Username*<input name="name" required></label>
          <label>Password*<input name="password" type="password" required></label>
          <label>Profile<input name="profile"></label>
          <label>Server<input name="server"></label>
          <label>Limit uptime<input name="limitUptime" placeholder="For example: 1d"></label>
          <label>Comment<input name="comment"></label>
        </div>
        <div class="package-form-actions">
          <button class="primary" type="submit">Add Hotspot User</button>
          <button class="search" id="cancelAddHotspotUser" type="button">Cancel</button>
        </div>
      </form>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Username</th><th>Profile</th><th>Server</th><th>Limit uptime</th><th>Comment</th><th>Status</th></tr></thead>
      <tbody id="hotspotUsersTbody"><tr><td colspan="7" style="text-align:center;padding:24px;color:#8ea4b3;">Loading Hotspot users...</td></tr></tbody>
    </table></div>`;
  $("#hotspotSearch")?.addEventListener("input", loadHotspotUsers);
  $("#showAddHotspotUser")?.addEventListener("click", () => $("#addHotspotUserWrap")?.classList.remove("hidden"));
  $("#cancelAddHotspotUser")?.addEventListener("click", () => $("#addHotspotUserWrap")?.classList.add("hidden"));
  $("#addHotspotUserForm")?.addEventListener("submit", addHotspotUser);
  loadHotspotUsers();
}

async function loadHotspotUsers() {
  const tbody = $("#hotspotUsersTbody");
  if (!tbody) return;
  if (!state.selectedRouter) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#8ea4b3;">No router selected.</td></tr>';
    return;
  }
  try {
    const users = await api(`/api/router/${state.selectedRouter}/hotspot/users`);
    const query = String($("#hotspotSearch")?.value || "").trim().toLowerCase();
    const visible = users.filter((user) => [user.name, user.profile, user.server, user.comment, user["limit-uptime"]]
      .some((value) => String(value || "").toLowerCase().includes(query)));
    tbody.innerHTML = visible.length ? visible.map((user, index) => `
      <tr><td>${index + 1}</td><td><strong>${escapeTableValue(user.name || "�")}</strong></td>
      <td>${escapeTableValue(user.profile || "�")}</td><td>${escapeTableValue(user.server || "all")}</td>
      <td>${escapeTableValue(user["limit-uptime"] || "�")}</td><td>${escapeTableValue(user.comment || "�")}</td>
      <td><span class="badge-pill ${user.disabled === true || user.disabled === "true" ? "due" : "online"}">${user.disabled === true || user.disabled === "true" ? "Disabled" : "Enabled"}</span></td></tr>`).join("")
      : '<tr><td colspan="7" style="text-align:center;padding:24px;color:#8ea4b3;">No Hotspot users found.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#ff9b9b;">${escapeTableValue(error.message || "Could not load Hotspot users")}</td></tr>`;
  }
}

async function addHotspotUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api(`/api/router/${state.selectedRouter}/hotspot/users`, {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"), password: data.get("password"), profile: data.get("profile"),
        server: data.get("server"), limitUptime: data.get("limitUptime"), comment: data.get("comment")
      })
    });
    showToast("Hotspot user added to MikroTik.");
    form.reset();
    $("#addHotspotUserWrap")?.classList.add("hidden");
    await loadHotspotUsers();
  } catch (error) {
    showToast(error.message, "error");
  }
}
// App Initialization
// -------------------------------------------------------------
async function initApp() {
  if (!checkAuth()) return;

  // Setup sidebar navigation clicks
  $$(".nav").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const page = btn.dataset.page;
      if (!page) return;
      if (page === "package") await loadPackages();
      if (page === "vouchers") await Promise.all([loadPackages(), loadVouchers()]);
      if (page === "ppp") await loadDeletedCustomers();
      switchPage(page);
    });
  });

  // Account Control Toggles (For Reseller)
  const headerToggle = $("#accountStatusToggle");
  const bannerToggle = $("#bannerStatusToggle");
  if (headerToggle) headerToggle.addEventListener("change", handleResellerSelfToggle);
  if (bannerToggle) bannerToggle.addEventListener("change", handleResellerSelfToggle);

  // Logout button
  const logoutBtn = $("#logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      if (confirm("আপনি কি নিশ্চিত লগ-আউট করতে চান?")) {
        localStorage.removeItem("adminSession");
        localStorage.removeItem("resellerSession");
        localStorage.removeItem("userSession");
        window.location.href = "/login.html";
      }
    });
  }

  // Sidebar toggle for mobile
  const menuBtn = $("#menu");
  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar) sidebar.classList.toggle("collapsed");
    });
  }

  // Setup modals
  setupModals();
  // Router select listener
  const routerSel = $("#routerSelect");
  if (routerSel) {
    routerSel.addEventListener("change", async (e) => {
      state.selectedRouter = e.target.value;
      try {
        await api(`/api/router/${state.selectedRouter}/ppp/secrets`);
      } catch (error) {
        showToast(`Selected router cannot manage PPPoE users: ${error.message}. Finding an available router.`, "error");
        await loadRouters();
      }
      await loadDashboardData();
      await loadPackages();
      if (state.activePage === "vouchers") await loadVouchers();
      switchPage(state.activePage);
    });
  }

  // Refresh button
  const refreshBtn = $("#refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      showStatus("ডাটা রিফ্রেশ করা হচ্ছে...", true);
      await Promise.all([
        loadDashboardData(),
        state.userRole === "admin" ? loadResellers() : Promise.resolve(),
        loadPackages(),
        state.userRole === "admin" && state.activePage === "vouchers" ? loadVouchers() : Promise.resolve(),
        loadCustomers(),
        loadPayments()
      ]);
      showStatus("ডাটা সফলভাবে আপডেট হয়েছে।", true);
      setTimeout(() => showStatus("", false), 2500);
      switchPage(state.activePage);
    });
  }

  // Initial Data Load
  try {
    showStatus("ডাটা লোড হচ্ছে...", true);
    await loadRouters();
    await Promise.all([
      loadDashboardData(),
      state.userRole === "admin" ? loadResellers() : Promise.resolve(),
      loadPackages(),
      loadCustomers(),
      loadPayments()
    ]);
    showStatus("", false);
  } catch (err) {
    console.error("Initialization error:", err);
    showStatus("কিছু তথ্য লোড করতে সমস্যা হয়েছে।", true);
  }

  // Render initial page
  switchPage(state.activePage);
}

document.addEventListener("DOMContentLoaded", initApp);
