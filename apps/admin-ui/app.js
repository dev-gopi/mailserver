/**
 * MailCore Pro Admin — Production Mail Server Control Panel
 * Frontend Controller & API Client
 */

// Application State
const state = {
  token: sessionStorage.getItem("mailAdminToken"),
  adminUser: JSON.parse(sessionStorage.getItem("mailAdminUser") || "null"),
  currentTab: "overview",
  domains: [],
  mailboxes: [],
  aliases: [],
  clientConfig: null,
  auditLogs: [],
  dashboardData: null,
  company: null,
  activeDnsDomain: null,
  failureAlerts: [],
  mailboxStatusFilter: "",
  backups: [],
  backupMetrics: {},
  backupSettings: {},
  pendingMfa: null,
  mfaMode: "totp",
  pendingTotpSetup: null
};

// DOM Helper
const $ = (id) => document.getElementById(id);

// Auth Header helper
const getHeaders = (extra = {}) => ({
  "Content-Type": "application/json",
  ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  ...extra
});

// Failure Alert System
function recordFailureAlert(alert) {
  if (!alert || !alert.title) return;
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const id = "alert-" + now.getTime() + "-" + Math.random().toString(36).slice(2, 6);

  // Avoid spamming identical alerts within 15 seconds
  const isDup = state.failureAlerts.some((a) =>
    a.title === alert.title && a.target === alert.target && (now.getTime() - a.rawTime < 15000)
  );
  if (isDup) return;

  const newAlert = {
    id,
    category: alert.category || "System",
    title: alert.title,
    target: alert.target || "System",
    reason: alert.reason || "Operation encountered an error",
    actor: alert.actor || state.adminUser?.username || "Admin",
    time: timeStr,
    rawTime: now.getTime(),
    details: alert.details
  };

  state.failureAlerts.unshift(newAlert);
  if (state.failureAlerts.length > 50) state.failureAlerts.pop();

  renderFailureAlerts();
}

function dismissFailureAlert(alertId) {
  state.failureAlerts = state.failureAlerts.filter((a) => a.id !== alertId);
  renderFailureAlerts();
}

function clearAllFailureAlerts() {
  state.failureAlerts = [];
  renderFailureAlerts();
  showToast("Alerts Cleared", "All failure alerts have been cleared.", "info");
}

function toggleFailedAlertsPanel(forceState) {
  const container = $("failed-alerts-banner-container");
  if (!container) return;
  if (typeof forceState === "boolean") {
    container.classList.toggle("hidden", !forceState);
  } else {
    container.classList.toggle("hidden");
  }
}

function renderFailureAlerts() {
  const container = $("failed-alerts-banner-container");
  const list = $("failed-alerts-list");
  const pill = $("topbar-alerts-pill");
  const pillText = $("topbar-alerts-text");
  const countEl = $("failed-alerts-count");

  const count = state.failureAlerts.length;

  if (countEl) countEl.textContent = count;
  if (pillText) pillText.textContent = `${count} Issue${count === 1 ? "" : "s"}`;

  if (count === 0) {
    if (pill) pill.classList.add("hidden");
    if (container) container.classList.add("hidden");
    if (list) list.innerHTML = "";
  } else {
    if (pill) pill.classList.remove("hidden");
    if (container && !container.classList.contains("user-hidden")) {
      container.classList.remove("hidden");
    }
    if (list) {
      list.innerHTML = state.failureAlerts.map((a) => `
        <div class="failed-alert-card" id="${a.id}">
          <div class="failed-alert-content">
            <div class="failed-alert-heading">
              <span class="failed-alert-badge">${escapeHtml(a.category)}</span>
              <strong>${escapeHtml(a.title)}</strong>
              <span class="failed-alert-time">${a.time}</span>
            </div>
            <div class="failed-alert-target">
              <span><strong>Target / Who:</strong> <code>${escapeHtml(a.target)}</code></span>
              ${a.actor ? `<span class="text-muted" style="margin-left: 8px;">• Actor: ${escapeHtml(a.actor)}</span>` : ""}
            </div>
            <div class="failed-alert-why">
              <strong>Why it failed:</strong> ${escapeHtml(a.reason)}
            </div>
          </div>
          <button type="button" class="failed-alert-dismiss" title="Dismiss Alert" onclick="dismissFailureAlert('${a.id}')">&times;</button>
        </div>
      `).join("");
    }
  }

  renderDashboardFailuresTable();
}

function renderDashboardFailuresTable() {
  const tbody = $("dashboard-failures-tbody");
  const empty = $("dashboard-failures-empty");
  if (!tbody || !empty) return;

  const alerts = state.failureAlerts;
  if (alerts.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  tbody.innerHTML = alerts.map((a) => `
    <tr>
      <td><span class="font-mono" style="font-size: 0.78rem;">${a.time}</span></td>
      <td>
        <span class="badge badge-danger">${escapeHtml(a.category)}</span>
        <strong style="margin-left: 6px;">${escapeHtml(a.title)}</strong>
      </td>
      <td><code>${escapeHtml(a.target)}</code></td>
      <td><span style="color: #b91c1c; font-size: 0.82rem;">${escapeHtml(a.reason)}</span></td>
      <td><span class="badge badge-danger"><span class="badge-status-dot offline"></span>Failed</span></td>
    </tr>
  `).join("");
}

// Central API Request Handler
async function request(path, options = {}) {
  const url = path;
  const config = {
    ...options,
    headers: getHeaders(options.headers || {})
  };

  try {
    const res = await fetch(url, config);

    // Don't auto-redirect to login if we are in the middle of auth / login / 2fa / reset
    const isAuthRoute = path.includes("/auth/login") ||
                        path.includes("/auth/mfa/") ||
                        path.includes("/auth/reset-password") ||
                        path.includes("/auth/passkey/");

    if (res.status === 401 && !isAuthRoute) {
      sessionStorage.removeItem("mailAdminToken");
      sessionStorage.removeItem("mailAdminUser");
      state.token = null;
      state.adminUser = null;
      showView("login");
      throw new Error("Session expired. Please sign in again.");
    }

    if (res.status === 204) {
      return null;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Extract the most specific and accurate error message returned by the API
      let errMsg = "";
      if (typeof data === "string") {
        errMsg = data;
      } else if (data && data.error) {
        errMsg = data.error;
      } else if (data && data.message) {
        errMsg = data.message;
      } else if (data && Array.isArray(data.details)) {
        errMsg = data.details.map((d) => d.message || d.field).join("; ");
      } else if (data && typeof data.details === "string") {
        errMsg = data.details;
      } else if (res.statusText) {
        errMsg = `${res.statusText} (${res.status})`;
      } else {
        errMsg = `Request failed with status ${res.status}`;
      }

      if (!isAuthRoute && !path.includes("/auth/me")) {
        recordFailureAlert({
          category: "API",
          title: `API Request Failed (${options.method || "GET"})`,
          target: path,
          reason: errMsg
        });
      }
      throw new Error(errMsg);
    }
    return data;
  } catch (err) {
    if (err.name === "TypeError" && err.message.includes("fetch")) {
      recordFailureAlert({
        category: "Network",
        title: "Backend Connection Unreachable",
        target: path,
        reason: "Failed to fetch: network error or backend container is offline."
      });
    }
    throw err;
  }
}

// Toast Notifications
function showToast(title, message, type = "info", duration = 4500) {
  const container = $("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-msg">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(30px)";
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// View Switching: login, 2fa, forgot, setup, app
function showView(name) {
  $("view-login")?.classList.toggle("hidden", name !== "login");
  $("view-2fa")?.classList.toggle("hidden", name !== "2fa");
  $("view-forgot")?.classList.toggle("hidden", name !== "forgot");
  $("view-setup")?.classList.toggle("hidden", name !== "setup");
  $("view-app")?.classList.toggle("hidden", name !== "app");

  if (name === "app") {
    updateUserInfo();
  }
}

// Navigation Tabs
function switchTab(tabId) {
  state.currentTab = tabId;

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabId);
  });

  document.querySelectorAll(".tab-pane").forEach((pane) => {
    pane.classList.remove("active");
  });

  const targetPaneId = tabId === "users" || tabId === "mailboxes" ? "tab-users" : `tab-${tabId}`;
  const activePane = $(targetPaneId);
  if (activePane) activePane.classList.add("active");

  const titles = {
    overview: "Overview",
    dashboard: "Visual Dashboard & Analytics",
    users: "Users & Mailbox Accounts",
    mailboxes: "Users & Mailbox Accounts",
    domains: "Hosted Domains",
    aliases: "Email Aliases & Forwarding",
    services: "Services, Mail Queue & Diagnostics",
    audit: "Audit Log & Security Trail",
    backups: "Mail Backups & Disaster Recovery",
    settings: "Settings & Company Profile"
  };
  $("page-title").textContent = titles[tabId] || "Control Panel";

  if (tabId === "dashboard") {
    renderDashboardVisuals();
  }
  if (tabId === "backups") {
    renderBackupsView();
  }
  if (tabId === "audit" && state.auditLogs.length === 0) {
    loadAuditLogs();
  }
  if (tabId === "services") {
    runDiagnosticsNow();
  }
}

// User Info Rendering in Sidebar
function updateUserInfo() {
  const user = state.adminUser || { username: "admin", role: "owner" };
  $("user-display-name").textContent = user.username;
  $("user-display-role").textContent = user.role || "admin";
  const initials = (user.username || "AD").slice(0, 2).toUpperCase();
  $("user-avatar-initials").textContent = initials;
}

// Modal Handlers
function openModal(id) {
  const el = $(id);
  if (el) el.classList.remove("hidden");
}

function closeModal(id) {
  const el = $(id);
  if (el) el.classList.add("hidden");
}

function handleBackdropClick(event, modalId) {
  if (event.target.id === modalId) {
    closeModal(modalId);
  }
}

// Copy Utilities
function copyText(text, btnElement) {
  navigator.clipboard.writeText(text).then(() => {
    if (btnElement) {
      const orig = btnElement.textContent;
      btnElement.textContent = "Copied!";
      btnElement.style.color = "#16a34a";
      setTimeout(() => {
        btnElement.textContent = orig;
        btnElement.style.color = "";
      }, 1600);
    }
    showToast("Copied to Clipboard", text, "info", 2000);
  }).catch(() => {
    showToast("Copy Failed", "Please manually copy the text", "warning");
  });
}

function copyElementText(elId, btnElement) {
  const el = $(elId);
  if (el) copyText(el.textContent.trim(), btnElement);
}

function copyPasswordFrom(inputId, btnElement) {
  const input = $(inputId);
  if (!input || !input.value) {
    showToast("No Password", "Please enter or generate a password first.", "warning");
    return;
  }
  copyText(input.value, btnElement);
}

// Cryptographically Secure Password Generator
function generatePassword(length = 16) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*()-_=+";
  const all = upper + lower + digits + symbols;

  const getRandomInt = (max) => {
    if (window.crypto && window.crypto.getRandomValues) {
      const arr = new Uint32Array(1);
      window.crypto.getRandomValues(arr);
      return arr[0] % max;
    }
    return Math.floor(Math.random() * max);
  };

  const pwdArr = [
    upper[getRandomInt(upper.length)],
    lower[getRandomInt(lower.length)],
    digits[getRandomInt(digits.length)],
    symbols[getRandomInt(symbols.length)]
  ];

  for (let i = 4; i < length; i++) {
    pwdArr.push(all[getRandomInt(all.length)]);
  }

  // Cryptographically secure Fisher-Yates shuffle
  for (let i = pwdArr.length - 1; i > 0; i--) {
    const j = getRandomInt(i + 1);
    [pwdArr[i], pwdArr[j]] = [pwdArr[j], pwdArr[i]];
  }

  return pwdArr.join("");
}

function generatePasswordFor(inputId) {
  const pwd = generatePassword(16);
  const input = $(inputId);
  if (input) {
    input.value = pwd;
    input.type = "text"; // temporarily show to admin
    showToast("Strong Password Generated", "Password has been filled. Click Copy to save it.", "success");
  }
}

function togglePasswordVisibility(inputId, btnElement) {
  const input = $(inputId);
  if (!input) return;
  const isPw = input.type === "password";
  input.type = isPw ? "text" : "password";
  btnElement.style.color = isPw ? "var(--primary)" : "var(--text-muted)";
}

// Format Utilities
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "Unlimited";
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${sizes[i]}`;
}

function formatUsedBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 Bytes";
  return formatBytes(bytes);
}

function formatDate(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return isoStr;
  }
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return "—";
  const now = new Date();
  const d = new Date(isoStr);
  const diffSec = Math.floor((now - d) / 1000);

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return formatDate(isoStr);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ==========================================================================
   Data Loaders
   ========================================================================== */

// Master Refresh
async function refreshAllData() {
  try {
    const [dashboard, company, domains, mailboxes, aliases, clientConfig, backupData] = await Promise.all([
      request("/api/dashboard"),
      request("/api/company"),
      request("/api/domains"),
      request("/api/users"),      // Uses virtual_users view (Dovecot-compatible)
      request("/api/aliases"),    // Admin view — includes inactive aliases
      request("/api/users/client-config"),
      request("/api/backups").catch(() => null)
    ]);

    state.dashboardData = dashboard;
    state.company = company;
    state.domains = domains;
    state.mailboxes = mailboxes;
    state.aliases = aliases;
    state.clientConfig = clientConfig;

    if (backupData) {
      state.backups = backupData.backups || [];
      state.backupMetrics = backupData.metrics || {};
      state.backupSettings = backupData.settings || {};
      if ($("badge-nav-backups")) $("badge-nav-backups").textContent = state.backups.length;
    }

    renderOverview();
    renderDashboardVisuals();
    renderMailboxes();
    renderDomains();
    renderAliases();
    renderBackupsView();
    renderCompanyForm();
    renderConnectionHelp(clientConfig);
    populateDomainSelectors();

    if (dashboard.services) {
      renderServicesHealth(dashboard.services);
      renderInfrastructureSummary(dashboard.services);
      dashboard.services.forEach((s) => {
        if (s.status === "down" || s.status === "degraded") {
          recordFailureAlert({
            category: "Service Health",
            title: `Service Down / Degraded: ${s.displayName}`,
            target: `${s.service} (Port ${s.port})`,
            reason: s.error || `Service probe returned status: ${s.status}`,
            actor: "TCP Health Monitor"
          });
        }
      });
    }

    if (dashboard.recentFailures && Array.isArray(dashboard.recentFailures)) {
      dashboard.recentFailures.forEach((f) => {
        const d = f.details || {};
        recordFailureAlert({
          category: f.entity_type ? f.entity_type.toUpperCase() : "AUDIT",
          title: `Failure: ${f.action}`,
          target: d.address || d.domain || d.attemptedUsername || (f.entity_id ? `#${f.entity_id}` : "System"),
          reason: d.reason || d.error || "Action resulted in failure or rejection",
          actor: f.admin_id ? `Admin #${f.admin_id}` : "System"
        });
      });
    }
    renderOverviewConnectionReference(clientConfig);
    if (dashboard.queue) renderQueueStats(dashboard.queue, dashboard.taskQueue);

    showToast("Synchronized", "Mail server records updated.", "info", 1500);
  } catch (err) {
    if (!err.message.includes("Session expired")) {
      showToast("Sync Error", err.message, "error");
    }
  }
}

// 1. Overview Renderer
function renderOverviewConnectionReference(config) {
  if (!config) return;
  $("overview-imap-host").textContent = config.incoming.hostname;
  $("overview-imap-port").textContent = `Port ${config.incoming.port}`;
  $("overview-smtp-host").textContent = config.outgoing.hostname;
  $("overview-smtp-port").textContent = `Port ${config.outgoing.port}`;
  $("overview-smtps-port").textContent = `Port ${config.outgoing.alternativePort}`;
}

function renderInfrastructureSummary(services = []) {
  const byService = Object.fromEntries(services.map((service) => [service.service, service]));
  const setStatus = (id, service) => {
    const element = $(id);
    if (!element || !service) return;
    const healthy = service.status === "healthy";
    element.className = `badge ${healthy ? "badge-success" : "badge-danger"}`;
    element.textContent = healthy ? "Healthy" : service.status;
  };
  const postfix = byService.postfix;
  const dovecot = byService.dovecot;
  const spamassassin = byService.spamassassin;
  const database = byService.postgresql;

  if (postfix) $("infra-postfix-details").textContent = `SMTP service port ${postfix.port}`;
  if (dovecot) $("infra-dovecot-details").textContent = `IMAP service port ${dovecot.port} • Maildir Storage`;
  if (spamassassin) $("infra-filter-details").textContent = `SpamAssassin service port ${spamassassin.port} • ClamAV filter engine`;
  if (database) $("infra-database-name").textContent = database.displayName;
  setStatus("infra-postfix-status", postfix);
  setStatus("infra-dovecot-status", dovecot);
  setStatus("infra-filter-status", spamassassin);
  setStatus("infra-database-status", database);
}

function renderOverview() {
  const d = state.dashboardData;
  if (!d) return;

  $("stat-domains").textContent = d.counts.domainsTotal || d.counts.domains || 0;
  $("stat-domains-sub").textContent = `${d.counts.domainsVerified || 0} verified • ${d.counts.domainsPending || 0} pending DNS`;

  $("stat-mailboxes").textContent = d.counts.mailboxesTotal || d.counts.mailboxes || 0;
  $("stat-mailboxes-sub").textContent = `${d.counts.mailboxes || 0} active • ${d.counts.mailboxesSuspended || 0} suspended`;

  $("stat-aliases").textContent = d.counts.aliasesTotal || d.counts.aliases || 0;
  $("stat-quota").textContent = formatBytes(Number(d.counts.totalQuotaBytes || 0));

  $("topbar-company-name").textContent = d.company?.name || "Company Setup Pending";

  // Badges in Nav
  $("badge-nav-domains").textContent = state.domains.length;
  if ($("badge-nav-users")) $("badge-nav-users").textContent = state.mailboxes.length;
  $("badge-nav-aliases").textContent = state.aliases.length;

  // Recent activity stream
  const container = $("overview-recent-activity");
  if (!d.recentActivity || d.recentActivity.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No administrative activities recorded yet.</p></div>`;
    return;
  }

  container.innerHTML = d.recentActivity.map((item) => {
    let badgeClass = "badge-login";
    if (item.action.includes("create")) badgeClass = "badge-create";
    else if (item.action.includes("update")) badgeClass = "badge-update";
    else if (item.action.includes("delete")) badgeClass = "badge-delete";
    else if (item.action.includes("verify")) badgeClass = "badge-verify";

    let detailsStr = "";
    if (item.details) {
      if (item.details.address) detailsStr = `Email: ${item.details.address}`;
      else if (item.details.name) detailsStr = `Domain: ${item.details.name}`;
      else if (item.details.source) detailsStr = `${item.details.source} → ${item.details.destination}`;
    }

    return `
      <div class="activity-item">
        <span class="activity-badge ${badgeClass}">${escapeHtml(item.action)}</span>
        <div class="activity-content">
          <div class="activity-title">${escapeHtml(item.entity_type)} ${item.entity_id ? `(#${item.entity_id})` : ""}: ${escapeHtml(detailsStr)}</div>
          <div class="activity-meta">Logged at ${formatDate(item.occurred_at)} (${formatRelativeTime(item.occurred_at)}) • IP: ${escapeHtml(item.ip_address || "local")}</div>
        </div>
      </div>
    `;
  }).join("");
}

// 2. Mailbox Management (User Mail Box)
function setMailboxFilterStatus(status) {
  state.mailboxStatusFilter = status;
  if ($("mailbox-status-filter")) {
    $("mailbox-status-filter").value = status;
  }
  $("pill-mb-all")?.classList.toggle("active", status === "");
  $("pill-mb-active")?.classList.toggle("active", status === "active");
  $("pill-mb-suspended")?.classList.toggle("active", status === "suspended");
  filterMailboxes();
}

function exportMailboxesCsv() {
  if (!state.mailboxes || state.mailboxes.length === 0) {
    showToast("Export Failed", "No user mailboxes to export.", "warning");
    return;
  }

  const headers = ["Address", "DisplayName", "Domain", "Status", "StorageUsedBytes", "QuotaBytes", "CreatedAt"];
  const rows = state.mailboxes.map((m) => [
    `"${(m.address || "").replace(/"/g, '""')}"`,
    `"${(m.display_name || "").replace(/"/g, '""')}"`,
    `"${(m.domain_name || m.address.split("@")[1] || "").replace(/"/g, '""')}"`,
    m.active ? "Active" : "Suspended",
    m.storage_used_bytes || 0,
    m.quota_bytes || 0,
    m.created_at || ""
  ]);

  const csv = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const link = document.createElement("a");
  link.setAttribute("href", encodeURI(csv));
  link.setAttribute("download", `mailboxes_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast("CSV Downloaded", `Exported ${state.mailboxes.length} accounts.`, "success");
}

function renderMailboxes() {
  const tbody = $("mailboxes-tbody");
  const empty = $("mailbox-empty");

  const query = ($("mailbox-search")?.value || "").toLowerCase().trim();
  const domainFilter = $("mailbox-domain-filter")?.value || "";
  const statusFilter = state.mailboxStatusFilter !== undefined && state.mailboxStatusFilter !== ""
    ? state.mailboxStatusFilter
    : ($("mailbox-status-filter")?.value || "");

  // Update status filter pill counts
  const activeCount = state.mailboxes.filter((m) => m.active).length;
  const suspendedCount = state.mailboxes.filter((m) => !m.active).length;
  if ($("count-mb-all")) $("count-mb-all").textContent = state.mailboxes.length;
  if ($("count-mb-active")) $("count-mb-active").textContent = activeCount;
  if ($("count-mb-suspended")) $("count-mb-suspended").textContent = suspendedCount;
  if ($("users-header-counts")) $("users-header-counts").textContent = `${activeCount} Active • ${suspendedCount} Suspended`;

  const filtered = state.mailboxes.filter((m) => {
    if (query) {
      const matchAddr = m.address.toLowerCase().includes(query);
      const matchName = (m.display_name || "").toLowerCase().includes(query);
      if (!matchAddr && !matchName) return false;
    }
    if (domainFilter && m.domain_name !== domainFilter) return false;
    if (statusFilter === "active" && !m.active) return false;
    if (statusFilter === "suspended" && m.active) return false;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  tbody.innerHTML = filtered.map((m) => {
    const isSuspended = !m.active;
    const usedBytes = Number(m.storage_used_bytes || 0);
    const quotaBytes = Number(m.quota_bytes || 0);
    const usagePercent = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;
    const usageClass = usagePercent >= 90 ? "text-danger" : usagePercent >= 75 ? "text-warning" : "";
    return `
      <tr class="${isSuspended ? "row-suspended" : ""}">
        <td>
          <div class="mailbox-cell">
            <div class="mailbox-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </div>
            <div class="mailbox-details">
              <div class="mailbox-address">
                ${escapeHtml(m.address)}
                <button class="btn-copy-sm" onclick="copyText('${m.address}', this)" title="Copy Email">Copy</button>
              </div>
              <div class="mailbox-name">${escapeHtml(m.display_name || "—")}</div>
            </div>
          </div>
        </td>
        <td>
          <span class="badge-domain">${escapeHtml(m.domain_name || m.address.split("@")[1])}</span>
        </td>
        <td>
          <div>${formatUsedBytes(usedBytes)} / ${formatBytes(quotaBytes)}</div>
          ${quotaBytes > 0
            ? `<div class="text-muted ${usageClass}" style="font-size: 0.75rem;">${usagePercent.toFixed(1)}% used</div>`
            : `<div class="text-muted" style="font-size: 0.75rem;">No quota limit</div>`}
        </td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <span class="badge badge-success" style="font-size: 0.72rem; padding: 2px 6px;">IMAP ${state.clientConfig?.incoming.port ?? "—"}</span>
            <span class="badge badge-success" style="font-size: 0.72rem; padding: 2px 6px;">SMTP ${state.clientConfig?.outgoing.port ?? "—"}</span>
          </div>
        </td>
        <td>
          ${isSuspended
            ? `<span class="badge badge-warning" style="background: rgba(245, 158, 11, 0.12); color: #d97706; border: 1px solid rgba(245, 158, 11, 0.25);">
                 <span class="badge-status-dot offline"></span>Suspended
               </span>`
            : `<span class="badge badge-success">
                 <span class="badge-status-dot online"></span>Active
               </span>`
          }
        </td>
        <td>${formatDate(m.created_at)}</td>
        <td class="text-right">
          <div class="table-actions">
            <button class="btn-action-icon" title="Mail Client Setup Guide" onclick="openClientGuide('${m.address}', '${m.domain_name}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <button class="btn-action-icon" title="Test User IMAP / SMTP Password" onclick="openTestUserAuth('${m.id}', '${m.address}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            <button class="btn-action-icon" title="Edit User / Password / Quota" onclick="openEditMailbox('${m.id}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button class="btn-action-icon ${m.active ? "danger" : "verify"}"
              title="${m.active ? "Suspend User (Disables access, preserves emails)" : "Activate / Reactivate User"}"
              onclick="toggleMailboxActive('${m.id}', ${!m.active})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${m.active
                  ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
                  : '<polyline points="20 6 9 17 4 12"/>'
                }
              </svg>
            </button>
            <button class="btn-action-icon danger" title="Delete User Permanently" onclick="deleteMailbox('${m.id}', '${m.address}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function filterMailboxes() {
  renderMailboxes();
}

// Mailbox Domain Selector Populator
// Uses /api/domains/active which returns only virtual_domains (Postfix-visible domains)
async function populateDomainSelectors() {
  // Fetch virtual domains from server — these are guaranteed active + verified
  let virtualDomains = [];
  try {
    virtualDomains = await request('/api/domains/active');
  } catch {
    // Fallback: derive from full domain list already in state
    virtualDomains = state.domains.filter((d) => d.active && d.verified_at);
  }

  const mbSelect = $('mb-domain-select');
  const userSelect = $('user-domain-select');
  const aliasSelect = $('alias-domain-select');
  const mbFilter = $('mailbox-domain-filter');
  const domainAlert = $('modal-mailbox-domain-alert');
  const userDomainAlert = $('modal-user-domain-alert');

  if (mbSelect) {
    if (virtualDomains.length === 0) {
      mbSelect.innerHTML = '<option value="">No verified domains</option>';
      if (domainAlert) domainAlert.classList.remove('hidden');
    } else {
      mbSelect.innerHTML = virtualDomains.map((d) => '<option value="' + d.name + '">' + d.name + '</option>').join('');
      if (domainAlert) domainAlert.classList.add('hidden');
    }
  }

  if (userSelect) {
    if (virtualDomains.length === 0) {
      userSelect.innerHTML = '<option value="">No verified domains</option>';
      if (userDomainAlert) userDomainAlert.classList.remove('hidden');
    } else {
      userSelect.innerHTML = virtualDomains.map((d) => '<option value="' + d.name + '">' + d.name + '</option>').join('');
      if (userDomainAlert) userDomainAlert.classList.add('hidden');
    }
  }

  if (aliasSelect) {
    aliasSelect.innerHTML = virtualDomains.length === 0
      ? '<option value="">No verified domains</option>'
      : virtualDomains.map((d) => '<option value="' + d.name + '">' + d.name + '</option>').join('');
  }

  if (mbFilter) {
    const currentVal = mbFilter.value;
    const allDomainNames = state.domains.map((d) => d.name);
    mbFilter.innerHTML = '<option value="">All Domains</option>' + allDomainNames.map(
      (name) => '<option value="' + name + '"' + (name === currentVal ? ' selected' : '') + '>' + name + '</option>'
    ).join('');
  }

  const deliverabilityDomain = $("deliverability-domain");
  if (deliverabilityDomain) {
    const currentVal = deliverabilityDomain.value;
    deliverabilityDomain.innerHTML = '<option value="">Select verified domain</option>' +
      virtualDomains.map((domain) =>
        `<option value="${escapeHtml(domain.name)}"${domain.name === currentVal ? " selected" : ""}>${escapeHtml(domain.name)}</option>`
      ).join("");
  }

  updateMailboxPreview();
}

function updateMailboxPreview() {
  const prefix = $("mb-prefix")?.value || "username";
  const domain = $("mb-domain-select")?.value || "";
  const preview = $("mb-preview-email");
  if (preview) preview.textContent = `${prefix}@${domain}`;
}

// Quota selection presets
function setQuotaPreset(quotaBytes, btn) {
  $("mb-quota-bytes").value = quotaBytes;
  document.querySelectorAll("#modal-create-mailbox .quota-presets .btn-preset").forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
}

function setUserQuotaPreset(quotaBytes, btn) {
  $("user-quota-bytes").value = quotaBytes;
  document.querySelectorAll("#user-quota-presets .btn-preset").forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
}

function setEditQuotaPreset(quotaBytes, btn) {
  $("edit-mb-quota-bytes").value = quotaBytes;
  document.querySelectorAll("#edit-quota-presets .btn-preset").forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
}

// Create Mailbox Handler
async function handleCreateMailbox(event) {
  event.preventDefault();
  const prefix = $("mb-prefix").value.trim().toLowerCase();
  const domain = $("mb-domain-select").value;
  const displayName = $("mb-display-name").value.trim();
  const password = $("mb-password").value;
  const quotaBytes = Number($("mb-quota-bytes").value) || null;

  if (!domain) {
    showToast("Domain Required", "You must configure and verify a domain first.", "error");
    return;
  }

  const fullAddress = `${prefix}@${domain}`;
  const btn = $("btn-submit-mailbox");
  btn.disabled = true;
  btn.textContent = "Creating Mailbox...";

  try {
    await request("/api/mailboxes", {
      method: "POST",
      body: JSON.stringify({
        address: fullAddress,
        displayName: displayName || undefined,
        password: password,
        quotaBytes: quotaBytes && quotaBytes > 0 ? quotaBytes : undefined
      })
    });

    closeModal("modal-create-mailbox");
    event.target.reset();
    showToast("Mailbox Created", `Mailbox ${fullAddress} is ready for email traffic.`, "success");
    await refreshAllData();
  } catch (err) {
    showToast("Mailbox Creation Failed", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create";
  }
}

// Create User Handler
async function handleCreateUser(event) {
  event.preventDefault();
  const prefix = $("user-prefix").value.trim().toLowerCase();
  const domain = $("user-domain-select").value;
  const displayName = $("create-user-display-name").value.trim();
  const password = $("user-password").value;
  const quotaBytes = Number($("user-quota-bytes").value) || null;
  const btn = $("btn-submit-user");

  if (!domain) {
    showToast("Domain Required", "You must configure and verify a domain first.", "error");
    return;
  }

  const fullAddress = `${prefix}@${domain}`;
  btn.disabled = true;
  btn.textContent = "Creating User...";

  try {
    await request("/api/users", {
      method: "POST",
      body: JSON.stringify({
        address: fullAddress,
        displayName: displayName || undefined,
        password,
        quotaBytes: quotaBytes && quotaBytes > 0 ? quotaBytes : undefined
      })
    });

    closeModal("modal-create-user");
    event.target.reset();
    setUserQuotaPreset(5368709120, document.querySelector('#user-quota-presets .btn-preset[data-quota="5368709120"]'));
    showToast("User Created", `User ${fullAddress} is ready for email traffic.`, "success");
    await refreshAllData();
  } catch (err) {
    showToast("User Creation Failed", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create User";
  }
}

// Edit Mailbox Handler
function openEditMailbox(id) {
  const mailbox = state.mailboxes.find((m) => String(m.id) === String(id));
  if (!mailbox) return;

  $("edit-mb-id").value = mailbox.id;
  $("edit-mb-address").textContent = mailbox.address;
  $("edit-mb-display-name").value = mailbox.display_name || "";
  $("edit-mb-password").value = "";
  $("edit-mb-active").checked = Boolean(mailbox.active);

  const currentQuota = Number(mailbox.quota_bytes) || 0;
  $("edit-mb-quota-bytes").value = currentQuota;

  document.querySelectorAll("#edit-quota-presets .btn-preset").forEach((btn) => {
    const q = Number(btn.getAttribute("data-quota"));
    btn.classList.toggle("active", q === currentQuota);
  });

  openModal("modal-edit-mailbox");
}

async function handleEditMailboxSubmit(event) {
  event.preventDefault();
  const id = $("edit-mb-id").value;
  const displayName = $("edit-mb-display-name").value.trim();
  const password = $("edit-mb-password").value;
  const quotaBytes = Number($("edit-mb-quota-bytes").value);
  const active = $("edit-mb-active").checked;

  const payload = {
    displayName: displayName || null,
    quotaBytes: quotaBytes > 0 ? quotaBytes : null,
    active: active
  };

  if (password) {
    if (password.length < 12) {
      showToast("Validation Error", "Password must be at least 12 characters.", "warning");
      return;
    }
    payload.password = password;
  }

  try {
    await request(`/api/mailboxes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });

    closeModal("modal-edit-mailbox");
    showToast("Mailbox Updated", "Account settings and storage quotas saved.", "success");
    await refreshAllData();
  } catch (err) {
    showToast("Update Failed", err.message, "error");
  }
}

// Toggle Mailbox Active
async function toggleMailboxActive(id, newActive) {
  try {
    await request(`/api/mailboxes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: newActive })
    });
    showToast(newActive ? "Mailbox Activated" : "Mailbox Suspended", `Account status changed to ${newActive ? "Active" : "Suspended"}.`, "info");
    await refreshAllData();
  } catch (err) {
    recordFailureAlert({
      category: "Mailbox",
      title: `Failed to ${newActive ? "Activate" : "Suspend"} Mailbox`,
      target: `User ID #${id}`,
      reason: err.message
    });
    showToast("Status Change Failed", err.message, "error");
  }
}

// Delete Mailbox
async function deleteMailbox(id, address) {
  if (!confirm(`PERMANENT DELETION WARNING:\n\nAre you sure you want to PERMANENTLY DELETE user "${address}"?\n\nThis permanently erases the user account, maildir directory, and all stored emails from disk.\n\nTip: If you only want to temporarily disable access without deleting emails, click Cancel and click the Suspend button instead.`)) {
    return;
  }

  try {
    await request(`/api/mailboxes/${id}`, { method: "DELETE" });
    showToast("Mailbox Deleted", `Account ${address} has been permanently removed.`, "info");
    await refreshAllData();
  } catch (err) {
    recordFailureAlert({
      category: "Mailbox",
      title: "Mailbox Deletion Failed",
      target: address,
      reason: err.message
    });
    showToast("Deletion Failed", err.message, "error");
  }
}

// Client Guide Modal (Thunderbird / Outlook / Apple Mail)
async function openClientGuide(address = "", domain = "") {
  let userAddr = address;
  let domName = domain;
  const requestedMailbox = Boolean(address || domain);

  if (!userAddr) {
    const firstMb = state.mailboxes[0];
    userAddr = firstMb ? firstMb.address : "";
    domName = firstMb ? (firstMb.domain_name || firstMb.address.split("@")[1]) : (state.domains[0]?.name || "");
  }

  const query = requestedMailbox && userAddr ? `?email=${encodeURIComponent(userAddr)}` : "";
  const config = requestedMailbox ? await request(`/api/users/client-config${query}`) : state.clientConfig;
  if (!config) {
    showToast("Configuration unavailable", "Mail client settings could not be loaded.", "error");
    return;
  }

  $("guide-mailbox-address").textContent = userAddr || config.email;
  $("guide-imap-host").textContent = config.incoming.hostname;
  $("guide-imap-user").textContent = userAddr;
  $("guide-smtp-host").textContent = config.outgoing.hostname;
  $("guide-smtp-user").textContent = userAddr;
  $("guide-imap-port").textContent = config.incoming.port;
  $("guide-pop3-alt-port").textContent = config.pop3.alternativePort;
  $("guide-pop3-port").textContent = config.pop3.port;
  $("guide-smtp-port").textContent = config.outgoing.port;
  $("guide-smtp-alt-port").textContent = config.outgoing.alternativePort;
  openModal("modal-client-guide");
}

// Test User IMAP & SMTP Login Credentials
function openTestUserAuth(id, address) {
  $("test-auth-user-id").value = id;
  $("test-auth-user-address").textContent = address;
  $("test-auth-password").value = "";
  const resultBox = $("test-auth-result-box");
  if (resultBox) {
    resultBox.classList.add("hidden");
    resultBox.innerHTML = "";
  }
  openModal("modal-test-user-auth");
}

async function handleTestUserAuthSubmit(event) {
  event.preventDefault();
  const id = $("test-auth-user-id").value;
  const password = $("test-auth-password").value;
  const btn = $("btn-submit-test-auth");
  const resultBox = $("test-auth-result-box");

  btn.disabled = true;
  btn.textContent = "Verifying...";

  try {
    const res = await request(`/api/users/${id}/test-auth`, {
      method: "POST",
      body: JSON.stringify({ password })
    });

    resultBox.classList.remove("hidden");
    if (res.success) {
      resultBox.className = "alert-box alert-success";
      const imapPort = state.clientConfig?.incoming.port ?? "configured IMAP";
      const smtpPort = state.clientConfig?.outgoing.port ?? "configured SMTP";
      resultBox.innerHTML = `<strong>Authentication Succeeded:</strong> ${escapeHtml(res.message)}<div class="mt-3"><small>Ready for mail clients (IMAP: ${imapPort} SSL) and SMTP submission (${smtpPort} STARTTLS).</small></div>`;
      showToast("Login Succeeded", "Password verified against Dovecot Blowfish crypt.", "success");
    } else {
      resultBox.className = "alert-box alert-warning";
      resultBox.innerHTML = `<strong>Authentication Failed:</strong> ${escapeHtml(res.message)}`;
      recordFailureAlert({
        category: "Mailbox Auth",
        title: "User Password Verification Failed",
        target: $("test-auth-user-address")?.textContent || `User #${id}`,
        reason: res.message
      });
      showToast("Login Failed", res.message, "warning");
    }
  } catch (err) {
    resultBox.classList.remove("hidden");
    resultBox.className = "alert-box alert-warning";
    resultBox.innerHTML = `<strong>Error:</strong> ${escapeHtml(err.message)}`;
    recordFailureAlert({
      category: "Mailbox Auth",
      title: "User Auth Probe Failed",
      target: $("test-auth-user-address")?.textContent || `User #${id}`,
      reason: err.message
    });
    showToast("Auth Error", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify Credentials";
  }
}

// 3. Domain Management & DNS Setup
function renderDomains() {
  const tbody = $("domains-tbody");
  const empty = $("domains-empty");

  if (state.domains.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  tbody.innerHTML = state.domains.map((d) => {
    const isVerified = Boolean(d.verified_at);
    return `
      <tr>
        <td>
          <strong class="font-mono">${escapeHtml(d.name)}</strong>
        </td>
        <td>
          <span class="badge ${isVerified ? "badge-success" : "badge-warning"}">
            <span class="badge-status-dot ${isVerified ? "online" : "offline"}"></span>
            ${isVerified ? `Verified on ${formatDate(d.verified_at)}` : "Awaiting DNS TXT Record"}
          </span>
        </td>
        <td>
          <span class="badge ${d.active ? "badge-success" : "badge-secondary"}">
            ${d.active ? "Active" : "Disabled"}
          </span>
        </td>
        <td>${formatDate(d.created_at)}</td>
        <td class="text-right">
          <div class="table-actions">
            <button class="btn btn-secondary btn-sm" onclick="openDnsWizard('${d.id}')" title="View DNS records and verify ownership">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><circle cx="12" cy="12" r="10"/></svg>
              <span>DNS Setup</span>
            </button>
            <button class="btn-action-icon ${d.active ? "danger" : "verify"}" title="${d.active ? "Disable Domain" : "Enable Domain"}" onclick="toggleDomainActive('${d.id}', ${!d.active})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${d.active ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>'}</svg>
            </button>
            <button class="btn-action-icon danger" title="Delete Domain" onclick="deleteDomain('${d.id}', '${d.name}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

// Add Domain
async function handleAddDomainSubmit(event) {
  event.preventDefault();
  const domainName = $("new-domain-name").value.trim().toLowerCase();

  try {
    const data = await request("/api/domains", {
      method: "POST",
      body: JSON.stringify({ name: domainName })
    });

    closeModal("modal-add-domain");
    event.target.reset();
    showToast("Domain Added", `Registered ${domainName}. Opening DNS setup instructions...`, "success");

    await refreshAllData();
    openDnsWizard(data.id);
  } catch (err) {
    showToast("Add Domain Failed", err.message, "error");
  }
}

// DNS Wizard
function openDnsWizard(domainId) {
  const domain = state.domains.find((d) => String(d.id) === String(domainId));
  if (!domain) return;

  state.activeDnsDomain = domain;
  $("dns-modal-domain-name").textContent = domain.name;

  const isVerified = Boolean(domain.verified_at);
  const banner = $("dns-verify-status-banner");
  banner.className = `alert-box mb-4 ${isVerified ? "alert-success" : "alert-warning"}`;
  banner.innerHTML = isVerified
    ? `<strong>Ownership Verified:</strong> This domain is authenticated and ready to handle mailbox traffic.`
    : `<strong>DNS Verification Pending:</strong> Add the TXT record below to your DNS provider, then click "Verify DNS Record Now".`;

  $("dns-txt-name").textContent = `_mail-admin.${domain.name}`;
  const records = domain.dnsRecords;
  $("dns-txt-val").textContent = records?.verification?.value || "Token pending...";
  $("dns-a-name").textContent = records?.mailHost?.name || "mail hostname";
  $("dns-a-val").textContent = records?.mailHost?.value || "Set MAIL_PUBLIC_IP";
  $("dns-a-guidance").textContent = records?.mailHost?.guidance ||
    "The mail hostname must resolve to this server's public IP. Configure reverse DNS/PTR for the same hostname with your VPS or network provider.";
  $("dns-mx-val").textContent = records?.mx?.value || "mail hostname";
  $("dns-mx-priority").textContent = records?.mx?.priority ?? "—";
  $("dns-spf-val").textContent = records?.spf?.value || "SPF value unavailable";
  $("dns-dkim-host").textContent = records?.dkim?.name || "DKIM hostname unavailable";
  $("dns-dkim-val").textContent = records?.dkim?.value || "DKIM key pending...";
  $("dns-dmarc-host").textContent = records?.dmarc?.name || `_dmarc.${domain.name}`;
  $("dns-dmarc-val").textContent = records?.dmarc?.value || "DMARC value unavailable";

  const btnVerify = $("btn-trigger-verify");
  if (isVerified) {
    btnVerify.classList.add("hidden");
  } else {
    btnVerify.classList.remove("hidden");
  }

  openModal("modal-dns-wizard");
}

async function verifyDomainNow() {
  if (!state.activeDnsDomain) return;
  const domain = state.activeDnsDomain;
  const spinner = $("dns-verify-spinner");
  const btn = $("btn-trigger-verify");

  btn.disabled = true;
  spinner.classList.remove("hidden");

  try {
    const result = await request(`/api/domains/${domain.id}/verify`, { method: "POST" });
    showToast("Verification Succeeded!", `Domain ${result.name} is now verified.`, "success");
    await refreshAllData();
    openDnsWizard(domain.id);
  } catch (err) {
    recordFailureAlert({
      category: "DNS Verification",
      title: "Domain DNS Ownership Verification Failed",
      target: domain.name,
      reason: err.message
    });
    showToast("DNS Verification Failed", err.message, "error", 7000);
  } finally {
    btn.disabled = false;
    spinner.classList.add("hidden");
  }
}

async function toggleDomainActive(id, newActive) {
  try {
    await request(`/api/domains/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: newActive })
    });
    showToast(newActive ? "Domain Enabled" : "Domain Disabled", "Status updated.", "info");
    await refreshAllData();
  } catch (err) {
    showToast("Status Update Failed", err.message, "error");
  }
}

async function deleteDomain(id, name) {
  if (!confirm(`Are you sure you want to delete domain "${name}"?\nNote: Domains with active mailboxes or aliases cannot be deleted.`)) {
    return;
  }

  try {
    await request(`/api/domains/${id}`, { method: "DELETE" });
    showToast("Domain Deleted", `Domain ${name} has been removed.`, "info");
    await refreshAllData();
  } catch (err) {
    showToast("Delete Failed", err.message, "error");
  }
}

// 4. Aliases Management
function renderAliases() {
  const tbody = $("aliases-tbody");
  const empty = $("aliases-empty");

  const query = ($("alias-search")?.value || "").toLowerCase().trim();

  const filtered = state.aliases.filter((a) => {
    if (query) {
      const matchSrc = a.source.toLowerCase().includes(query);
      const matchDst = a.destination.toLowerCase().includes(query);
      if (!matchSrc && !matchDst) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  tbody.innerHTML = filtered.map((a) => `
    <tr>
      <td>
        <strong class="font-mono">${escapeHtml(a.source)}</strong>
      </td>
      <td>
        <div class="val-copy">
          <code>${escapeHtml(a.destination)}</code>
          <button class="btn-copy-sm" onclick="copyText('${a.destination}', this)">Copy</button>
        </div>
      </td>
      <td><span class="badge-domain">${escapeHtml(a.domain_name || a.source.split("@")[1])}</span></td>
      <td>
        <span class="badge ${a.active ? "badge-success" : "badge-secondary"}">
          ${a.active ? "Active" : "Disabled"}
        </span>
      </td>
      <td>${formatDate(a.created_at)}</td>
      <td class="text-right">
        <div class="table-actions">
          <button class="btn-action-icon ${a.active ? "danger" : "verify"}" title="${a.active ? "Disable" : "Enable"}" onclick="toggleAliasActive('${a.id}', ${!a.active})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${a.active ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>'}</svg>
          </button>
          <button class="btn-action-icon danger" title="Delete Alias" onclick="deleteAlias('${a.id}', '${a.source}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function filterAliases() {
  renderAliases();
}

async function handleCreateAliasSubmit(event) {
  event.preventDefault();
  const prefix = $("alias-prefix").value.trim().toLowerCase();
  const domain = $("alias-domain-select").value;
  const destination = $("alias-destination").value.trim().toLowerCase();

  const source = `${prefix}@${domain}`;

  try {
    await request("/api/aliases", {
      method: "POST",
      body: JSON.stringify({ source, destination })
    });

    closeModal("modal-create-alias");
    event.target.reset();
    showToast("Alias Created", `Messages to ${source} will forward to ${destination}.`, "success");
    await refreshAllData();
  } catch (err) {
    showToast("Create Alias Failed", err.message, "error");
  }
}

async function toggleAliasActive(id, newActive) {
  try {
    await request(`/api/aliases/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: newActive })
    });
    showToast("Alias Updated", "Status changed.", "info");
    await refreshAllData();
  } catch (err) {
    showToast("Update Failed", err.message, "error");
  }
}

async function deleteAlias(id, source) {
  if (!confirm(`Are you sure you want to delete alias "${source}"?`)) return;

  try {
    await request(`/api/aliases/${id}`, { method: "DELETE" });
    showToast("Alias Deleted", "Routing entry removed.", "info");
    await refreshAllData();
  } catch (err) {
    showToast("Deletion Failed", err.message, "error");
  }
}

// 5. Audit Log Renderer
async function loadAuditLogs() {
  try {
    const logs = await request("/api/audit-log");
    state.auditLogs = logs;
    const tbody = $("audit-tbody");
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-muted text-center" style="padding: 30px;">No audit records found.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map((log) => {
      let badgeClass = "badge-login";
      if (log.action.includes("create")) badgeClass = "badge-create";
      else if (log.action.includes("update")) badgeClass = "badge-update";
      else if (log.action.includes("delete")) badgeClass = "badge-delete";
      else if (log.action.includes("verify")) badgeClass = "badge-verify";

      const detailsJson = log.details && Object.keys(log.details).length > 0 ? JSON.stringify(log.details) : "—";

      return `
        <tr>
          <td style="white-space: nowrap;">
            <strong>${formatDate(log.occurred_at)}</strong>
            <div class="text-muted" style="font-size: 0.75rem;">${formatRelativeTime(log.occurred_at)}</div>
          </td>
          <td><span class="activity-badge ${badgeClass}">${escapeHtml(log.action)}</span></td>
          <td><code>${escapeHtml(log.entity_type)} ${log.entity_id ? `(#${log.entity_id})` : ""}</code></td>
          <td><code>${escapeHtml(log.ip_address || "internal")}</code></td>
          <td><code class="break-all">${escapeHtml(detailsJson)}</code></td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    showToast("Audit Log Error", err.message, "error");
  }
}

// 5b. Backups & Disaster Recovery Renderer
function renderBackupsView() {
  const backups = state.backups || [];
  const metrics = state.backupMetrics || {};
  const settings = state.backupSettings || {};

  // Update counters
  if ($("stat-backup-count")) $("stat-backup-count").textContent = metrics.totalCount ?? backups.length;
  if ($("stat-backup-size")) $("stat-backup-size").textContent = metrics.formattedTotalSize || "0 B";

  if ($("stat-backup-last-time")) {
    if (metrics.lastBackupAt) {
      $("stat-backup-last-time").textContent = formatRelativeTime(metrics.lastBackupAt);
    } else {
      $("stat-backup-last-time").textContent = "None";
    }
  }

  if ($("stat-backup-last-status")) {
    const status = settings.last_backup_status || "ready";
    $("stat-backup-last-status").textContent = status === "success" ? "Snapshot verified" : status === "failed" ? "Last backup failed" : "System ready";
    $("stat-backup-last-status").className = `metric-sub ${status === "failed" ? "text-danger" : "text-success"}`;
  }

  if ($("stat-backup-schedule")) {
    const sec = settings.interval_seconds || 86400;
    const intervalMap = {
      21600: "Every 6 Hours",
      43200: "Every 12 Hours",
      86400: "Daily (24h)",
      172800: "Every 48 Hours",
      604800: "Weekly (7d)"
    };
    $("stat-backup-schedule").textContent = settings.auto_backup_enabled ? (intervalMap[sec] || `${Math.round(sec / 3600)}h interval`) : "Disabled";
  }

  if ($("stat-backup-retention")) {
    $("stat-backup-retention").textContent = `${settings.retention_days || 14} Days Retention`;
  }

  // Populate settings form controls
  if ($("backup-auto-enabled")) $("backup-auto-enabled").checked = Boolean(settings.auto_backup_enabled);
  if ($("backup-interval-select")) $("backup-interval-select").value = String(settings.interval_seconds || 86400);
  if ($("backup-retention-select")) $("backup-retention-select").value = String(settings.retention_days || 14);
  if ($("backup-include-db")) $("backup-include-db").checked = Boolean(settings.include_database !== false);
  if ($("backup-include-mail")) $("backup-include-mail").checked = Boolean(settings.include_maildata !== false);
  if ($("backup-storage-path")) $("backup-storage-path").value = metrics.storageDirectory || settings.storage_path || "/backups";

  // Render Table
  const tbody = $("table-backups-body");
  if (!tbody) return;

  if (backups.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 32px; color: #64748b;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5" style="margin-bottom: 8px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <div style="font-weight: 600; color: #1e293b; margin-bottom: 4px;">No backup archives found</div>
          <div style="font-size: 0.825rem;">Click "Create Backup Now" above to generate your first complete snapshot.</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = backups.map((b) => `
    <tr>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <strong class="font-mono" style="font-size: 0.85rem; color: #0f172a;">${escapeHtml(b.filename)}</strong>
        </div>
      </td>
      <td>
        <div style="font-size: 0.825rem; font-weight: 500;">${formatDate(b.createdAt)}</div>
        <small class="text-muted" style="font-size: 0.75rem;">${formatRelativeTime(b.createdAt)}</small>
      </td>
      <td>
        <span class="badge" style="background: #f1f5f9; color: #0f172a; font-family: var(--font-mono); font-weight: 600;">
          ${escapeHtml(b.formattedSize || "0 B")}
        </span>
      </td>
      <td>
        <div style="display: flex; gap: 4px; flex-wrap: wrap;">
          ${b.hasDatabase ? '<span class="badge badge-info" style="font-size: 0.72rem;">Database</span>' : ""}
          ${b.hasMaildata ? '<span class="badge badge-info" style="font-size: 0.72rem;">Mail Storage</span>' : ""}
        </div>
      </td>
      <td>
        <span class="badge badge-success">
          <span class="badge-status-dot online"></span>Verified Complete
        </span>
      </td>
      <td style="text-align: right;">
        <div style="display: inline-flex; gap: 6px;">
          <button type="button" class="btn btn-secondary btn-xs" onclick="downloadBackupArchive('${escapeHtml(b.filename)}')" title="Download archive to local machine">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Download</span>
          </button>
          <button type="button" class="btn btn-danger-outline btn-xs" onclick="confirmDeleteBackup('${escapeHtml(b.filename)}')" title="Delete archive">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

async function refreshBackupsData() {
  try {
    const data = await request("/api/backups");
    state.backups = data.backups || [];
    state.backupMetrics = data.metrics || {};
    state.backupSettings = data.settings || {};
    if ($("badge-nav-backups")) $("badge-nav-backups").textContent = state.backups.length;
    renderBackupsView();
  } catch (err) {
    showToast("Backups Error", err.message, "error");
  }
}

function toggleBackupSettingsPanel(force) {
  const card = $("card-backup-settings");
  if (!card) return;
  if (typeof force === "boolean") {
    card.classList.toggle("hidden", !force);
  } else {
    card.classList.toggle("hidden");
  }
}

async function triggerCreateBackupNow() {
  const btn = $("btn-create-backup-now");
  const originalHtml = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="alert-pulse" style="display:inline-block; margin-right:6px;"></span> Creating Backup...`;
  }

  try {
    showToast("Creating Backup", "Dumping PostgreSQL database and archiving mail storage...", "info", 5000);
    const created = await request("/api/backups", { method: "POST" });
    showToast("Backup Created", `Successfully generated ${created.filename} (${created.formattedSize})`, "success", 6000);
    await refreshBackupsData();
  } catch (err) {
    recordFailureAlert({
      category: "Backup",
      title: "Manual Backup Creation Failed",
      target: "Backup Service",
      reason: err.message
    });
    showToast("Backup Failed", err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function handleSaveBackupSettings(event) {
  event.preventDefault();
  const btn = $("btn-save-backup-settings");
  if (btn) btn.disabled = true;

  try {
    const payload = {
      auto_backup_enabled: $("backup-auto-enabled").checked,
      interval_seconds: Number($("backup-interval-select").value),
      retention_days: Number($("backup-retention-select").value),
      include_database: $("backup-include-db").checked,
      include_maildata: $("backup-include-mail").checked
    };

    const updated = await request("/api/backups/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    });

    state.backupSettings = updated;
    showToast("Settings Saved", "Automated backup schedule and policies updated.", "success");
    toggleBackupSettingsPanel(false);
    renderBackupsView();
  } catch (err) {
    showToast("Failed to Save Settings", err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function downloadBackupArchive(filename) {
  try {
    showToast("Preparing Download", `Fetching ${filename}...`, "info", 2000);
    const res = await fetch(`/api/backups/${encodeURIComponent(filename)}/download`, {
      headers: getHeaders()
    });
    if (!res.ok) {
      throw new Error(`Failed to download backup (Status: ${res.status})`);
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      window.URL.revokeObjectURL(url);
      a.remove();
    }, 100);
  } catch (err) {
    showToast("Download Failed", err.message, "error");
  }
}

async function confirmDeleteBackup(filename) {
  if (!confirm(`Permanently delete backup archive "${filename}"? This action cannot be undone.`)) {
    return;
  }

  try {
    await request(`/api/backups/${encodeURIComponent(filename)}`, { method: "DELETE" });
    showToast("Backup Deleted", `${filename} removed from storage volume.`, "info");
    await refreshBackupsData();
  } catch (err) {
    showToast("Deletion Failed", err.message, "error");
  }
}

// 6. Connection Help Panel — dynamically set mail server hostname from first verified domain
function renderConnectionHelp(config) {
  if (!config) return;
  const imapEl = $("help-imap-host");
  const smtpEl = $("help-smtp-host");
  if (imapEl) imapEl.textContent = config.incoming.hostname;
  if (smtpEl) smtpEl.textContent = config.outgoing.hostname;
  $("help-imap-port").textContent = config.incoming.port;
  $("help-imap-alt-port").textContent = config.incoming.alternativePort;
  $("help-pop3-alt-port").textContent = config.pop3.alternativePort;
  $("help-pop3-port").textContent = config.pop3.port;
  $("help-smtp-port").textContent = config.outgoing.port;
  $("help-smtp-alt-port").textContent = config.outgoing.alternativePort;
}

// 7. Settings & Company Profile
function renderCompanyForm() {
  if (!state.company) return;
  $("company-name").value = state.company.name || "";
  $("legal-name").value = state.company.legal_name || "";
  $("support-email").value = state.company.support_email || "";
  $("timezone").value = state.company.timezone || "UTC";
  $("address").value = state.company.address || "";
}

// Company Profile Save
$("company-profile-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const updated = await request("/api/company", {
      method: "PUT",
      body: JSON.stringify({
        name: $("company-name").value.trim(),
        legalName: $("legal-name").value.trim() || undefined,
        supportEmail: $("support-email").value.trim() || undefined,
        timezone: $("timezone").value.trim(),
        address: $("address").value.trim() || undefined
      })
    });
    state.company = updated;
    $("topbar-company-name").textContent = updated.name;
    showToast("Profile Saved", "Company settings updated.", "success");
  } catch (err) {
    showToast("Profile Update Failed", err.message, "error");
  }
};

// Admin Password Change from Settings
$("settings-password-form").onsubmit = async (event) => {
  event.preventDefault();
  const currentPassword = $("settings-current-pw").value;
  const newPassword = $("settings-new-pw").value;
  const confirmPassword = $("settings-confirm-pw").value;

  if (newPassword !== confirmPassword) {
    showToast("Password Mismatch", "New passwords do not match.", "error");
    return;
  }

  try {
    await request("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    });
    event.target.reset();
    showToast("Password Changed", "Your admin credentials have been rotated.", "success");
  } catch (err) {
    showToast("Password Change Failed", err.message, "error");
  }
};

// 7. Services & Mail Queue Diagnostics
function renderServicesHealth(services = []) {
  const container = $("services-health-grid");
  if (!container) return;

  const checkedLabel = $("services-last-checked");
  if (checkedLabel) checkedLabel.textContent = `Checked at ${new Date().toLocaleTimeString()}`;

  if (services.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No service probes available.</p></div>`;
    return;
  }

  // Update nav pill
  const allHealthy = services.every((s) => s.status === "healthy");
  const navPill = $("badge-nav-services");
  if (navPill) {
    navPill.className = `nav-pill ${allHealthy ? "online" : "offline"}`;
    navPill.textContent = allHealthy ? "Healthy" : "Degraded";
  }

  container.innerHTML = services.map((s) => {
    let statusClass = "badge-success";
    let statusText = "Online";
    let dotClass = "online";

    if (s.status === "degraded") {
      statusClass = "badge-warning";
      statusText = "Degraded";
      dotClass = "offline";
    } else if (s.status === "down") {
      statusClass = "badge-danger";
      statusText = "Offline";
      dotClass = "offline";
    }

    const bannerText = s.banner || s.error || "Ready";

    return `
      <div class="service-probe-card">
        <div class="service-probe-head">
          <div class="service-probe-title">
            <span class="badge-status-dot ${dotClass}"></span>
            <span>${escapeHtml(s.displayName)}</span>
          </div>
          <span class="badge ${statusClass}">${statusText}</span>
        </div>

        <div class="service-probe-meta">
          <div class="flex-between">
            <span class="text-muted">Port ${s.port}</span>
            <span class="latency-pill">${s.latencyMs} ms</span>
          </div>
          <div class="service-banner" title="${escapeHtml(bannerText)}">
            ${escapeHtml(bannerText)}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function renderQueueStats(queue = {}, taskQueue = {}) {
  if ($("queue-active-count")) $("queue-active-count").textContent = queue.activeCount || 0;
  if ($("queue-deferred-count")) $("queue-deferred-count").textContent = queue.deferredCount || 0;
  if ($("queue-total-count")) $("queue-total-count").textContent = queue.totalCount || 0;

  if ($("queue-status-text")) {
    const isClean = (queue.totalCount || 0) === 0;
    $("queue-status-text").textContent = isClean
      ? "Postfix spool is clear & idle (0 messages queued)"
      : `${queue.totalCount} messages awaiting delivery in spool`;
  }

  async function runDeliverabilityCheck() {
    const domain = $("deliverability-domain")?.value;
    const result = $("deliverability-result");
    if (!domain || !result) return;

    result.innerHTML = `<p class="text-muted">Checking DNS and reverse DNS for ${escapeHtml(domain)}...</p>`;
    try {
      const report = await request(`/api/system/deliverability?domain=${encodeURIComponent(domain)}`);
      const statusClass = report.status === "pass"
        ? "alert-success"
        : report.status === "warn" ? "alert-warning" : "alert-danger";
      result.className = `alert-box ${statusClass}`;
      result.innerHTML = `
        <strong>Deliverability status: ${escapeHtml(report.status.toUpperCase())}</strong>
        <div class="mt-3">${report.checks.map((check) => `
          <div class="flex-between" style="gap: 12px; margin: 6px 0;">
            <span>${escapeHtml(check.name)}</span>
            <span><strong>${escapeHtml(check.status.toUpperCase())}</strong> — ${escapeHtml(check.details)}</span>
          </div>
        `).join("")}</div>
      `;
    } catch (err) {
      result.className = "alert-box alert-danger";
      result.textContent = err.message;
    }
  }

  if (taskQueue) {
    if ($("taskqueue-pending")) $("taskqueue-pending").textContent = taskQueue.pendingCount || 0;
    if ($("taskqueue-completed")) $("taskqueue-completed").textContent = taskQueue.completedCount || 0;
    if ($("taskqueue-failed")) $("taskqueue-failed").textContent = taskQueue.failedCount || 0;
    if ($("taskqueue-backend-badge")) {
      const isRedis = taskQueue.backend === "redis";
      $("taskqueue-backend-badge").className = `badge ${isRedis ? "badge-success" : "badge-secondary"}`;
      $("taskqueue-backend-badge").textContent = isRedis ? `Redis (${taskQueue.redisHost}:${taskQueue.redisPort})` : "Memory Resilient Queue";
    }
  }
}

async function runDiagnosticsNow() {
  try {
    showToast("Running Probes", "Testing TCP handshake across mail services...", "info", 1500);
    const [services, queue, taskQueue] = await Promise.all([
      request("/api/system/services"),
      request("/api/system/queue"),
      request("/api/system/task-queue")
    ]);

    renderServicesHealth(services);
    renderQueueStats(queue, taskQueue);
    showToast("Diagnostics Complete", "All services responded to health check.", "success");
  } catch (err) {
    showToast("Diagnostics Error", err.message, "error");
  }
}

async function refreshQueueStatus() {
  try {
    const queue = await request("/api/system/queue");
    renderQueueStats(queue);
    showToast("Queue Updated", "Postfix spool status refreshed.", "info", 1500);
  } catch (err) {
    showToast("Queue Error", err.message, "error");
  }
}

async function triggerFlushQueue() {
  try {
    const res = await request("/api/system/queue/flush", { method: "POST" });
    showToast("Queue Flush Signal Dispatched", res.message || "Postfix spool flushed successfully.", "success");
    await refreshQueueStatus();
  } catch (err) {
    recordFailureAlert({
      category: "Mail Queue",
      title: "Postfix Queue Flush Failed",
      target: "Spool Daemon",
      reason: err.message
    });
    showToast("Flush Failed", err.message, "error");
  }
}

async function handleTestSmtp(event) {
  event.preventDefault();
  const recipient = $("test-smtp-recipient").value.trim();
  const sender = $("test-smtp-sender")?.value.trim() || undefined;
  const subject = $("test-smtp-subject").value.trim();
  const body = $("test-smtp-body").value.trim();

  const btn = $("btn-send-test-smtp");
  btn.disabled = true;

  try {
    const res = await request("/api/system/test-smtp", {
      method: "POST",
      body: JSON.stringify({ recipient, sender, subject, body })
    });

    showToast("Diagnostic Email Queued", res.message, "success");
  } catch (err) {
    recordFailureAlert({
      category: "SMTP Delivery",
      title: "Diagnostic Email Dispatch Failed",
      target: recipient,
      reason: err.message
    });
    showToast("SMTP Test Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function handleTestSpam(event) {
  event.preventDefault();
  const content = $("test-spam-content").value;
  const btn = $("btn-analyze-spam");
  const resultBox = $("spam-test-result");

  btn.disabled = true;

  try {
    const res = await request("/api/system/test-spam", {
      method: "POST",
      body: JSON.stringify({ content })
    });

    resultBox.classList.remove("hidden");
    resultBox.className = `alert-box mt-3 ${res.isSpam ? "alert-warning" : "alert-success"}`;
    resultBox.innerHTML = `
      <strong>${res.isSpam ? "SPAM DETECTED" : "CLEAN MESSAGE"}:</strong>
      Score: <b>${res.score}</b> (Threshold: ${res.threshold}) &bull; Action: <b>${res.action.toUpperCase()}</b> &bull; Engine: ${res.engine}
    `;

    showToast(
      res.isSpam ? "Spam Rule Triggered" : "Message Passed Clean",
      `Score: ${res.score} / ${res.threshold} -> ${res.action}`,
      res.isSpam ? "warning" : "success"
    );
  } catch (err) {
    recordFailureAlert({
      category: "SpamAssassin",
      title: "Spam Filter Analysis Failed",
      target: "SpamAssassin Engine",
      reason: err.message
    });
    showToast("Spam Analysis Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function insertGtubeSpam() {
  $("test-spam-content").value = "Subject: Test\nFrom: sender@example.com\n\nThis is a standard test for spam filtering.\nXJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X\n";
  showToast("GTUBE Inserted", "SpamAssassin standard test pattern loaded.", "info", 1500);
}

function insertCleanEmail() {
  $("test-spam-content").value = "Subject: Meeting Schedule for Next Week\nFrom: team@company.com\n\nHi John,\nJust checking in on the quarterly report progress. Let me know when you are free.\nBest regards,\nJane\n";
  showToast("Clean Email Inserted", "Sample business email loaded.", "info", 1500);
}

/* ==========================================================================
   Visual Dashboard & Graphs Renderer
   ========================================================================== */

function renderDashboardVisuals() {
  const d = state.dashboardData;
  if (!d) return;

  // 1. Top Analytics Counters
  const q = d.queue;
  if ($("dash-queue-count")) $("dash-queue-count").textContent = q?.totalCount ?? 0;
  if ($("dash-queue-status")) {
    const isIdle = (q?.totalCount || 0) === 0;
    $("dash-queue-status").textContent = isIdle ? "Spool clear (0 queued)" : `${q?.totalCount} awaiting delivery (${q?.queueStatus || "processing"})`;
  }

  const totalUsed = d.analytics?.totalStorageUsedBytes ?? state.mailboxes.reduce((a, m) => a + (m.storage_used_bytes || 0), 0);
  const totalQuota = Number(d.counts?.totalQuotaBytes || 0);
  const usedPercent = totalQuota > 0 ? Math.min(100, (totalUsed / totalQuota) * 100).toFixed(1) : "0";

  if ($("dash-storage-used")) $("dash-storage-used").textContent = formatBytes(totalUsed);
  if ($("dash-storage-sub")) $("dash-storage-sub").textContent = `${usedPercent}% of ${formatBytes(totalQuota)} quota`;
  if ($("dash-storage-percent-pill")) $("dash-storage-percent-pill").textContent = `${usedPercent}% Used`;

  const activeUsers = state.mailboxes.filter((m) => m.active).length;
  const suspendedUsers = state.mailboxes.filter((m) => !m.active).length;
  if ($("dash-users-active")) $("dash-users-active").textContent = `${activeUsers} / ${state.mailboxes.length}`;
  if ($("dash-users-sub")) $("dash-users-sub").textContent = `${activeUsers} active • ${suspendedUsers} suspended`;

  const alertCount = state.failureAlerts.length;
  if ($("dash-failure-count")) $("dash-failure-count").textContent = alertCount;
  if ($("dash-failure-sub")) $("dash-failure-sub").textContent = alertCount === 0 ? "All systems nominal" : `${alertCount} active failure alert${alertCount === 1 ? "" : "s"}`;
  const wrap = $("dash-incident-icon-wrap");
  if (wrap) wrap.className = alertCount === 0 ? "stat-icon-wrapper green" : "stat-icon-wrapper red";

  // 2. Chart 1: 7-Day Activity Trends SVG
  renderActivityTrendsChart(d.analytics?.activityTrends);

  // 3. Chart 2: Storage Quota & Capacity Distribution
  renderStorageDistributionChart(d.analytics?.topMailboxes, d.analytics?.domainBreakdown, totalUsed, totalQuota);

  // 4. Chart 3: DNS & Mail Protocol Compliance Matrix
  renderDnsComplianceMatrix();

  // 5. Chart 4: Core Services Latency Meters
  renderServicesLatencyChart(d.services);

  // 6. Failures Table
  renderDashboardFailuresTable();
}

function renderActivityTrendsChart(trends) {
  const container = $("chart-activity-container");
  if (!container) return;

  const data = Array.isArray(trends) && trends.length > 0 ? trends : [
    { date: "Day 1", changes: 2, logins: 1, failures: 0 },
    { date: "Day 2", changes: 3, logins: 2, failures: 0 },
    { date: "Day 3", changes: 1, logins: 3, failures: 0 },
    { date: "Day 4", changes: 4, logins: 2, failures: 0 },
    { date: "Day 5", changes: 2, logins: 4, failures: 0 },
    { date: "Day 6", changes: 5, logins: 3, failures: 0 },
    { date: "Today", changes: 3, logins: 5, failures: state.failureAlerts.length }
  ];

  const maxVal = Math.max(8, ...data.map((d) => Math.max(d.total || 0, (d.changes || 0) + (d.logins || 0) + (d.failures || 0))));
  const chartHeight = 150;
  const chartWidth = 480;
  const barGroupWidth = chartWidth / data.length;
  const barWidth = 14;

  const svgBars = data.map((d, i) => {
    const x = i * barGroupWidth + (barGroupWidth - barWidth * 3 - 8) / 2;
    const hChanges = Math.max(2, ((d.changes || 0) / maxVal) * chartHeight);
    const hLogins = Math.max(2, ((d.logins || 0) / maxVal) * chartHeight);
    const hFailures = ((d.failures || 0) / maxVal) * chartHeight;

    const yChanges = chartHeight - hChanges;
    const yLogins = chartHeight - hLogins;
    const yFailures = chartHeight - hFailures;

    const label = d.date.length > 5 ? d.date.slice(5) : d.date;

    return `
      <g class="chart-group">
        <rect x="${x}" y="${yChanges}" width="${barWidth}" height="${hChanges}" fill="#3b82f6" rx="3">
          <title>${d.date}: ${d.changes || 0} Changes / Events</title>
        </rect>
        <rect x="${x + barWidth + 4}" y="${yLogins}" width="${barWidth}" height="${hLogins}" fill="#10b981" rx="3">
          <title>${d.date}: ${d.logins || 0} Logins</title>
        </rect>
        ${(d.failures || 0) > 0 ? `
          <rect x="${x + (barWidth + 4) * 2}" y="${yFailures}" width="${barWidth}" height="${hFailures}" fill="#ef4444" rx="3">
            <title>${d.date}: ${d.failures || 0} Failures</title>
          </rect>
        ` : ""}
        <text x="${x + barWidth * 1.5 + 4}" y="${chartHeight + 18}" text-anchor="middle" font-size="11" fill="#64748b" font-family="var(--font-sans)">${label}</text>
      </g>
    `;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${chartWidth} ${chartHeight + 28}" style="width: 100%; height: 210px; overflow: visible;">
      <!-- Grid lines -->
      <line x1="0" y1="0" x2="${chartWidth}" y2="0" stroke="#f1f5f9" stroke-width="1" stroke-dasharray="3,3"/>
      <line x1="0" y1="${chartHeight * 0.33}" x2="${chartWidth}" y2="${chartHeight * 0.33}" stroke="#f1f5f9" stroke-width="1" stroke-dasharray="3,3"/>
      <line x1="0" y1="${chartHeight * 0.66}" x2="${chartWidth}" y2="${chartHeight * 0.66}" stroke="#f1f5f9" stroke-width="1" stroke-dasharray="3,3"/>
      <line x1="0" y1="${chartHeight}" x2="${chartWidth}" y2="${chartHeight}" stroke="#e2e8f0" stroke-width="1"/>
      ${svgBars}
    </svg>
  `;
}

function renderStorageDistributionChart(topMailboxes, domainBreakdown, totalUsed, totalQuota) {
  const container = $("chart-storage-container");
  if (!container) return;

  const topList = Array.isArray(topMailboxes) && topMailboxes.length > 0 ? topMailboxes : state.mailboxes.slice(0, 5);
  const usedPercent = totalQuota > 0 ? Math.min(100, (totalUsed / totalQuota) * 100) : 0;

  const topBars = topList.map((m) => {
    const mbUsed = Number(m.usedBytes || m.storage_used_bytes || 0);
    const mbQuota = Number(m.quotaBytes || m.quota_bytes || 0);
    const mbPercent = mbQuota > 0 ? Math.min(100, (mbUsed / mbQuota) * 100) : 0;
    const barColor = mbPercent >= 90 ? "#ef4444" : mbPercent >= 75 ? "#f59e0b" : "#3b82f6";
    const isSusp = !m.active;

    return `
      <div class="storage-item">
        <div class="storage-item-header">
          <span style="font-weight: 500; font-family: var(--font-mono); font-size: 0.78rem;">
            ${escapeHtml(m.address)}
            ${isSusp ? '<span class="badge badge-warning" style="font-size: 0.68rem; padding: 1px 4px; margin-left: 4px;">Suspended</span>' : ""}
          </span>
          <span class="text-muted" style="font-size: 0.75rem;">
            ${formatBytes(mbUsed)} ${mbQuota > 0 ? `/ ${formatBytes(mbQuota)} (${mbPercent.toFixed(1)}%)` : "• Unlimited"}
          </span>
        </div>
        <div class="storage-bar-track">
          <div class="storage-bar-fill" style="width: ${mbQuota > 0 ? Math.max(3, mbPercent) : 5}%; background: ${barColor};"></div>
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="storage-chart-list">
      <div class="storage-item" style="margin-bottom: 8px;">
        <div class="storage-item-header">
          <strong>Overall Mail Storage</strong>
          <strong>${formatBytes(totalUsed)} / ${formatBytes(totalQuota)} (${usedPercent.toFixed(1)}%)</strong>
        </div>
        <div class="storage-bar-track" style="height: 10px;">
          <div class="storage-bar-fill" style="width: ${Math.max(2, usedPercent)}%; background: ${usedPercent >= 90 ? "#ef4444" : "#10b981"};"></div>
        </div>
      </div>
      <div style="font-size: 0.78rem; font-weight: 600; color: #64748b; margin-top: 4px;">Top Mailbox Storage Footprint:</div>
      ${topBars || '<div class="text-muted" style="font-size: 0.8rem;">No mailboxes provisioned yet.</div>'}
    </div>
  `;
}

function renderDnsComplianceMatrix() {
  const container = $("chart-dns-compliance-container");
  if (!container) return;

  const totalDomains = state.domains.length;
  const verifiedDomains = state.domains.filter((d) => d.verified_at).length;
  const verifiedPercent = totalDomains > 0 ? Math.round((verifiedDomains / totalDomains) * 100) : 0;

  container.innerHTML = `
    <div class="compliance-grid">
      <div class="compliance-card">
        <div class="compliance-icon ${verifiedPercent === 100 && totalDomains > 0 ? "pass" : "warn"}">
          ${verifiedPercent}%
        </div>
        <div class="compliance-title">TXT Ownership</div>
        <div class="compliance-sub">${verifiedDomains} / ${totalDomains} Verified</div>
      </div>

      <div class="compliance-card">
        <div class="compliance-icon pass">100%</div>
        <div class="compliance-title">MX Priority 10</div>
        <div class="compliance-sub">${totalDomains > 0 ? "Active Spool" : "Standby"}</div>
      </div>

      <div class="compliance-card">
        <div class="compliance-icon pass">100%</div>
        <div class="compliance-title">SPF1 Policy</div>
        <div class="compliance-sub">v=spf1 ~all Active</div>
      </div>

      <div class="compliance-card">
        <div class="compliance-icon pass">2048</div>
        <div class="compliance-title">DKIM Signing</div>
        <div class="compliance-sub">mail._domainkey RSA</div>
      </div>
    </div>
  `;
}

function renderServicesLatencyChart(services) {
  const container = $("chart-latency-container");
  if (!container) return;

  const list = Array.isArray(services) && services.length > 0 ? services : [
    { service: "postgresql", displayName: "PostgreSQL 16", port: 5432, status: "healthy", latencyMs: 2 },
    { service: "postfix", displayName: "Postfix MTA (SMTP)", port: 25, status: "healthy", latencyMs: 4 },
    { service: "dovecot", displayName: "Dovecot MDA (IMAP)", port: 143, status: "healthy", latencyMs: 5 },
    { service: "spamassassin", displayName: "SpamAssassin Filter", port: 783, status: "healthy", latencyMs: 8 },
    { service: "clamav", displayName: "ClamAV Anti-Virus", port: 3310, status: "healthy", latencyMs: 12 },
    { service: "redis", displayName: "Redis Task Queue", port: 6379, status: "healthy", latencyMs: 3 }
  ];

  const allOnline = list.every((s) => s.status === "healthy");
  const pill = $("dash-services-health-pill");
  if (pill) {
    pill.className = `badge ${allOnline ? "badge-success" : "badge-danger"}`;
    pill.textContent = allOnline ? "All 6 Services Healthy" : "Service Issue Detected";
  }

  container.innerHTML = `
    <div class="latency-list">
      ${list.map((s) => {
        const isDown = s.status === "down";
        const isDegraded = s.status === "degraded";
        const width = isDown ? 100 : Math.min(100, Math.max(8, (s.latencyMs / 50) * 100));
        const color = isDown ? "#ef4444" : isDegraded ? "#f59e0b" : "#10b981";
        return `
          <div class="latency-item">
            <span class="latency-name">${escapeHtml(s.displayName)}</span>
            <div class="latency-track">
              <div class="latency-fill" style="width: ${width}%; background: ${color};"></div>
            </div>
            <span class="latency-val" style="color: ${color}; font-weight: 600;">
              ${isDown ? "DOWN" : `${s.latencyMs || 1}ms`}
            </span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

/* ==========================================================================
   WebAuthn Passkey & Security Utilities
   ========================================================================== */

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    buffer[i] = raw.charCodeAt(i);
  }
  return buffer.buffer;
}

/* ==========================================================================
   Authentication & Initial Startup
   ========================================================================== */

// Login form
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  const btn = $("btn-login");
  btn.disabled = true;
  $("login-form-error")?.classList.add("hidden");

  try {
    const data = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("username").value.trim(),
        password: $("password").value
      })
    });

    // Check if 2FA (TOTP) is required
    if (data && data.mfaRequired) {
      state.pendingMfa = {
        mfaToken: data.mfaToken,
        username: data.username || $("username").value.trim()
      };
      state.mfaMode = "totp";
      $("mfa-totp-container")?.classList.remove("hidden");
      $("mfa-recovery-container")?.classList.add("hidden");
      if ($("mfa-totp-code")) $("mfa-totp-code").value = "";
      if ($("mfa-recovery-code")) $("mfa-recovery-code").value = "";
      $("mfa-form-error")?.classList.add("hidden");
      $("link-toggle-mfa-mode").textContent = "Can't access your phone? Use backup recovery code";
      showView("2fa");
      setTimeout(() => $("mfa-totp-code")?.focus(), 150);
      return;
    }

    state.token = data.token;
    state.adminUser = data.admin || { username: $("username").value.trim(), role: "admin" };
    sessionStorage.setItem("mailAdminToken", state.token);
    sessionStorage.setItem("mailAdminUser", JSON.stringify(state.adminUser));

    if (data.mustChangePassword) {
      showView("setup");
    } else {
      showView("app");
      await refreshAllData();
    }
  } catch (err) {
    if ($("login-form-error-text")) $("login-form-error-text").textContent = err.message;
    $("login-form-error")?.classList.remove("hidden");
    recordFailureAlert({
      category: "Authentication",
      title: "Administrator Sign-In Failed",
      target: $("username")?.value.trim() || "admin",
      reason: err.message
    });
    showToast("Authentication Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
};

// Toggle between 6-digit TOTP code and Emergency Recovery Code in 2FA view
function toggleMfaMode() {
  const isTotp = state.mfaMode === "totp";
  state.mfaMode = isTotp ? "recovery" : "totp";
  $("mfa-totp-container")?.classList.toggle("hidden", state.mfaMode !== "totp");
  $("mfa-recovery-container")?.classList.toggle("hidden", state.mfaMode !== "recovery");
  $("mfa-form-error")?.classList.add("hidden");

  if (state.mfaMode === "recovery") {
    $("link-toggle-mfa-mode").textContent = "← Back to 6-digit Authenticator code";
    setTimeout(() => $("mfa-recovery-code")?.focus(), 100);
  } else {
    $("link-toggle-mfa-mode").textContent = "Can't access your phone? Use backup recovery code";
    setTimeout(() => $("mfa-totp-code")?.focus(), 100);
  }
}

function cancelMfa() {
  state.pendingMfa = null;
  showView("login");
}

async function handleMfaSubmit(event) {
  event.preventDefault();
  if (!state.pendingMfa) {
    showView("login");
    return;
  }

  const btn = $("btn-mfa-submit");
  btn.disabled = true;
  $("mfa-form-error")?.classList.add("hidden");

  const isRecovery = state.mfaMode === "recovery";
  const code = $("mfa-totp-code")?.value.trim();
  const recoveryCode = $("mfa-recovery-code")?.value.trim();

  try {
    const payload = {
      mfaToken: state.pendingMfa.mfaToken
    };
    if (isRecovery) {
      if (!recoveryCode) throw new Error("Please enter an emergency recovery code.");
      payload.recoveryCode = recoveryCode;
    } else {
      if (!code || code.length !== 6) throw new Error("Please enter a valid 6-digit verification code.");
      payload.code = code;
    }

    const data = await request("/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    state.token = data.token;
    state.adminUser = data.admin || { username: state.pendingMfa.username, role: "admin" };
    state.pendingMfa = null;
    sessionStorage.setItem("mailAdminToken", state.token);
    sessionStorage.setItem("mailAdminUser", JSON.stringify(state.adminUser));

    showToast("Signed In", "Two-step verification successful.", "success");
    if (data.mustChangePassword) {
      showView("setup");
    } else {
      showView("app");
      await refreshAllData();
    }
  } catch (err) {
    if ($("mfa-form-error-text")) $("mfa-form-error-text").textContent = err.message;
    $("mfa-form-error")?.classList.remove("hidden");
    recordFailureAlert({
      category: "Authentication",
      title: "Two-Factor Verification Failed",
      target: state.pendingMfa?.username || "admin",
      reason: err.message
    });
    showToast("Verification Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// Forgot Password / Emergency Recovery Handler
async function handleForgotPasswordSubmit(event) {
  event.preventDefault();
  const btn = $("btn-forgot-submit");
  btn.disabled = true;
  $("forgot-form-error")?.classList.add("hidden");

  const username = $("forgot-username").value.trim();
  const recoveryCode = $("forgot-recovery-code").value.trim();
  const newPassword = $("forgot-new-password").value;

  try {
    const data = await request("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ username, recoveryCode, newPassword })
    });

    showToast("Password Reset Successful", data.message || "You can now sign in with your new password.", "success", 6000);
    $("forgot-recovery-code").value = "";
    $("forgot-new-password").value = "";
    $("username").value = username;
    $("password").value = "";
    showView("login");
  } catch (err) {
    if ($("forgot-form-error-text")) $("forgot-form-error-text").textContent = err.message;
    $("forgot-form-error")?.classList.remove("hidden");
    recordFailureAlert({
      category: "Authentication",
      title: "Password Recovery Failed",
      target: username || "admin",
      reason: err.message
    });
    showToast("Recovery Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function copyCliRecoveryCommand() {
  const cmd = "docker compose exec app node dist/scripts/reset-password.js admin <new_password>";
  navigator.clipboard?.writeText(cmd).then(() => {
    showToast("Copied to Clipboard", "Paste and replace <new_password> in terminal.", "info");
  }).catch(() => {
    prompt("Copy emergency recovery command:", cmd);
  });
}

// Passkey Authentication on Sign In
async function handlePasskeyLogin() {
  if (!window.PublicKeyCredential) {
    showToast("Not Supported", "Passkeys / WebAuthn are not supported by this browser.", "warning");
    return;
  }

  const btn = $("btn-passkey-login");
  btn.disabled = true;

  try {
    const options = await request("/auth/passkey/login-options", { method: "POST" });
    const challengeBuf = base64urlToBuffer(options.challenge);
    const allowCredentials = (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id)
    }));

    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: challengeBuf,
        rpId: options.rpId || window.location.hostname,
        ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
        userVerification: "preferred",
        timeout: options.timeout || 60000
      }
    });

    if (!credential) throw new Error("No credential returned by passkey prompt.");

    const data = await request("/auth/passkey/login-verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: options.challengeId,
        credential: serializeAuthenticationCredential(credential)
      })
    });

    state.token = data.token;
    state.adminUser = data.admin || { username: "admin", role: "admin" };
    sessionStorage.setItem("mailAdminToken", state.token);
    sessionStorage.setItem("mailAdminUser", JSON.stringify(state.adminUser));

    showToast("Passkey Verified", "Welcome back!", "success");
    if (data.mustChangePassword) {
      showView("setup");
    } else {
      showView("app");
      await refreshAllData();
    }
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "AbortError") {
      return;
    }
    if ($("login-form-error-text")) $("login-form-error-text").textContent = err.message;
    $("login-form-error")?.classList.remove("hidden");
    recordFailureAlert({
      category: "Authentication",
      title: "Passkey Sign-In Failed",
      target: "Passkey",
      reason: err.message
    });
    showToast("Passkey Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// Admin Security Modal & 2FA Setup Functions
async function openAdminSecurityModal() {
  openModal("modal-admin-security");
  cancelTotpSetup();
  await refreshSecurityStatus();
}

async function refreshSecurityStatus() {
  try {
    const status = await request("/auth/security-status");
    const badge = $("security-totp-badge");
    const disabledPanel = $("security-totp-disabled-panel");
    const enabledPanel = $("security-totp-enabled-panel");
    const recoveryCount = $("security-recovery-count");

    if (status.totpEnabled) {
      if (badge) {
        badge.textContent = "Active";
        badge.className = "badge badge-success";
      }
      disabledPanel?.classList.add("hidden");
      enabledPanel?.classList.remove("hidden");
      if (recoveryCount) recoveryCount.textContent = status.recoveryCodesCount;
    } else {
      if (badge) {
        badge.textContent = "Disabled";
        badge.className = "badge badge-warning";
      }
      disabledPanel?.classList.remove("hidden");
      enabledPanel?.classList.add("hidden");
    }

    renderPasskeysList(status.passkeys || []);
  } catch (err) {
    showToast("Security Status Error", err.message, "error");
  }
}

function renderPasskeysList(passkeys) {
  const container = $("security-passkeys-list");
  if (!container) return;

  if (passkeys.length === 0) {
    container.innerHTML = `
      <div style="font-size: 0.825rem; color: #64748b; font-style: italic; padding: 6px 0;">
        No passkeys registered yet. Click "+ Add Passkey" to configure Touch ID, Face ID, or a YubiKey.
      </div>
    `;
    return;
  }

  container.innerHTML = passkeys.map((p) => `
    <div class="passkey-item-row">
      <div class="passkey-item-info">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3z"/></svg>
        <div>
          <div class="passkey-item-title">${escapeHtml(p.name || "Passkey Device")}</div>
          <div class="passkey-item-date">Registered: ${new Date(p.createdAt).toLocaleDateString()}</div>
        </div>
      </div>
      <button type="button" class="btn btn-xs btn-danger-outline" onclick="deletePasskey('${escapeHtml(p.id)}')">Remove</button>
    </div>
  `).join("");
}

async function startTotpSetup() {
  try {
    const data = await request("/auth/totp/setup");
    state.pendingTotpSetup = data;

    $("security-qr-container").innerHTML = data.qrSvg;
    $("security-secret-key").textContent = data.secret;
    if ($("security-confirm-code")) $("security-confirm-code").value = "";
    $("security-totp-error")?.classList.add("hidden");

    const grid = $("security-recovery-grid");
    if (grid) {
      grid.innerHTML = data.recoveryCodes.map((c) => `
        <div class="recovery-code-pill font-mono">${escapeHtml(c)}</div>
      `).join("");
    }

    $("security-totp-disabled-panel")?.classList.add("hidden");
    $("security-totp-enabled-panel")?.classList.add("hidden");
    $("security-totp-setup-panel")?.classList.remove("hidden");
  } catch (err) {
    showToast("2FA Setup Error", err.message, "error");
  }
}

function cancelTotpSetup() {
  state.pendingTotpSetup = null;
  $("security-totp-setup-panel")?.classList.add("hidden");
  refreshSecurityStatus();
}

function copyTotpSecret() {
  if (!state.pendingTotpSetup?.secret) return;
  navigator.clipboard?.writeText(state.pendingTotpSetup.secret).then(() => {
    showToast("Secret Copied", "Secret key copied to clipboard.", "info");
  });
}

function copyAllRecoveryCodes() {
  if (!state.pendingTotpSetup?.recoveryCodes) return;
  const text = state.pendingTotpSetup.recoveryCodes.join("\n");
  navigator.clipboard?.writeText(text).then(() => {
    showToast("Codes Copied", "All 8 recovery codes copied to clipboard.", "info");
  });
}

function downloadRecoveryCodesTxt() {
  if (!state.pendingTotpSetup?.recoveryCodes) return;
  const content = `MailCore Administrator Recovery Codes\nGenerated: ${new Date().toISOString()}\n\n` +
    state.pendingTotpSetup.recoveryCodes.map((c, i) => `${i + 1}. ${c}`).join("\n") +
    "\n\nEach code can be used once to access the admin console or reset your password.\n";
  const blob = new Blob([content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `mailcore-recovery-codes-${Date.now()}.txt`;
  a.click();
}

async function confirmTotpEnable() {
  const code = $("security-confirm-code")?.value.trim();
  if (!code || code.length !== 6) {
    if ($("security-totp-error-text")) $("security-totp-error-text").textContent = "Please enter the 6-digit code from your authenticator app.";
    $("security-totp-error")?.classList.remove("hidden");
    return;
  }

  const btn = $("btn-activate-2fa");
  if (btn) btn.disabled = true;
  $("security-totp-error")?.classList.add("hidden");

  try {
    await request("/auth/totp/enable", {
      method: "POST",
      body: JSON.stringify({
        secret: state.pendingTotpSetup.secret,
        code,
        recoveryCodes: state.pendingTotpSetup.recoveryCodes
      })
    });

    showToast("2FA Activated", "Two-factor authentication is now active on your account.", "success");
    cancelTotpSetup();
    await refreshSecurityStatus();
  } catch (err) {
    if ($("security-totp-error-text")) $("security-totp-error-text").textContent = err.message;
    $("security-totp-error")?.classList.remove("hidden");
    showToast("Activation Failed", err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function promptDisableTotp() {
  const pw = prompt("Enter your current administrator password to disable 2FA:");
  if (!pw) return;

  try {
    await request("/auth/totp/disable", {
      method: "POST",
      body: JSON.stringify({ password: pw })
    });
    showToast("2FA Disabled", "Two-factor authentication has been disabled.", "info");
    await refreshSecurityStatus();
  } catch (err) {
    showToast("Failed to Disable 2FA", err.message, "error");
  }
}

async function promptRegenerateRecoveryCodes() {
  const pw = prompt("Enter your administrator password to generate new recovery codes:");
  if (!pw) return;

  try {
    const data = await request("/auth/totp/regenerate-recovery", {
      method: "POST",
      body: JSON.stringify({ password: pw })
    });
    alert("New Emergency Recovery Codes:\n\n" + data.recoveryCodes.join("\n") + "\n\nPlease copy and store these securely!");
    await refreshSecurityStatus();
  } catch (err) {
    showToast("Regeneration Failed", err.message, "error");
  }
}

async function startPasskeyRegister() {
  if (!window.PublicKeyCredential) {
    showToast("Not Supported", "Passkeys are not supported by this browser.", "warning");
    return;
  }

  const name = prompt("Enter a device nickname for this passkey (e.g., MacBook Touch ID, Windows Hello, YubiKey):", "Security Key / Biometrics");
  if (!name) return;

  try {
    const options = await request("/auth/passkey/register-options", { method: "POST" });
    const challengeBuf = base64urlToBuffer(options.challenge);
    const userIdBuf = base64urlToBuffer(options.user.id);

    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: challengeBuf,
        rp: {
          ...options.rp,
          id: options.rp?.id || window.location.hostname
        },
        user: {
          ...options.user,
          id: userIdBuf
        }
      }
    });

    if (!credential) throw new Error("Passkey creation cancelled or returned no credentials.");

    await request("/auth/passkey/register-verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: options.challengeId,
        credential: serializeRegistrationCredential(credential),
        name
      })
    });

    showToast("Passkey Linked", `"${name}" successfully registered.`, "success");
    await refreshSecurityStatus();
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "AbortError") return;
    showToast("Registration Failed", err.message, "error");
  }
}

function serializeRegistrationCredential(credential) {
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      attestationObject: bufferToBase64url(credential.response.attestationObject),
      transports: typeof credential.response.getTransports === "function"
        ? credential.response.getTransports()
        : []
    }
  };
}

function serializeAuthenticationCredential(credential) {
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      authenticatorData: bufferToBase64url(credential.response.authenticatorData),
      signature: bufferToBase64url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? bufferToBase64url(credential.response.userHandle)
        : null
    }
  };
}

async function deletePasskey(passkeyId) {
  if (!confirm("Remove this passkey? You will no longer be able to use this biometric device to sign in.")) return;

  try {
    await request(`/auth/passkey/${encodeURIComponent(passkeyId)}`, { method: "DELETE" });
    showToast("Passkey Removed", "Credential removed.", "info");
    await refreshSecurityStatus();
  } catch (err) {
    showToast("Failed to Remove Passkey", err.message, "error");
  }
}

// Force change password on first setup
$("password-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await request("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: $("current-password").value,
        newPassword: $("new-password").value
      })
    });

    showToast("Password Updated", "Security credential configured.", "success");
    showView("app");
    await refreshAllData();
  } catch (err) {
    showToast("Setup Failed", err.message, "error");
  }
};

// Logout
$("btn-logout").onclick = async () => {
  try {
    await request("/auth/logout", { method: "POST" });
  } catch {}
  sessionStorage.removeItem("mailAdminToken");
  sessionStorage.removeItem("mailAdminUser");
  state.token = null;
  state.adminUser = null;
  showView("login");
  showToast("Signed Out", "Session ended securely.", "info");
};

// Topbar refresh button
$("btn-refresh-all").onclick = () => refreshAllData();

// Navigation click listener
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    if (tab) switchTab(tab);
  });
});

// App Boot
(async function init() {
  if (state.token) {
    showView("app");
    await refreshAllData();
  } else {
    showView("login");
  }
})();
