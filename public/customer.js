(() => {
  const customer = JSON.parse(localStorage.getItem("customerSession") || "null");
  if (!customer) {
    window.location.replace("/customer-login.html");
    return;
  }

  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const money = (amount) => `BDT ${Number(amount || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  const dateText = (value) => {
    if (!value) return "—";
    const parts = String(value).slice(0, 10).split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return String(value).slice(0, 10);
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const initials = String(customer.fullName || customer.username || "U").trim().slice(0, 1).toUpperCase();
  let trialExpiryTime = customer.trialExpiresAt
    ? new Date(String(customer.trialExpiresAt).replace(" ", "T")).getTime()
    : 0;
  let expiryTime = trialExpiryTime || (customer.expiryDate ? new Date(`${String(customer.expiryDate).slice(0, 10)}T23:59:59`).getTime() : 0);
  const serviceActive = !!customer.isActive && (!expiryTime || expiryTime >= Date.now());
  const set = (selector, value) => { const element = $(selector); if (element) element.textContent = value; };

  set("#welcomeLine", `Hi, ${customer.fullName || customer.username}!  ·  ${serviceActive ? "Status: Active" : "Status: Inactive"}`);
  set("#profileShortcut", initials);
  set("#profileAvatar", initials);
  set("#planName", customer.packageName || "Internet Plan");
  set("#planSpeed", customer.packageSpeed || "Speed not set");
  set("#planStatus", serviceActive ? "Active" : "Inactive");
  set("#serviceStatus", serviceActive ? "Active" : "Inactive");
  $("#serviceStatus")?.classList.toggle("status-offline", !serviceActive);
  $("#serviceStatus")?.classList.toggle("status-live", serviceActive);
  window.setInterval(() => {
    const currentlyActive = !!customer.isActive && (!expiryTime || expiryTime >= Date.now());
    set("#welcomeLine", `Hi, ${customer.fullName || customer.username}!  Â·  ${currentlyActive ? "Status: Active" : "Status: Inactive"}`);
    set("#planStatus", currentlyActive ? "Active" : "Inactive");
    set("#serviceStatus", currentlyActive ? "Active" : "Inactive");
    $("#serviceStatus")?.classList.toggle("status-offline", !currentlyActive);
    $("#serviceStatus")?.classList.toggle("status-live", currentlyActive);
  }, 15000);
  set("#connectionPackage", customer.packageName || "—");
  const updateTrialCountdown = () => {
    if (!trialExpiryTime) {
      set("#connectionExpiry", dateText(customer.expiryDate));
      return;
    }
    const remaining = Math.max(0, Math.ceil((trialExpiryTime - Date.now()) / 1000));
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    set("#connectionExpiry", remaining > 0
      ? `Free trial: ${hours}h ${minutes}m ${seconds}s remaining`
      : "Free trial expired");
  };
  updateTrialCountdown();
  if (trialExpiryTime) window.setInterval(updateTrialCountdown, 1000);
  set("#billDueDate", dateText(customer.expiryDate));
  set("#billAmount", money(customer.dueAmount));
  set("#paymentDueAmount", money(customer.dueAmount));
  set("#techUsername", customer.username || "—");
  set("#techArea", customer.area || "—");
  set("#techMobile", customer.mobile || "—");
  set("#techBalance", `${Number(customer.balanceDays || 0)} days`);
  set("#profileName", customer.fullName || customer.username || "User");
  set("#profileUsername", customer.username || "—");
  set("#profilePackage", customer.packageName || "—");
  set("#profileArea", customer.area || "—");
  set("#profileReseller", customer.resellerName || "Your ISP");
  set("#paymentResellerName", customer.resellerName || "Your ISP");

  const phone = String(customer.resellerMobile || "").replace(/[^+\d]/g, "");
  ["#resellerPaymentLink", "#supportLink"].forEach((selector) => {
    const link = $(selector);
    if (link && phone) link.href = `tel:${phone}`;
    else if (link) { link.href = "#"; link.addEventListener("click", (event) => event.preventDefault()); }
  });
  set("#supportContact", phone ? `Call ${customer.resellerName || "your reseller"} at ${customer.resellerMobile} for account and connection support.` : "Contact your reseller for account and connection support.");
  if (!phone) {
    set("#resellerPaymentLink", "Reseller contact not available");
    set("#supportLink", "Reseller contact not available");
  }

  const history = $("#paymentHistory");
  customer.payments = Array.isArray(customer.payments) ? customer.payments : [];
  const renderPaymentHistory = () => {
    const payments = customer.payments;
    if (!history) return;
    history.innerHTML = payments.length ? payments.map((payment) => `
      <div class="history-entry"><strong>${escapeHtml(payment.payment_method || payment.payment_channel || "Payment")}</strong>
      <span>${escapeHtml(dateText(payment.payment_date))} · ${escapeHtml(payment.status || "Recorded")}</span>
      <b>${escapeHtml(money(payment.paid_amount || payment.amount))}</b></div>`).join("") : '<div class="empty-state">No payment history yet.</div>';
  };
  renderPaymentHistory();

  function showView(name) {
    document.querySelectorAll(".portal-view").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.target === name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.target)));
  $("#profileShortcut")?.addEventListener("click", () => showView("profile"));
  $("#payBillButton")?.addEventListener("click", (event) => { event.preventDefault(); showView("payment"); });
  const voucherForm = $("#customerVoucherForm");
  const voucherInput = $("#customerVoucherCode");
  const voucherSubmit = voucherForm?.querySelector('button[type="submit"]');
  if (voucherForm) {
    voucherForm.dataset.requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    voucherForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!voucherSubmit || voucherSubmit.disabled) return;
      voucherSubmit.disabled = true;
      set("#cardRechargeMessage", "Applying card...");
      try {
        const response = await fetch(`/api/reseller/customer/${customer.id}/redeem-voucher`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${customer.sessionToken || ""}`
          },
          body: JSON.stringify({ requestId: voucherForm.dataset.requestId, voucherCode: voucherInput.value.trim() })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Recharge failed (${response.status})`);

        customer.packageName = result.packageName;
        customer.expiryDate = result.expiry_date;
        customer.balanceDays = Number(result.balance_days || 0);
        customer.trialExpiresAt = null;
        customer.isActive = true;
        trialExpiryTime = 0;
        expiryTime = new Date(`${String(result.expiry_date).slice(0, 10)}T23:59:59`).getTime();
        customer.payments.unshift({
          payment_method: "Card Recharge", payment_channel: "card", status: "paid",
          payment_date: new Date().toISOString(), amount: result.paymentAmount, paid_amount: result.paymentAmount
        });
        localStorage.setItem("customerSession", JSON.stringify(customer));
        set("#connectionPackage", customer.packageName);
        set("#planName", customer.packageName);
        set("#billDueDate", dateText(customer.expiryDate));
        set("#connectionExpiry", dateText(customer.expiryDate));
        set("#techBalance", `${customer.balanceDays} days`);
        set("#planStatus", "Active");
        set("#serviceStatus", "Active");
        $("#serviceStatus")?.classList.add("status-live");
        $("#serviceStatus")?.classList.remove("status-offline");
        updateTrialCountdown();
        set("#cardRechargeMessage", `Card applied: ${result.packageName}, ${result.appliedDays} days. Valid until ${dateText(result.expiry_date)}.`);
        voucherForm.reset();
        voucherForm.dataset.requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        renderPaymentHistory();
      } catch (error) {
        set("#cardRechargeMessage", error.message);
      } finally {
        voucherSubmit.disabled = false;
      }
    });
  }
  $("#userLogout")?.addEventListener("click", () => {
    localStorage.removeItem("customerSession");
    window.location.replace("/customer-login.html");
  });
})();
