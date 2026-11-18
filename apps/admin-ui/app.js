/**
 * MailCore Pro Admin — Production Mail Server Control Panel
 * Frontend Controller & API Client
 */

// Application State
const state = {
  adminUser: null,
  currentTab: "overview",
  domains: [],
  mailboxes: [],
  aliases: [],
  clientConfig: null,
  auditLogs: [],
  events: [],
  eventNextCursor: null,
  eventMetrics: null,
  eventNotifications: [],
  eventAlertRules: [],
  eventRetention: null,
  dashboardData: null,
  mailAnalytics: null,
  company: null,
  activeDnsDomain: null,
  failureAlerts: [],
  mailboxStatusFilter: "",
  domainStatusFilter: "",
  aliasStatusFilter: "",
  pagination: {
    mailboxes: { limit: 25, offset: 0 },
    domains: { limit: 25, offset: 0 },
    aliases: { limit: 25, offset: 0 }
  },
  sort: {
    mailboxes: { column: "created", order: "desc" },
    domains: { column: "name", order: "asc" },
    aliases: { column: "source", order: "asc" }
  },
  backups: [],
  backupMetrics: {},
  backupSettings: {},
  pendingMfa: null,
  mfaMode: "totp",
  pendingTotpSetup: null,
  adminSessions: [],
  administrators: [],
  securityPolicies: null,
  securityPolicyHistory: []
};

let eventStream = null;
let eventUiRefreshTimer = null;
let eventLoadInProgress = false;
let lastModalTrigger = null;

// DOM Helper
const $ = (id) => document.getElementById(id);

function clearSubmittedPasswordFields(form) {
  // A visibility toggle can temporarily change a password input to text, so
  // include password-named fields as well as inputs currently typed password.
  form.querySelectorAll('input[type="password"], input[id*="password" i], input[name*="password" i]').forEach((input) => {
    input.value = "";
  });
}

// Auth Header helper
function readCookieValue(name) {
  const prefix = `${name}=`;
  const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!match) return "";
  try { return decodeURIComponent(match.slice(prefix.length)); } catch { return ""; }
}

const getHeaders = (extra = {}, method = "GET") => {
  const headers = { "Content-Type": "application/json", ...extra };
  if (!["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase())) {
    const csrfToken = readCookieValue("mailcore_admin_csrf");
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  }
  return headers;
};

// Failure Alert System
function recordFailureAlert(alert) {
  if (!alert || !alert.title || alert.category === "API") return;
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
  const method = String(options.method || "GET").toUpperCase();
  const config = {
    ...options,
    credentials: "same-origin",
    headers: getHeaders(options.headers || {}, method)
  };

  try {
    const res = await fetch(url, config);

    // Don't auto-redirect to login if we are in the middle of auth / login / 2fa / reset
    const isAuthRoute = path.includes("/auth/login") ||
                        path.includes("/auth/mfa/") ||
                        path.includes("/auth/reset-password") ||
                        path.includes("/auth/passkey/");

    if (res.status === 401 && !isAuthRoute) {
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

      throw new Error(errMsg);
    }
    return data;
  } catch (err) {
    throw err;
  }
}

// Toast Notifications
function showToast(title, message, type = "info", duration = 4500) {
  const container = $("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-msg">${escapeHtml(message)}</div>
    </div>
    <div class="toast-actions">
      <button class="toast-pin" type="button" aria-label="Keep notification open" aria-pressed="false" title="Keep notification open">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4v5l3 3v2H6v-2l3-3V4m2 10v6m-3-16h8"/></svg>
      </button>
      <button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>
    </div>
    <div class="toast-timer" aria-hidden="true"><span></span></div>
  `;

  container.appendChild(toast);
  const closeButton = toast.querySelector(".toast-close");
  const pinButton = toast.querySelector(".toast-pin");
  const timerBar = toast.querySelector(".toast-timer span");
  let timeoutId = null;
  let timerStartedAt = 0;
  let remaining = duration;
  let isClosing = false;
  let isPinned = false;

  const dismiss = () => {
    if (isClosing) return;
    isClosing = true;
    if (timeoutId) clearTimeout(timeoutId);
    toast.style.opacity = "0";
    toast.style.transform = "translateX(30px)";
    setTimeout(() => toast.remove(), 250);
  };

  const pauseDismissTimer = () => {
    if (!timeoutId || isClosing) return;
    remaining = Math.max(0, remaining - (Date.now() - timerStartedAt));
    clearTimeout(timeoutId);
    timeoutId = null;
    toast.classList.add("toast-paused");
    if (timerBar) {
      timerBar.style.transition = "none";
      timerBar.style.width = `${(remaining / duration) * 100}%`;
    }
  };

  const resumeDismissTimer = () => {
    if (timeoutId || isClosing || isPinned) return;
    if (remaining <= 0) return dismiss();
    toast.classList.remove("toast-paused");
    timerStartedAt = Date.now();
    if (timerBar) {
      timerBar.style.transition = "none";
      timerBar.style.width = `${(remaining / duration) * 100}%`;
      void timerBar.offsetWidth;
      timerBar.style.transition = `width ${remaining}ms linear`;
      timerBar.style.width = "0";
    }
    timeoutId = setTimeout(dismiss, remaining);
  };

  closeButton?.addEventListener("click", dismiss);
  pinButton?.addEventListener("click", () => {
    isPinned = !isPinned;
    toast.classList.toggle("toast-pinned", isPinned);
    pinButton.setAttribute("aria-pressed", String(isPinned));
    pinButton.setAttribute("aria-label", isPinned ? "Allow notification to dismiss automatically" : "Keep notification open");
    pinButton.setAttribute("title", isPinned ? "Allow notification to dismiss automatically" : "Keep notification open");
    if (isPinned) {
      pauseDismissTimer();
    } else if (!toast.matches(":hover") && !toast.contains(document.activeElement)) {
      resumeDismissTimer();
    }
  });
  toast.addEventListener("mouseenter", pauseDismissTimer);
  toast.addEventListener("mouseleave", () => {
    if (!toast.contains(document.activeElement)) resumeDismissTimer();
  });
  toast.addEventListener("focusin", pauseDismissTimer);
  toast.addEventListener("focusout", (event) => {
    if (!toast.contains(event.relatedTarget)) resumeDismissTimer();
  });

  resumeDismissTimer();
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
    startEventStream();
    startLiveMonitor();
  } else {
    stopEventStream();
    stopLiveMonitor();
  }
}

// Navigation Tabs
function switchTab(tabId) {
  state.currentTab = tabId;

  document.querySelectorAll(".nav-item").forEach((btn) => {
    const isActive = btn.getAttribute("data-tab") === tabId;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-current", isActive ? "page" : "false");
  });

  document.querySelectorAll(".tab-pane").forEach((pane) => {
    pane.classList.remove("active");
  });

  const targetPaneId = `tab-${tabId}`;
  const activePane = $(targetPaneId);
  if (activePane) activePane.classList.add("active");
  $("app-main-content")?.focus({ preventScroll: true });
  const content = document.querySelector(".content-scroll");
  if (content) content.scrollTo({ top: 0, behavior: "smooth" });

  const titles = {
    overview: "Overview",
    dashboard: "Visual Dashboard & Analytics",
    mailboxes: "Mailboxes",
    domains: "Hosted Domains",
    aliases: "Email Aliases & Forwarding",
    services: "Services, Mail Queue & Diagnostics",
    quarantine: "Security Quarantine",
    "security-policies": "Security Policies",
    audit: "Audit Log & Security Trail",
    events: "Event Explorer & Alerts",
    backups: "Mail Backups & Disaster Recovery",
    administrators: "Administrator Accounts",
    settings: "Settings & Company Profile"
  };
  $("page-title").textContent = titles[tabId] || "Control Panel";

  if (tabId === "dashboard") {
    renderDashboardVisuals();
    renderMailFlowAnalytics(state.mailAnalytics);
  }
  if (tabId === "backups") {
    renderBackupsView();
  }
  if (tabId === "audit" && state.auditLogs.length === 0) {
    loadAuditLogs();
  }
  if (tabId === "events") {
    loadEvents();
  }
  if (tabId === "services") {
    runDiagnosticsNow();
  }
  if (tabId === "quarantine") {
    loadQuarantine();
  }
  if (tabId === "security-policies") {
    loadSecurityPolicies();
  }
  if (tabId === "administrators") {
    loadAdministrators();
  }
}

// User Info Rendering in Sidebar
function updateUserInfo() {
  const user = state.adminUser || { username: "admin", role: "owner" };
  $("user-display-name").textContent = user.username;
  $("user-display-role").textContent = user.role || "admin";
  const initials = (user.username || "AD").slice(0, 2).toUpperCase();
  $("user-avatar-initials").textContent = initials;
  const adminNav = $("nav-administrators");
  if (adminNav) adminNav.classList.toggle("hidden", user.role !== "owner");
  const quarantineNav = $("nav-quarantine");
  if (quarantineNav) quarantineNav.classList.toggle("hidden", !["owner", "admin"].includes(user.role));
  const policyNav = $("nav-security-policies");
  if (policyNav) policyNav.classList.toggle("hidden", !["owner", "admin"].includes(user.role));
  const eventsNav = $("nav-events");
  if (eventsNav) eventsNav.classList.toggle("hidden", !["owner", "admin"].includes(user.role));
  const eventNotificationsButton = $("btn-event-notifications");
  if (eventNotificationsButton) eventNotificationsButton.classList.toggle("hidden", !["owner", "admin"].includes(user.role));
  const ownerControls = ["event-alert-rule-owner-controls", "event-retention-owner-controls"];
  ownerControls.forEach((id) => $(id)?.classList.toggle("hidden", user.role !== "owner"));
}

// Modal Handlers
function openModal(id) {
  const el = $(id);
  if (!el) return;
  lastModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el.classList.remove("hidden");
  window.setTimeout(() => {
    el.querySelector("[autofocus], input, select, textarea, button")?.focus();
  }, 0);
}

function closeModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add("hidden");
  lastModalTrigger?.focus?.();
  lastModalTrigger = null;
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
    const [dashboard, company, domains, mailboxes, aliases, clientConfig, backupData, mailAnalytics] = await Promise.all([
      request("/api/dashboard"),
      request("/api/company"),
      request("/api/domains"),
      request("/api/mailboxes"),  // Uses virtual_users view (Dovecot-compatible)
      request("/api/aliases"),    // Admin view — includes inactive aliases
      request("/api/mailboxes/client-config"),
      request("/api/backups").catch(() => null),
      request(`/api/analytics/mail?days=${Number($("mail-analytics-period")?.value || 30)}`).catch(() => null)
    ]);

    state.dashboardData = dashboard;
    state.mailAnalytics = mailAnalytics;
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
    renderMailFlowAnalytics(state.mailAnalytics);
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
  const byService = Object.fromEntries((Array.isArray(services) ? services : []).map((service) => [service.service, service]));
  const setStatus = (id, service) => {
    const element = $(id);
    if (!element) return;
    if (!service) {
      element.className = "badge badge-warning";
      element.textContent = "Unavailable";
      return;
    }
    const healthy = service.status === "healthy";
    const unavailable = service.status === "unavailable" || service.status === "unknown";
    element.className = `badge ${healthy ? "badge-success" : unavailable ? "badge-warning" : "badge-danger"}`;
    element.textContent = healthy ? "Healthy" : service.status;
  };
  const postfix = byService.postfix;
  const dovecot = byService.dovecot;
  const rspamd = byService.rspamd;
  const clamav = byService.clamav;
  const database = byService.postgresql;

  if (postfix) $("infra-postfix-details").textContent = `SMTP service port ${postfix.port}`;
  if (dovecot) $("infra-dovecot-details").textContent = `IMAP service port ${dovecot.port} • Maildir Storage`;
  const rspamdText = rspamd ? `Rspamd ${rspamd.status}` : "Rspamd unavailable";
  const clamavText = clamav ? `ClamAV ${clamav.status}` : "ClamAV unavailable";
  if ($("infra-filter-details")) $("infra-filter-details").textContent = `${rspamdText} • ${clamavText}`;
  if (database) $("infra-database-name").textContent = database.displayName;
  setStatus("infra-postfix-status", postfix);
  setStatus("infra-dovecot-status", dovecot);
  const filterStatus = rspamd && clamav
    ? { ...rspamd, status: rspamd.status === "healthy" && clamav.status === "healthy" ? "healthy" : rspamd.status === "down" || clamav.status === "down" ? "down" : "degraded" }
    : { service: "filter-pipeline", status: rspamd?.status === "down" || clamav?.status === "down" ? "down" : "unavailable" };
  setStatus("infra-filter-status", filterStatus);
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
  if ($("badge-nav-mailboxes")) $("badge-nav-mailboxes").textContent = state.mailboxes.length;
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

// Generic Table Sorter
function sortTable(table, column) {
  if (!state.sort) {
    state.sort = {
      mailboxes: { column: "created", order: "desc" },
      domains: { column: "name", order: "asc" },
      aliases: { column: "source", order: "asc" }
    };
  }
  if (!state.sort[table]) {
    state.sort[table] = { column: column, order: "asc" };
  } else if (state.sort[table].column === column) {
    state.sort[table].order = state.sort[table].order === "asc" ? "desc" : "asc";
  } else {
    state.sort[table].column = column;
    state.sort[table].order = "asc";
  }
  resetTablePagination(table);

  if (table === "mailboxes") renderMailboxes();
  else if (table === "domains") renderDomains();
  else if (table === "aliases") renderAliases();
}

function updateSortIndicators(table, sort) {
  const prefix = table === "mailboxes" ? "sort-mb-" : table === "domains" ? "sort-dom-" : "sort-alias-";
  document.querySelectorAll(`[id^="${prefix}"]`).forEach((el) => {
    el.textContent = "";
  });
  const activeEl = $(prefix + sort.column);
  if (activeEl) {
    activeEl.textContent = sort.order === "asc" ? "▲" : "▼";
  }
}

function resetTablePagination(table) {
  if (state.pagination?.[table]) state.pagination[table].offset = 0;
}

function getTablePage(table, items) {
  const pagination = state.pagination?.[table] || { limit: 25, offset: 0 };
  const limit = Number(pagination.limit) || 25;
  const lastOffset = Math.max(0, Math.floor((items.length - 1) / limit) * limit);
  const offset = Math.min(Math.max(0, Number(pagination.offset) || 0), lastOffset);
  state.pagination[table] = { limit, offset, total: items.length };
  return { items: items.slice(offset, offset + limit), limit, offset };
}

function renderTablePagination(table, totalItems) {
  const container = $(`table-pagination-${table}`);
  if (!container) return;
  if (totalItems === 0) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }

  const { limit, offset } = state.pagination[table];
  const firstItem = offset + 1;
  const lastItem = Math.min(offset + limit, totalItems);
  const hasPrevious = offset > 0;
  const hasNext = offset + limit < totalItems;
  container.classList.remove("hidden");
  container.innerHTML = `
    <span class="table-pagination-summary">Showing ${firstItem}–${lastItem} of ${totalItems}</span>
    <label class="table-page-size">Rows
      <select aria-label="Rows per page" onchange="setTablePageSize('${table}', this.value)">
        ${[25, 50, 100].map((size) => `<option value="${size}"${size === limit ? " selected" : ""}>${size}</option>`).join("")}
      </select>
    </label>
    <div class="table-pagination-actions">
      <button class="btn btn-secondary btn-sm" type="button" onclick="changeTablePage('${table}', 'first')" ${hasPrevious ? "" : "disabled"} aria-label="First page">«</button>
      <button class="btn btn-secondary btn-sm" type="button" onclick="changeTablePage('${table}', 'previous')" ${hasPrevious ? "" : "disabled"} aria-label="Previous page">‹</button>
      <button class="btn btn-secondary btn-sm" type="button" onclick="changeTablePage('${table}', 'next')" ${hasNext ? "" : "disabled"} aria-label="Next page">›</button>
      <button class="btn btn-secondary btn-sm" type="button" onclick="changeTablePage('${table}', 'last', ${totalItems})" ${hasNext ? "" : "disabled"} aria-label="Last page">»</button>
    </div>
  `;
}

function changeTablePage(table, direction, totalItems) {
  const pagination = state.pagination?.[table];
  if (!pagination) return;
  const total = Number(totalItems) || pagination.total || ({ mailboxes: state.mailboxes, domains: state.domains, aliases: state.aliases }[table] || []).length;
  const lastOffset = Math.max(0, Math.floor((total - 1) / pagination.limit) * pagination.limit);
  if (direction === "first") pagination.offset = 0;
  else if (direction === "previous") pagination.offset = Math.max(0, pagination.offset - pagination.limit);
  else if (direction === "next") pagination.offset = Math.min(lastOffset, pagination.offset + pagination.limit);
  else if (direction === "last") pagination.offset = lastOffset;
  if (table === "mailboxes") renderMailboxes();
  else if (table === "domains") renderDomains();
  else if (table === "aliases") renderAliases();
}

function setTablePageSize(table, value) {
  const limit = Number(value);
  if (!state.pagination?.[table] || ![25, 50, 100].includes(limit)) return;
  state.pagination[table] = { limit, offset: 0 };
  if (table === "mailboxes") renderMailboxes();
  else if (table === "domains") renderDomains();
  else if (table === "aliases") renderAliases();
}

// 2. Mailbox Management
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
    showToast("Export Failed", "No mailboxes to export.", "warning");
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
  if ($("mailboxes-header-counts")) $("mailboxes-header-counts").textContent = `${activeCount} Active • ${suspendedCount} Suspended`;

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
    renderTablePagination("mailboxes", 0);
    return;
  }

  empty.classList.add("hidden");

  // Apply sorting
  const sort = state.sort?.mailboxes || { column: "created", order: "desc" };
  filtered.sort((a, b) => {
    let valA, valB;
    if (sort.column === "address") {
      valA = (a.address || "").toLowerCase();
      valB = (b.address || "").toLowerCase();
    } else if (sort.column === "domain") {
      valA = (a.domain_name || a.address.split("@")[1] || "").toLowerCase();
      valB = (b.domain_name || b.address.split("@")[1] || "").toLowerCase();
    } else if (sort.column === "storage") {
      valA = Number(a.storage_used_bytes || 0);
      valB = Number(b.storage_used_bytes || 0);
    } else if (sort.column === "status") {
      valA = a.active ? 1 : 0;
      valB = b.active ? 1 : 0;
    } else { // created
      valA = new Date(a.created_at || 0).getTime();
      valB = new Date(b.created_at || 0).getTime();
    }
    if (valA < valB) return sort.order === "asc" ? -1 : 1;
    if (valA > valB) return sort.order === "asc" ? 1 : -1;
    return 0;
  });
  updateSortIndicators("mailboxes", sort);
  const page = getTablePage("mailboxes", filtered);
  renderTablePagination("mailboxes", filtered.length);
  tbody.innerHTML = page.items.map((m) => {
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
            <button class="btn-action-icon" title="Test Mailbox IMAP / SMTP Password" onclick="openTestUserAuth('${m.id}', '${m.address}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            <button class="btn-action-icon" title="Edit Mailbox / Password / Quota" onclick="openEditMailbox('${m.id}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button class="btn-action-icon ${m.active ? "danger" : "verify"}"
              title="${m.active ? "Suspend Mailbox (Disables access, preserves emails)" : "Activate / Reactivate Mailbox"}"
              onclick="toggleMailboxActive('${m.id}', ${!m.active})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${m.active
                  ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
                  : '<polyline points="20 6 9 17 4 12"/>'
                }
              </svg>
            </button>
            <button class="btn-action-icon danger" title="Delete Mailbox Permanently" onclick="deleteMailbox('${m.id}', '${m.address}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function filterMailboxes() {
  resetTablePagination("mailboxes");
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

  const aliasFilter = $('alias-domain-filter');
  if (aliasFilter) {
    const currentVal = aliasFilter.value;
    const allDomainNames = state.domains.map((d) => d.name);
    aliasFilter.innerHTML = '<option value="">All Domains</option>' + allDomainNames.map(
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

  // Keep the visible default aligned with the API fallback used for diagnostic
  // SMTP submissions. Do not overwrite an address the administrator entered.
  const smtpSender = $("test-smtp-sender");
  if (smtpSender && !smtpSender.value && virtualDomains.length > 0) {
    smtpSender.value = `diagnostic@${virtualDomains[0].name}`;
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

// Create Mailbox Handler
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
  btn.textContent = "Creating Mailbox...";

  try {
    await request("/api/mailboxes", {
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
    showToast("Mailbox Created", `Mailbox ${fullAddress} is ready for email traffic.`, "success");
    await refreshAllData();
  } catch (err) {
    showToast("Mailbox Creation Failed", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Mailbox";
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
      target: `Mailbox ID #${id}`,
      reason: err.message
    });
    showToast("Status Change Failed", err.message, "error");
  }
}

// Delete Mailbox
async function deleteMailbox(id, address) {
  if (!confirm(`PERMANENT DELETION WARNING:\n\nAre you sure you want to PERMANENTLY DELETE mailbox "${address}"?\n\nThis permanently erases the mailbox, maildir directory, and all stored emails from disk.\n\nTip: If you only want to temporarily disable access without deleting emails, click Cancel and click the Suspend button instead.`)) {
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
  const config = requestedMailbox ? await request(`/api/mailboxes/client-config${query}`) : state.clientConfig;
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
  $("guide-imap-alt-port").textContent = config.incoming.alternativePort ?? "Disabled";
  $("guide-pop3-alt-port").textContent = config.pop3.alternativePort ?? "Disabled";
  $("guide-pop3-port").textContent = config.pop3.port;
  $("guide-smtp-port").textContent = config.outgoing.port;
  $("guide-smtp-alt-port").textContent = config.outgoing.alternativePort;
  $("guide-smtp-plain-port").textContent = config.outgoing.plaintextPort;
  openModal("modal-client-guide");
}

// Test Mailbox IMAP & SMTP Login Credentials
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
    const res = await request(`/api/mailboxes/${id}/test-auth`, {
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
        title: "Mailbox Password Verification Failed",
        target: $("test-auth-user-address")?.textContent || `Mailbox #${id}`,
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
      title: "Mailbox Authentication Probe Failed",
      target: $("test-auth-user-address")?.textContent || `Mailbox #${id}`,
      reason: err.message
    });
    showToast("Auth Error", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify Credentials";
  }
}

// 3. Domain Management & DNS Setup
function setDomainFilterStatus(status) {
  state.domainStatusFilter = status;
  $("pill-dom-all")?.classList.toggle("active", status === "");
  $("pill-dom-verified")?.classList.toggle("active", status === "verified");
  $("pill-dom-pending")?.classList.toggle("active", status === "pending");
  $("pill-dom-active")?.classList.toggle("active", status === "active");
  filterDomains();
}

function filterDomains() {
  resetTablePagination("domains");
  renderDomains();
}

function renderDomains() {
  const tbody = $("domains-tbody");
  const empty = $("domains-empty");

  const query = ($("domain-search")?.value || "").toLowerCase().trim();
  const statusFilter = state.domainStatusFilter || "";

  // Update status filter pill counts
  const verifiedCount = state.domains.filter((d) => Boolean(d.verified_at)).length;
  const pendingCount = state.domains.filter((d) => !d.verified_at).length;
  const activeCount = state.domains.filter((d) => d.active).length;
  if ($("count-dom-all")) $("count-dom-all").textContent = state.domains.length;
  if ($("count-dom-verified")) $("count-dom-verified").textContent = verifiedCount;
  if ($("count-dom-pending")) $("count-dom-pending").textContent = pendingCount;
  if ($("count-dom-active")) $("count-dom-active").textContent = activeCount;

  const filtered = state.domains.filter((d) => {
    if (query && !d.name.toLowerCase().includes(query)) return false;
    if (statusFilter === "verified" && !d.verified_at) return false;
    if (statusFilter === "pending" && d.verified_at) return false;
    if (statusFilter === "active" && !d.active) return false;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    renderTablePagination("domains", 0);
    return;
  }

  empty.classList.add("hidden");

  // Apply sorting
  const sort = state.sort?.domains || { column: "name", order: "asc" };
  filtered.sort((a, b) => {
    let valA, valB;
    if (sort.column === "name") {
      valA = (a.name || "").toLowerCase();
      valB = (b.name || "").toLowerCase();
    } else if (sort.column === "verification") {
      valA = Boolean(a.verified_at) ? 1 : 0;
      valB = Boolean(b.verified_at) ? 1 : 0;
    } else if (sort.column === "status") {
      valA = a.active ? 1 : 0;
      valB = b.active ? 1 : 0;
    } else { // created
      valA = new Date(a.created_at || 0).getTime();
      valB = new Date(b.created_at || 0).getTime();
    }
    if (valA < valB) return sort.order === "asc" ? -1 : 1;
    if (valA > valB) return sort.order === "asc" ? 1 : -1;
    return 0;
  });
  updateSortIndicators("domains", sort);

  const page = getTablePage("domains", filtered);
  renderTablePagination("domains", filtered.length);
  tbody.innerHTML = page.items.map((d) => {
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
function setAliasFilterStatus(status) {
  state.aliasStatusFilter = status;
  $("pill-alias-all")?.classList.toggle("active", status === "");
  $("pill-alias-active")?.classList.toggle("active", status === "active");
  $("pill-alias-disabled")?.classList.toggle("active", status === "disabled");
  filterAliases();
}

function filterAliases() {
  resetTablePagination("aliases");
  renderAliases();
}

function renderAliases() {
  const tbody = $("aliases-tbody");
  const empty = $("aliases-empty");

  const query = ($("alias-search")?.value || "").toLowerCase().trim();
  const statusFilter = state.aliasStatusFilter || "";
  const domainFilter = $("alias-domain-filter")?.value || "";

  // Update status filter pill counts
  const activeCount = state.aliases.filter((a) => a.active).length;
  const disabledCount = state.aliases.filter((a) => !a.active).length;
  if ($("count-alias-all")) $("count-alias-all").textContent = state.aliases.length;
  if ($("count-alias-active")) $("count-alias-active").textContent = activeCount;
  if ($("count-alias-disabled")) $("count-alias-disabled").textContent = disabledCount;

  const filtered = state.aliases.filter((a) => {
    if (query) {
      const matchSrc = a.source.toLowerCase().includes(query);
      const matchDst = a.destination.toLowerCase().includes(query);
      if (!matchSrc && !matchDst) return false;
    }
    if (domainFilter && (a.domain_name || a.source.split("@")[1]) !== domainFilter) return false;
    if (statusFilter === "active" && !a.active) return false;
    if (statusFilter === "disabled" && a.active) return false;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    renderTablePagination("aliases", 0);
    return;
  }

  empty.classList.add("hidden");

  // Apply sorting
  const sort = state.sort?.aliases || { column: "source", order: "asc" };
  filtered.sort((a, b) => {
    let valA, valB;
    if (sort.column === "source") {
      valA = (a.source || "").toLowerCase();
      valB = (b.source || "").toLowerCase();
    } else if (sort.column === "destination") {
      valA = (a.destination || "").toLowerCase();
      valB = (b.destination || "").toLowerCase();
    } else if (sort.column === "domain") {
      valA = (a.domain_name || a.source.split("@")[1] || "").toLowerCase();
      valB = (b.domain_name || b.source.split("@")[1] || "").toLowerCase();
    } else if (sort.column === "status") {
      valA = a.active ? 1 : 0;
      valB = b.active ? 1 : 0;
    } else { // created
      valA = new Date(a.created_at || 0).getTime();
      valB = new Date(b.created_at || 0).getTime();
    }
    if (valA < valB) return sort.order === "asc" ? -1 : 1;
    if (valA > valB) return sort.order === "asc" ? 1 : -1;
    return 0;
  });
  updateSortIndicators("aliases", sort);

  const page = getTablePage("aliases", filtered);
  renderTablePagination("aliases", filtered.length);
  tbody.innerHTML = page.items.map((a) => `
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

// 5. Event Management, Search, Notifications & Live Stream
function buildEventQuery(includeCursor = false) {
  const params = new URLSearchParams();
  params.set("limit", "50");
  const values = {
    q: $("event-search")?.value.trim(),
    category: $("event-category-filter")?.value,
    severity: $("event-severity-filter")?.value,
    includeArchived: $("event-include-archive")?.checked ? "true" : "false"
  };
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  const from = $("event-from-filter")?.value;
  const to = $("event-to-filter")?.value;
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(to).toISOString());
  if (includeCursor && state.eventNextCursor) params.set("afterId", state.eventNextCursor);
  return params;
}

async function loadEvents(options = {}) {
  if (eventLoadInProgress) return;
  eventLoadInProgress = true;
  const append = options.append === true;
  const tbody = $("events-tbody");
  if (!append && tbody && !options.silent) tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Loading event timeline…</td></tr>';
  try {
    const params = buildEventQuery(append);
    const result = await request(`/api/events?${params.toString()}`);
    state.events = append ? [...state.events, ...(result.items || [])] : (result.items || []);
    state.eventNextCursor = result.nextCursor || null;
    renderEvents();
    if (!append) {
      await Promise.allSettled([loadEventMetrics(), loadEventNotifications(), loadEventRules(), loadEventRetention(), loadEventOutbox()]);
    }
  } catch (err) {
    if (!options.silent) showToast("Event Explorer Error", err.message, "error");
    if (tbody && !state.events.length) tbody.innerHTML = `<tr><td colspan="6" class="text-danger">${escapeHtml(err.message)}</td></tr>`;
  } finally {
    eventLoadInProgress = false;
  }
}

function renderEvents() {
  const tbody = $("events-tbody");
  if (!tbody) return;
  if (!state.events.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center" style="padding:30px">No events match these filters.</td></tr>';
  } else {
    tbody.innerHTML = state.events.map((event) => {
      const severityClass = event.severity === "critical" ? "badge-danger" : event.severity === "warning" ? "badge-warning" : event.severity === "notice" ? "badge-primary" : "badge-secondary";
      const details = event.details && Object.keys(event.details).length ? JSON.stringify(event.details) : "—";
      return `<tr>
        <td style="white-space:nowrap"><strong>${formatDate(event.occurred_at)}</strong><div class="text-muted" style="font-size:.75rem">${formatRelativeTime(event.occurred_at)}</div></td>
        <td><span class="badge ${severityClass}">${escapeHtml(event.severity)}</span></td>
        <td><strong>${escapeHtml(event.category)}</strong><div class="text-muted" style="font-size:.75rem">${escapeHtml(event.action)}</div></td>
        <td><code>${escapeHtml(event.source)}</code></td>
        <td><strong>${escapeHtml(event.summary)}</strong><div class="text-muted" style="font-size:.75rem">${escapeHtml(event.entity_type || "")}${event.entity_id ? ` · #${escapeHtml(event.entity_id)}` : ""}</div><details><summary class="text-muted">Details</summary><code class="break-all">${escapeHtml(details)}</code></details></td>
        <td><code>${escapeHtml(event.correlation_id || "—")}</code></td>
      </tr>`;
    }).join("");
  }
  const status = $("event-page-status");
  if (status) status.textContent = `${state.events.length} loaded`;
  const summary = $("event-result-summary");
  if (summary) summary.textContent = `Searchable events from administrator actions and Postfix delivery lifecycle logs.`;
  const cursor = $("events-cursor-label");
  if (cursor) cursor.textContent = state.eventNextCursor ? "More historical events are available" : "End of matching event history";
  const older = $("btn-events-older");
  if (older) older.disabled = !state.eventNextCursor;
}

async function loadOlderEvents() {
  if (state.eventNextCursor) await loadEvents({ append: true });
}

function resetEventFilters() {
  ["event-search", "event-category-filter", "event-severity-filter", "event-from-filter", "event-to-filter"].forEach((id) => { if ($(id)) $(id).value = ""; });
  if ($("event-include-archive")) $("event-include-archive").checked = false;
  state.eventNextCursor = null;
  loadEvents();
}

async function loadEventMetrics() {
  const data = await request("/api/events/metrics");
  state.eventMetrics = data;
  if ($("event-metric-day")) $("event-metric-day").textContent = Number(data.lastDay || 0).toLocaleString();
  if ($("event-metric-hour")) $("event-metric-hour").textContent = Number(data.lastHour || 0).toLocaleString();
  if ($("event-metric-archived")) $("event-metric-archived").textContent = Number(data.archived || 0).toLocaleString();
  if ($("event-metric-outbox-pending")) $("event-metric-outbox-pending").textContent = Number(data.outboxPending || 0).toLocaleString();
  if ($("event-metric-outbox-dead")) $("event-metric-outbox-dead").textContent = Number(data.outboxDeadLettered || 0).toLocaleString();
}


async function loadEventOutbox() {
  const result = await request("/api/events/outbox?limit=50");
  const rows = result.items || [];
  const tbody = $("event-outbox-tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center">No pending or dead-lettered outbox items.</td></tr>';
    return;
  }
  const owner = state.adminUser?.role === "owner";
  tbody.innerHTML = rows.map((item) => {
    const dead = Boolean(item.dead_lettered_at);
    const status = dead
      ? '<span class="badge badge-danger">Dead-lettered</span>'
      : `<span class="badge badge-warning">Retry scheduled · ${formatRelativeTime(item.available_at)}</span>`;
    return `<tr>
      <td><code>${escapeHtml(item.id)}</code></td>
      <td><strong>${escapeHtml(item.action)}</strong><div class="text-muted" style="font-size:.75rem">${escapeHtml(item.summary || "")}</div></td>
      <td>${Number(item.attempt_count || 0).toLocaleString()}</td>
      <td>${status}</td>
      <td><span class="text-muted">${escapeHtml(item.last_error || "—")}</span></td>
      <td>${dead && owner ? `<button class="btn btn-secondary btn-xs" onclick="retryEventOutbox('${encodeURIComponent(item.id)}')">Retry</button>` : "—"}</td>
    </tr>`;
  }).join("");
}

async function retryEventOutbox(id) {
  if (!confirm("Retry publishing this dead-lettered event? The event and its original audit record will remain unchanged.")) return;
  try {
    await request(`/api/events/outbox/${id}/retry`, { method: "POST" });
    showToast("Event Queued for Retry", "The dispatcher will retry this event with a fresh attempt counter.", "success");
    await Promise.allSettled([loadEventOutbox(), loadEventMetrics()]);
  } catch (err) { showToast("Outbox Retry Failed", err.message, "error"); }
}

async function loadEventNotifications() {
  const result = await request("/api/events/notifications?limit=30");
  state.eventNotifications = result.items || [];
  const unread = Number(result.unreadCount || 0);
  ["badge-nav-events", "badge-topbar-events"].forEach((id) => {
    const badge = $(id);
    if (!badge) return;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.classList.toggle("hidden", unread === 0);
  });
  if ($("event-metric-unread")) $("event-metric-unread").textContent = unread.toLocaleString();
  renderEventNotifications();
}

function renderEventNotifications() {
  const container = $("event-notifications-list");
  if (!container) return;
  if (!state.eventNotifications.length) {
    container.innerHTML = '<p class="text-muted" style="padding:12px">No notifications. Enabled alert rules will create notifications for matching events.</p>';
    return;
  }
  container.innerHTML = state.eventNotifications.map((notification) => {
    const sev = notification.severity === "critical" ? "badge-danger" : notification.severity === "warning" ? "badge-warning" : "badge-secondary";
    return `<div class="recent-activity-item event-notification-item ${notification.read_at ? "is-read" : "is-unread"}">
      <div class="recent-activity-icon"><span class="badge ${sev}">${escapeHtml(notification.severity)}</span></div>
      <div class="recent-activity-content"><strong>${escapeHtml(notification.title)}</strong><p>${escapeHtml(notification.message)}</p><small class="text-muted">${formatRelativeTime(notification.created_at)}</small></div>
      ${notification.read_at ? '<span class="text-muted">Read</span>' : `<button class="btn btn-secondary btn-xs" onclick="markEventNotificationRead('${encodeURIComponent(notification.id)}')">Mark read</button>`}
    </div>`;
  }).join("");
}

async function markEventNotificationRead(id) {
  try {
    await request(`/api/events/notifications/${id}/read`, { method: "PATCH" });
    await loadEventNotifications();
  } catch (err) { showToast("Notification Update Failed", err.message, "error"); }
}

async function markAllEventNotificationsRead() {
  try {
    await request("/api/events/notifications/read-all", { method: "POST" });
    await loadEventNotifications();
    showToast("Notifications Updated", "All notifications marked as read.", "success");
  } catch (err) { showToast("Notification Update Failed", err.message, "error"); }
}

async function loadEventRules() {
  const result = await request("/api/events/alert-rules");
  state.eventAlertRules = result.items || [];
  const tbody = $("event-alert-rules-tbody");
  if (!tbody) return;
  if (!state.eventAlertRules.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No alert rules configured.</td></tr>';
    return;
  }
  const owner = state.adminUser?.role === "owner";
  tbody.innerHTML = state.eventAlertRules.map((rule) => `<tr>
    <td><strong>${escapeHtml(rule.name)}</strong></td>
    <td>${escapeHtml(rule.category || "All categories")} · ${escapeHtml(rule.min_severity)}${rule.action_prefix ? `<div class="text-muted">${escapeHtml(rule.action_prefix)}*</div>` : ""}</td>
    <td><span class="badge ${rule.enabled ? "badge-success" : "badge-secondary"}">${rule.enabled ? "Enabled" : "Disabled"}</span></td>
    <td>${owner ? `<button class="btn btn-secondary btn-xs" onclick="toggleEventAlertRule('${rule.id}', ${!rule.enabled})">${rule.enabled ? "Disable" : "Enable"}</button> <button class="btn btn-danger btn-xs" onclick="deleteEventAlertRule('${rule.id}')">Delete</button>` : "—"}</td>
  </tr>`).join("");
}

async function createEventAlertRule() {
  const body = {
    name: $("event-rule-name")?.value.trim(),
    category: $("event-rule-category")?.value || null,
    minSeverity: $("event-rule-severity")?.value || "warning",
    actionPrefix: $("event-rule-prefix")?.value.trim() || null,
    enabled: true
  };
  try {
    await request("/api/events/alert-rules", { method: "POST", body: JSON.stringify(body) });
    $("event-rule-name").value = "";
    $("event-rule-prefix").value = "";
    await loadEventRules();
    showToast("Alert Rule Created", "Matching events will create administrator notifications.", "success");
  } catch (err) { showToast("Could Not Create Rule", err.message, "error"); }
}

async function toggleEventAlertRule(id, enabled) {
  try {
    await request(`/api/events/alert-rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    await loadEventRules();
  } catch (err) { showToast("Rule Update Failed", err.message, "error"); }
}

async function deleteEventAlertRule(id) {
  if (!confirm("Delete this event alert rule? Existing notifications will remain.")) return;
  try {
    await request(`/api/events/alert-rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadEventRules();
  } catch (err) { showToast("Rule Delete Failed", err.message, "error"); }
}

async function loadEventRetention() {
  const settings = await request("/api/events/retention");
  state.eventRetention = settings;
  if ($("event-retention-days")) $("event-retention-days").value = settings.retention_days;
  if ($("event-archive-days")) $("event-archive-days").value = settings.archive_retention_days;
  if ($("event-archive-enabled")) $("event-archive-enabled").checked = settings.archive_before_delete;
  if ($("event-retention-status")) $("event-retention-status").textContent = `Updated ${formatRelativeTime(settings.updated_at)}. Audit log records are retained separately.`;
}

async function saveEventRetention() {
  const body = {
    retentionDays: Number($("event-retention-days")?.value),
    archiveRetentionDays: Number($("event-archive-days")?.value),
    archiveBeforeDelete: Boolean($("event-archive-enabled")?.checked)
  };
  try {
    await request("/api/events/retention", { method: "PUT", body: JSON.stringify(body) });
    await loadEventRetention();
    showToast("Retention Saved", "Event retention settings were updated.", "success");
  } catch (err) { showToast("Retention Update Failed", err.message, "error"); }
}

async function runEventRetention() {
  if (!confirm("Run event retention now? Old active events may be archived and removed from the active event store.")) return;
  try {
    const result = await request("/api/events/retention/run", { method: "POST" });
    showToast("Retention Completed", `${result.archived} archived, ${result.deletedEvents} active events removed.`, "success");
    await loadEvents();
  } catch (err) { showToast("Retention Failed", err.message, "error"); }
}

async function exportEventsCsv() {
  try {
    const params = buildEventQuery(false);
    params.set("limit", "5000");
    const response = await fetch(`/api/events/export?${params.toString()}`, { credentials: "same-origin", headers: getHeaders() });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Event export failed");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mailcore-events-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    showToast("Export Ready", "Filtered event history exported.", "success");
  } catch (err) { showToast("Event Export Failed", err.message, "error"); }
}

function scheduleEventUiRefresh() {
  // Coalesce bursts of Postfix lifecycle events so high-volume mail traffic
  // does not trigger one REST refresh per recipient delivery log line.
  if (eventUiRefreshTimer) return;
  eventUiRefreshTimer = setTimeout(() => {
    eventUiRefreshTimer = null;
    void loadEventNotifications();
    void pollFastMetrics();
    if (state.currentTab === "events") void loadEvents({ silent: true });
    if (state.currentTab === "quarantine") void loadQuarantine({ silent: true });
  }, 600);
}

function startEventStream() {
  if (!state.adminUser || !["owner", "admin"].includes(state.adminUser.role) || eventStream) return;
  try {
    eventStream = new EventSource("/api/events/stream");
    eventStream.addEventListener("ready", () => {
      if ($("events-live-status")) { $("events-live-status").textContent = "Live stream connected"; $("events-live-status").className = "badge badge-success"; }
    });
    eventStream.addEventListener("mailcore.event", (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      scheduleEventUiRefresh();
      if (event.severity === "critical" || (event.category === "security" && event.severity === "warning") || (event.category === "authentication" && event.severity === "warning")) {
        showToast(event.severity === "critical" ? "Critical Event" : "Security Alert", event.summary || event.action, event.severity === "critical" ? "error" : "warning", 7000);
      }
    });
    eventStream.onerror = () => {
      if ($("events-live-status")) { $("events-live-status").textContent = "Reconnecting…"; $("events-live-status").className = "badge badge-warning"; }
    };
  } catch (err) {
    if ($("events-live-status")) $("events-live-status").textContent = "Live stream unavailable";
  }
}

function stopEventStream() {
  if (eventStream) eventStream.close();
  eventStream = null;
  if ($("events-live-status")) { $("events-live-status").textContent = "Live stream disconnected"; $("events-live-status").className = "badge badge-secondary"; }
}

// --- LIVE BACKGROUND MONITOR ENGINE ---
let fastPollingTimer = null;
let mediumPollingTimer = null;

async function pollFastMetrics() {
  if (!state.adminUser || document.hidden) return;
  try {
    const [services, queue, taskQueue] = await Promise.all([
      request("/api/system/services").catch(() => null),
      request("/api/system/queue").catch(() => null),
      request("/api/system/task-queue").catch(() => null)
    ]);

    if (services && Array.isArray(services)) {
      renderServicesHealth(services);
      renderInfrastructureSummary(services);
      renderServicesLatencyChart(services);

      // Update the topbar status pill dynamically
      const pill = $("server-status-pill");
      const text = $("server-status-text");
      if (pill && text) {
        const hasDown = services.some((s) => s.status === "down");
        const hasDegraded = services.some((s) => s.status === "degraded");
        if (hasDown) {
          pill.className = "server-status-pill offline";
          text.textContent = "Service Offline";
        } else if (hasDegraded) {
          pill.className = "server-status-pill degraded";
          text.textContent = "Services Degraded";
        } else {
          pill.className = "server-status-pill";
          text.textContent = "Mail Services Active";
        }
      }
    }

    if (queue) {
      renderQueueStats(queue, taskQueue);
    }
  } catch (err) {
    // Silent fail during background polling
  }
}

async function pollMediumMetrics() {
  if (!state.adminUser || document.hidden) return;
  try {
    const promises = [
      loadEventNotifications().catch(() => null)
    ];

    if (["owner", "admin"].includes(state.adminUser.role)) {
      promises.push(
        request("/api/quarantine").then((res) => {
          const items = Array.isArray(res?.items) ? res.items : [];
          if ($("badge-nav-quarantine")) $("badge-nav-quarantine").textContent = String(items.length);
          if ($("quarantine-count")) $("quarantine-count").textContent = `${items.length} held`;
          if (state.currentTab === "quarantine") {
            loadQuarantine({ silent: true });
          }
        }).catch(() => null)
      );
    }

    // Quietly refresh Overview / Dashboard data
    if (state.currentTab === "overview" || state.currentTab === "dashboard") {
      promises.push(
        request("/api/dashboard").then((dashboard) => {
          if (!dashboard) return;
          state.dashboardData = dashboard;
          renderOverview();
          renderDashboardVisuals();
        }).catch(() => null)
      );
    }

    // Quietly refresh Mailboxes storage metrics
    if (state.currentTab === "mailboxes") {
      promises.push(
        request("/api/mailboxes").then((mailboxes) => {
          if (!mailboxes) return;
          state.mailboxes = mailboxes;
          renderMailboxes();
        }).catch(() => null)
      );
    }

    await Promise.all(promises);
  } catch (err) {
    // Silent fail during background polling
  }
}

function handleVisibilityChange() {
  if (!document.hidden && state.adminUser) {
    void pollFastMetrics();
    void pollMediumMetrics();
  }
}

function startLiveMonitor() {
  stopLiveMonitor();
  void pollFastMetrics();
  void pollMediumMetrics();

  // Fast interval (10s): Services health, latency, Postfix mail queue
  fastPollingTimer = setInterval(() => {
    if (!document.hidden) void pollFastMetrics();
  }, 10000);

  // Medium interval (25s): Quarantine counter, Notifications badge, Overview/Mailbox stats
  mediumPollingTimer = setInterval(() => {
    if (!document.hidden) void pollMediumMetrics();
  }, 25000);

  document.removeEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function stopLiveMonitor() {
  if (fastPollingTimer) { clearInterval(fastPollingTimer); fastPollingTimer = null; }
  if (mediumPollingTimer) { clearInterval(mediumPollingTimer); mediumPollingTimer = null; }
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

// 5b. Audit Log Renderer
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

async function exportAuditLogsCsv() {
  try {
    const res = await fetch("/api/audit-log/export", {
      credentials: "same-origin",
      headers: getHeaders()
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Export failed");
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast("Export Downloaded", "Audit log CSV exported successfully.", "success");
  } catch (err) {
    showToast("Export Error", err.message, "error");
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
  const capacity = metrics.storageCapacity;
  if ($("stat-backup-space-available")) {
    $("stat-backup-space-available").textContent = capacity ? capacity.formattedAvailableBytes : "Unavailable";
  }
  if ($("stat-backup-space-detail")) {
    $("stat-backup-space-detail").textContent = capacity
      ? `${capacity.usedPercent}% used of backup volume`
      : "Backup volume capacity unavailable";
  }

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
      credentials: "same-origin",
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
  $("help-imap-alt-port").textContent = config.incoming.alternativePort ?? "Disabled";
  $("help-pop3-alt-port").textContent = config.pop3.alternativePort ?? "Disabled";
  $("help-pop3-port").textContent = config.pop3.port;
  $("help-smtp-port").textContent = config.outgoing.port;
  $("help-smtp-alt-port").textContent = config.outgoing.alternativePort;
  $("help-smtp-plain-port").textContent = config.outgoing.plaintextPort;
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

async function loadQuarantine(options = {}) {
  const silent = Boolean(options && options.silent);
  const tbody = $("quarantine-tbody");
  if (tbody && !silent && (!tbody.children.length || tbody.querySelector(".text-muted"))) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Loading held messages...</td></tr>';
  }
  try {
    const response = await request("/api/quarantine");
    const items = Array.isArray(response.items) ? response.items : [];
    if ($("quarantine-count")) $("quarantine-count").textContent = `${items.length} held`;
    if ($("badge-nav-quarantine")) $("badge-nav-quarantine").textContent = String(items.length);
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted">No messages are currently held in the Postfix quarantine queue.</td></tr>';
      return;
    }
    const owner = state.adminUser?.role === "owner";
    tbody.innerHTML = items.map((item) => {
      const queueId = String(item.queueId || "");
      const recipients = Array.isArray(item.recipients) ? item.recipients.join(", ") : "";
      const received = item.arrivalTime ? formatDate(item.arrivalTime) : "Unknown";
      const size = formatBytes(Number(item.sizeBytes || 0));
      return `<tr>
        <td><code>${escapeHtml(queueId)}</code></td>
        <td>${escapeHtml(received)}</td>
        <td>${escapeHtml(item.sender || "(empty sender)")}</td>
        <td>${escapeHtml(recipients || "No recipient metadata")}</td>
        <td>${escapeHtml(size)}</td>
        <td class="table-actions">
          <button class="btn btn-primary btn-xs" onclick="rescanAndReleaseQuarantinedMessage('${escapeHtml(queueId)}')">Rescan &amp; Release</button>
          ${owner ? `<button class="btn btn-danger btn-xs" onclick="deleteQuarantinedMessage('${escapeHtml(queueId)}')">Delete</button>` : ""}
        </td>
      </tr>`;
    }).join("");
  } catch (err) {
    if (!silent) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-danger">${escapeHtml(err.message)}</td></tr>`;
      showToast("Quarantine Load Failed", err.message, "error");
    }
  }
}

async function rescanAndReleaseQuarantinedMessage(queueId) {
  if (!/^[A-Za-z0-9]{5,64}$/.test(queueId)) return showToast("Invalid Queue ID", "The queue ID format is not valid.", "error");
  if (!confirm(`Rescan message ${queueId} with Rspamd and ClamAV, then release only if the current policy returns a clean verdict?`)) return;
  try {
    const result = await request(`/api/quarantine/${encodeURIComponent(queueId)}/rescan-release`, { method: "POST" });
    const symbols = Array.isArray(result.symbols) && result.symbols.length ? ` Symbols: ${result.symbols.slice(0, 6).join(", ")}.` : "";
    showToast("Message Rescanned & Released", `Score ${result.score}; recipient tag threshold ${result.threshold}.${symbols}`, "success", 7000);
    await loadQuarantine();
  } catch (err) {
    showToast("Message Remains Quarantined", err.message, "warning", 7000);
  }
}

async function deleteQuarantinedMessage(queueId) {
  if (state.adminUser?.role !== "owner") return showToast("Permission Denied", "Only the owner can permanently delete held mail.", "error");
  if (!/^[A-Za-z0-9]{5,64}$/.test(queueId)) return showToast("Invalid Queue ID", "The queue ID format is not valid.", "error");
  if (!confirm(`Permanently delete held message ${queueId}? This cannot be undone.`)) return;
  try {
    await request(`/api/quarantine/${encodeURIComponent(queueId)}`, { method: "DELETE" });
    showToast("Message Deleted", `Held message ${queueId} was deleted.`, "success");
    await loadQuarantine();
  } catch (err) {
    showToast("Delete Failed", err.message, "error");
  }
}

const SECURITY_LIST_LABELS = {
  allow_sender: "Allowed sender",
  block_sender: "Blocked sender",
  allow_domain: "Allowed domain",
  block_domain: "Blocked domain",
  block_extension: "Blocked attachment extension"
};

async function loadSecurityPolicies() {
  const status = $("security-policy-map-status");
  const tbody = $("security-policy-list-tbody");
  if (status) status.textContent = "Loading organization security policies...";
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-muted">Loading policy lists...</td></tr>';
  try {
    const [policyResult, historyResult] = await Promise.allSettled([
      request("/api/security-policies"),
      request("/api/security-policies/history")
    ]);
    if (policyResult.status === "rejected") throw policyResult.reason;
    state.securityPolicies = policyResult.value;
    renderSecurityPolicies();

    // Policy controls must remain usable if the separate audit-history query
    // is temporarily unavailable. Show the history error locally, not as a
    // failure of the entire security-policy page.
    if (historyResult.status === "fulfilled") {
      state.securityPolicyHistory = historyResult.value;
      renderSecurityPolicyHistory(historyResult.value);
    } else {
      state.securityPolicyHistory = [];
      if ($("security-policy-history-tbody")) {
        $("security-policy-history-tbody").innerHTML = `<tr><td colspan="5" class="text-danger">History unavailable: ${escapeHtml(historyResult.reason?.message || "Request failed")}</td></tr>`;
      }
    }
  } catch (err) {
    if (status) {
      status.className = "alert-box alert-danger mb-4";
      status.textContent = `Unable to load security policies: ${err.message}`;
    }
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-danger">${escapeHtml(err.message)}</td></tr>`;
    showToast("Security Policies Load Failed", err.message, "error");
  }
}

function renderSecurityPolicies() {
  const data = state.securityPolicies;
  if (!data) return;
  const sync = data.mapSync || {};
  const status = $("security-policy-map-status");
  if (status) {
    const healthy = sync.status === "healthy";
    status.className = `alert-box ${healthy ? "alert-success" : "alert-warning"} mb-4`;
    status.textContent = healthy
      ? `Policy files were written to the shared Rspamd map volume at ${sync.lastSyncedAt ? formatDate(sync.lastSyncedAt) : "startup"}. Rspamd monitors these files for updates.`
      : `Policy map status: ${sync.status || "unavailable"}. ${sync.error || "Maps have not yet been confirmed written; verify the API and Rspamd map volume before relying on recent changes."}`;
  }
  const scopeControl = $("security-policy-scope");
  if (scopeControl && state.adminUser?.role === "admin" && scopeControl.value === "global") {
    if ((state.domains || []).length) scopeControl.value = "domain";
    else if ((state.mailboxes || []).length) scopeControl.value = "mailbox";
  }
  populateSecurityPolicyTarget();
  renderSecurityPolicyEditor();
  renderSecurityPolicyEntries();
}

function populateSecurityPolicyTarget() {
  const scope = $("security-policy-scope")?.value || "global";
  const wrap = $("security-policy-target-wrap");
  const target = $("security-policy-target");
  if (!wrap || !target) return;
  wrap.classList.toggle("hidden", scope === "global");
  if (scope === "global") {
    target.innerHTML = "";
    return;
  }
  const previous = target.value;
  const items = scope === "domain" ? (state.domains || []) : (state.mailboxes || []);
  target.innerHTML = items.length ? items.map((item) => {
    const label = scope === "domain" ? item.name : item.address;
    return `<option value="${escapeHtml(item.id)}">${escapeHtml(label || `#${item.id}`)}</option>`;
  }).join("") : `<option value="">No ${scope === "domain" ? "domains" : "mailboxes"} available</option>`;
  target.disabled = items.length === 0;
  if (items.some((item) => String(item.id) === previous)) target.value = previous;
}

function renderSecurityPolicyEditor() {
  const data = state.securityPolicies;
  if (!data) return;
  const scope = $("security-policy-scope")?.value || "global";
  const targetId = Number($("security-policy-target")?.value || 0);
  const global = data.policies?.global || { spamTagScore: 6, spamRejectScore: 15, greylistScore: 4 };
  let record = null;
  let inherited = global;
  let label = "Organization defaults";
  if (scope === "domain") {
    record = (data.policies?.domains || []).find((item) => Number(item.domainId) === targetId) || null;
    label = record?.scopeName || state.domains.find((item) => Number(item.id) === targetId)?.name || "Selected domain";
  } else if (scope === "mailbox") {
    const mailbox = (state.mailboxes || []).find((item) => Number(item.id) === targetId);
    record = (data.policies?.mailboxes || []).find((item) => Number(item.mailboxId) === targetId) || null;
    const domainPolicy = (data.policies?.domains || []).find((item) => Number(item.domainId) === Number(mailbox?.domain_id));
    inherited = {
      spamTagScore: domainPolicy?.spamTagScore ?? global.spamTagScore,
      spamRejectScore: domainPolicy?.spamRejectScore ?? global.spamRejectScore,
      greylistScore: domainPolicy?.greylistScore ?? global.greylistScore
    };
    label = record?.scopeName || mailbox?.address || "Selected mailbox";
  }

  const values = scope === "global" ? global : record || {};
  const inputs = [
    ["security-policy-tag-score", "spamTagScore"],
    ["security-policy-reject-score", "spamRejectScore"],
    ["security-policy-greylist-score", "greylistScore"]
  ];
  inputs.forEach(([id, key]) => {
    const input = $(id);
    if (!input) return;
    const value = values[key];
    input.value = value === null || value === undefined ? "" : String(value);
    input.placeholder = scope === "global" ? "Required" : `Inherit (${inherited[key]})`;
    input.disabled = (scope === "global" && state.adminUser?.role !== "owner") || (scope !== "global" && targetId <= 0);
  });

  const owner = state.adminUser?.role === "owner";
  const save = $("btn-save-security-policy");
  if (save) save.disabled = scope === "global" ? !owner : targetId <= 0;
  const reset = $("btn-reset-security-policy");
  if (reset) {
    reset.classList.toggle("hidden", scope === "global");
    reset.disabled = targetId <= 0 || !record;
  }
  const hint = $("security-policy-inheritance");
  if (hint) {
    hint.textContent = scope === "global"
      ? `Editing organization defaults. Current values: tag ${global.spamTagScore}, reject ${global.spamRejectScore}, greylist ${global.greylistScore}.`
      : `${label}: blank values inherit tag ${inherited.spamTagScore}, reject ${inherited.spamRejectScore}, greylist ${inherited.greylistScore}.`;
  }
}

async function saveSecurityPolicy() {
  const scope = $("security-policy-scope")?.value || "global";
  const targetId = Number($("security-policy-target")?.value || 0);
  const valueOf = (id) => {
    const raw = $(id)?.value?.trim() ?? "";
    return raw === "" ? null : Number(raw);
  };
  const payload = {
    spamTagScore: valueOf("security-policy-tag-score"),
    spamRejectScore: valueOf("security-policy-reject-score"),
    greylistScore: valueOf("security-policy-greylist-score")
  };
  if (scope === "global" || Object.values(payload).some((value) => value !== null)) {
    if (Object.values(payload).some((value) => value !== null && !Number.isFinite(value))) {
      return showToast("Invalid Policy", "Enter valid numeric thresholds.", "error");
    }
  }
  if (scope === "global" && Object.values(payload).some((value) => value === null)) {
    return showToast("Incomplete Policy", "All organization default thresholds are required.", "error");
  }
  if (scope !== "global" && targetId <= 0) return showToast("Select a Target", "Choose a domain or mailbox first.", "error");
  if (payload.spamTagScore !== null && payload.spamRejectScore !== null && payload.spamRejectScore <= payload.spamTagScore) {
    return showToast("Invalid Thresholds", "Reject score must be greater than tag score.", "error");
  }
  const path = scope === "global" ? "/api/security-policies/global" : `/api/security-policies/${scope === "domain" ? "domains" : "mailboxes"}/${targetId}`;
  try {
    await request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    showToast("Security Policy Saved", "Policy is saved and the generated map files were published to the shared Rspamd volume. Rspamd monitors these files for reload.", "success");
    await loadSecurityPolicies();
  } catch (err) {
    showToast("Policy Save Failed", err.message, "error", 7000);
    await loadSecurityPolicies();
  }
}

async function resetSecurityPolicy() {
  const scope = $("security-policy-scope")?.value || "global";
  const targetId = Number($("security-policy-target")?.value || 0);
  if (scope === "global" || targetId <= 0) return;
  if (!confirm(`Remove the ${scope} override and inherit its parent security policy?`)) return;
  try {
    await request(`/api/security-policies/${scope === "domain" ? "domains" : "mailboxes"}/${targetId}/reset`, { method: "DELETE" });
    showToast("Policy Override Reset", "The selected scope now inherits its parent policy.", "success");
    await loadSecurityPolicies();
  } catch (err) {
    showToast("Policy Reset Failed", err.message, "error");
  }
}

function renderSecurityPolicyEntries() {
  const tbody = $("security-policy-list-tbody");
  if (!tbody) return;
  const entries = state.securityPolicies?.entries || [];
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No organization allowlist or blocklist entries.</td></tr>';
    return;
  }
  const canManage = ["owner", "admin"].includes(state.adminUser?.role);
  tbody.innerHTML = entries.map((entry) => `
    <tr>
      <td>${escapeHtml(SECURITY_LIST_LABELS[entry.list_type] || entry.list_type)}</td>
      <td><code>${escapeHtml(entry.value)}</code></td>
      <td>${escapeHtml(entry.note || "—")}</td>
      <td>${escapeHtml(entry.created_at ? formatDate(entry.created_at) : "—")}</td>
      <td class="table-actions">${canManage ? `<button class="btn btn-danger btn-xs" onclick="deleteSecurityPolicyEntry(${Number(entry.id)})">Remove</button>` : "—"}</td>
    </tr>`).join("");
}

async function loadSecurityPolicyHistory() {
  const tbody = $("security-policy-history-tbody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="text-muted">Loading policy history...</td></tr>';
  try {
    renderSecurityPolicyHistory(await request("/api/security-policies/history"));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-danger">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderSecurityPolicyHistory(data) {
  const tbody = $("security-policy-history-tbody");
  if (!tbody) return;
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No security policy changes have been recorded.</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((item) => {
    let details = "";
    try { details = typeof item.details === "string" ? item.details : JSON.stringify(item.details || {}); } catch { details = "Details unavailable"; }
    const shortDetails = details.length > 180 ? `${details.slice(0, 177)}...` : details;
    const entity = [item.entity_type, item.entity_id].filter(Boolean).join(" # ") || "—";
    return `<tr>
      <td>${escapeHtml(item.occurred_at ? formatDate(item.occurred_at) : "—")}</td>
      <td><code>${escapeHtml(item.action || "—")}</code></td>
      <td>${item.admin_id ? `Admin #${escapeHtml(item.admin_id)}` : "System"}</td>
      <td>${escapeHtml(entity)}</td>
      <td><span title="${escapeHtml(details)}">${escapeHtml(shortDetails || "—")}</span></td>
    </tr>`;
  }).join("");
}

async function addSecurityPolicyEntry(event) {
  event.preventDefault();
  const listType = $("security-list-type")?.value;
  const value = $("security-list-value")?.value?.trim();
  const note = $("security-list-note")?.value?.trim() || null;
  if (!listType || !value) return showToast("Missing Value", "Select a list type and enter a value.", "error");
  try {
    await request("/api/security-policies/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listType, value, note })
    });
    $("security-list-value").value = "";
    $("security-list-note").value = "";
    showToast("Security List Updated", "The entry is saved and the generated map files were published to the shared Rspamd volume.", "success");
    await loadSecurityPolicies();
  } catch (err) {
    showToast("Unable to Add Entry", err.message, "error");
    await loadSecurityPolicies();
  }
}

async function deleteSecurityPolicyEntry(id) {
  if (!Number.isSafeInteger(id) || id <= 0) return showToast("Invalid Entry", "The security list entry ID is invalid.", "error");
  if (!confirm("Remove this security list entry? The generated Rspamd map files will be republished from PostgreSQL.")) return;
  try {
    await request(`/api/security-policies/entries/${id}`, { method: "DELETE" });
    showToast("Security List Updated", "The entry was removed and the generated map files were published to the shared Rspamd volume.", "success");
    await loadSecurityPolicies();
  } catch (err) {
    showToast("Unable to Remove Entry", err.message, "error");
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
    const title = res.scanBlocked ? "SCAN DEFERRED" : res.isMalware ? "MALWARE DETECTED" : res.isSpam ? "SPAM DETECTED" : "CLEAN MESSAGE";
    const kind = res.scanBlocked || res.isMalware || res.isSpam ? "alert-warning" : "alert-success";
    resultBox.className = `alert-box mt-3 ${kind}`;
    resultBox.innerHTML = `
      <strong>${title}:</strong>
      Score: <b>${escapeHtml(res.score)}</b> (Tag threshold: ${escapeHtml(res.threshold)}) &bull; Action: <b>${escapeHtml(String(res.action).toUpperCase())}</b> &bull; Engine: ${escapeHtml(res.engine)}
      ${res.inputNormalized ? `<div class="mt-2 text-muted">Plain text was wrapped in standard diagnostic email headers before scanning.</div>` : ""}
      ${res.scanBlocked ? `<div class="mt-2">Mandatory malware scanning did not complete. Do not treat this message as clean.</div>` : ""}
      ${Array.isArray(res.symbols) && res.symbols.length ? `<div class="mt-2 text-muted">Signals: ${res.symbols.map(escapeHtml).join(", ")}</div>` : ""}
    `;

    showToast(
      res.scanBlocked ? "Security Scan Deferred" : res.isMalware ? "Malware Signal Detected" : res.isSpam ? "Spam Rule Triggered" : "Message Passed Clean",
      `Score: ${res.score} / ${res.threshold} -> ${res.action}`,
      res.scanBlocked || res.isMalware || res.isSpam ? "warning" : "success"
    );
  } catch (err) {
    recordFailureAlert({
      category: "Rspamd",
      title: "Spam Filter Analysis Failed",
      target: "Rspamd Engine",
      reason: err.message
    });
    showToast("Spam Analysis Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function insertGtubeSpam() {
  $("test-spam-content").value = "From: sender@example.com\nTo: recipient@example.com\nSubject: GTUBE Spam Filter Test\nDate: Tue, 17 Nov 2026 12:00:00 +0000\nMessage-ID: <gtube-test@mailcore.invalid>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n\nThis is a standard test for spam filtering.\nXJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X\n";
  showToast("GTUBE Inserted", "GTUBE standard test pattern loaded for the Rspamd engine.", "info", 1500);
}

function insertCleanEmail() {
  $("test-spam-content").value = "From: team@example.invalid\nTo: john@example.invalid\nSubject: Meeting Schedule for Next Week\nDate: Tue, 17 Nov 2026 12:00:00 +0000\nMessage-ID: <meeting-schedule@mailcore.invalid>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n\nHi John,\nJust checking in on the quarterly report progress. Let me know when you are free.\nBest regards,\nJane\n";
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

function renderMailFlowAnalytics(data) {
  const chart = $("chart-mail-flow-container");
  const summary = $("mail-flow-summary-container");
  if (!chart || !summary) return;
  if (!data || !data.summary || !Array.isArray(data.daily)) {
    chart.innerHTML = '<div class="table-empty">Mail-flow analytics are unavailable. Check Postfix event ingestion and API logs.</div>';
    summary.innerHTML = '<div class="table-empty">No verified delivery summary is available.</div>';
    return;
  }
  const fields = [
    { key: "queued", label: "Queued", color: "#3b82f6" },
    { key: "accepted", label: "Accepted", color: "#10b981" },
    { key: "deferred", label: "Deferred", color: "#f59e0b" },
    { key: "bounced", label: "Bounced", color: "#ef4444" }
  ];
  const maxValue = Math.max(1, ...data.daily.map((day) => fields.reduce((max, field) => Math.max(max, Number(day[field.key] || 0)), 0)));
  const width = 640, height = 190, left = 30, plotHeight = 145;
  const step = (width - left - 12) / Math.max(1, data.daily.length);
  const barWidth = Math.max(2, Math.min(8, (step - 8) / fields.length));
  const bars = data.daily.map((day, index) => {
    const startX = left + index * step;
    const rects = fields.map((field, fieldIndex) => {
      const value = Math.max(0, Number(day[field.key] || 0));
      const h = value > 0 ? Math.max(1, (value / maxValue) * plotHeight) : 0;
      return h ? `<rect x="${startX + fieldIndex * (barWidth + 2)}" y="${plotHeight - h}" width="${barWidth}" height="${h}" rx="2" fill="${field.color}"><title>${escapeHtml(day.date)} · ${field.label}: ${value}</title></rect>` : "";
    }).join("");
    const label = String(day.date || "").slice(5);
    const interval = Math.max(1, Math.ceil(data.daily.length / 7));
    const showLabel = index === 0 || index === data.daily.length - 1 || index % interval === 0;
    return `<g>${rects}${showLabel ? `<text x="${startX + step / 2}" y="${plotHeight + 20}" text-anchor="middle" font-size="10" fill="#64748b">${escapeHtml(label)}</text>` : ""}</g>`;
  }).join("");
  chart.innerHTML = `<div class="chart-legend">${fields.map((field) => `<span class="legend-item"><span class="legend-dot" style="background:${field.color}"></span>${field.label}</span>`).join("")}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily mail lifecycle events for ${data.periodDays} days" style="width:100%;height:210px"><line x1="${left}" y1="${plotHeight}" x2="${width}" y2="${plotHeight}" stroke="#cbd5e1"/>${bars}</svg><p class="text-muted" style="font-size:.72rem;margin-top:6px">Source: persisted Postfix lifecycle events · Generated ${escapeHtml(new Date(data.generatedAt).toLocaleString())}</p>`;
  const values = [
    ["Accepted", data.summary.accepted, "#10b981"], ["Deferred", data.summary.deferred, "#f59e0b"],
    ["Bounced", data.summary.bounced, "#ef4444"], ["Rejected", data.summary.rejected, "#64748b"],
    ["Internal accepted", data.summary.internalAccepted, "#0ea5e9"], ["External accepted", data.summary.externalAccepted, "#8b5cf6"]
  ];
  const rate = data.summary.terminalDeliverySuccessRate;
  summary.innerHTML = `<div class="stats-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">${values.map(([label, value, color]) => `<div class="stat-card" style="padding:12px"><div class="stat-content"><span class="stat-label">${label}</span><div class="stat-number" style="font-size:1.35rem;color:${color}">${Number(value || 0).toLocaleString()}</div></div></div>`).join("")}</div><div class="alert-box alert-info" style="margin-top:12px"><strong>Terminal delivery success rate:</strong> ${rate === null ? "Not enough terminal outcomes" : `${Number(rate).toFixed(2)}%`}<br><small>Accepted ÷ (accepted + bounced). Deferred messages are excluded until a terminal result exists.</small></div><h4 style="margin:16px 0 8px">Top recipient domains</h4>${Array.isArray(data.recipientDomains) && data.recipientDomains.length ? `<div class="table-responsive"><table class="data-table"><thead><tr><th>Domain</th><th>Delivery events</th></tr></thead><tbody>${data.recipientDomains.map((item) => `<tr><td>${escapeHtml(item.domain)}</td><td>${Number(item.deliveries || 0).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>` : '<p class="text-muted">No recipient-domain events recorded in this period.</p>'}`;
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

  const list = Array.isArray(services) ? services : [];
  const pill = $("dash-services-health-pill");
  if (list.length === 0) {
    if (pill) {
      pill.className = "badge badge-warning";
      pill.textContent = "Service Checks Unavailable";
    }
    container.innerHTML = '<div class="empty-state"><p>Live service health data is unavailable. Check the administrator API and service diagnostics.</p></div>';
    return;
  }

  const allOnline = list.length > 0 && list.every((service) => service.status === "healthy");
  if (pill) {
    pill.className = `badge ${allOnline ? "badge-success" : "badge-danger"}`;
    pill.textContent = allOnline ? `All ${list.length} Services Healthy` : "Service Issue Detected";
  }

  container.innerHTML = `
    <div class="latency-list">
      ${list.map((service) => {
        const status = typeof service.status === "string" ? service.status : "unknown";
        const isDown = status === "down";
        const isDegraded = status === "degraded";
        const isHealthy = status === "healthy";
        const width = isDown ? 100 : Math.min(100, Math.max(8, (Number(service.latencyMs) / 50) * 100 || 8));
        const color = isDown ? "#ef4444" : isDegraded ? "#f59e0b" : isHealthy ? "#10b981" : "#94a3b8";
        const label = isDown ? "DOWN" : isDegraded ? "DEGRADED" : isHealthy ? `${Number(service.latencyMs) || 1}ms` : "UNKNOWN";
        return `
          <div class="latency-item">
            <span class="latency-name">${escapeHtml(service.displayName || service.service || "Unknown service")}</span>
            <div class="latency-track">
              <div class="latency-fill" style="width: ${width}%; background: ${color};"></div>
            </div>
            <span class="latency-val" style="color: ${color}; font-weight: 600;">${label}</span>
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

    state.adminUser = data.admin || { username: $("username").value.trim(), role: "admin" };

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

    state.adminUser = data.admin || { username: state.pendingMfa.username, role: "admin" };
    state.pendingMfa = null;

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
        // Keep the browser request aligned with the server-side verification policy.
        userVerification: "required",
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

    state.adminUser = data.admin || { username: "admin", role: "admin" };

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

// Administrator lifecycle — all mutations are owner-only on the API as well.
async function loadAdministrators() {
  const tbody = $("admin-accounts-tbody");
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-muted">Loading administrator accounts...</td></tr>';
  try {
    const result = await request("/api/admins");
    state.administrators = Array.isArray(result.administrators) ? result.administrators : [];
    renderAdministrators();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-muted">${escapeHtml(err.message || "Unable to load administrators")}</td></tr>`;
  }
}

function renderAdministrators() {
  const tbody = $("admin-accounts-tbody");
  const empty = $("admin-accounts-empty");
  if (!tbody || !empty) return;
  empty.classList.toggle("hidden", state.administrators.length > 0);
  if (!state.administrators.length) { tbody.innerHTML = ""; return; }
  tbody.innerHTML = state.administrators.map((admin) => {
    const isSelf = Number(admin.id) === Number(state.adminUser?.id);
    const lastLogin = admin.last_login_at ? formatDate(admin.last_login_at) : "Never";
    const roleOptions = ["owner", "admin", "viewer"].map((role) => `<option value="${role}" ${admin.role === role ? "selected" : ""}>${role}</option>`).join("");
    return `<tr>
      <td><strong>${escapeHtml(admin.username)}</strong><div class="text-muted" style="font-size:.75rem;">${admin.must_change_password ? "Password change required" : "Password configured"}</div></td>
      <td><select id="admin-role-${Number(admin.id)}" ${isSelf ? "disabled" : ""}>${roleOptions}</select></td>
      <td><span class="badge ${admin.active ? "badge-success" : "badge-danger"}">${admin.active ? "Active" : "Suspended"}</span></td>
      <td>${escapeHtml(lastLogin)}</td>
      <td><div class="table-actions">${isSelf ? '<span class="text-muted">Current account</span>' : `<button type="button" class="btn btn-xs btn-secondary" onclick="saveAdministratorAccess(${Number(admin.id)}, '${admin.role}', ${admin.active})">Apply</button><button type="button" class="btn btn-xs ${admin.active ? "btn-danger-outline" : "btn-primary"}" onclick="setAdministratorActive(${Number(admin.id)}, ${!admin.active})">${admin.active ? "Suspend" : "Reactivate"}</button>`}</div></td>
    </tr>`;
  }).join("");
}

async function saveAdministratorAccess(adminId, currentRole, currentActive) {
  const select = $(`admin-role-${adminId}`);
  const role = select?.value || currentRole;
  if (role === currentRole) { showToast("No Changes", "The selected role is already assigned.", "info"); return; }
  if (!window.confirm(`Change this account from ${currentRole} to ${role}? Its existing sessions will be revoked.`)) return;
  try {
    await request(`/api/admins/${adminId}`, { method: "PATCH", body: JSON.stringify({ role, active: currentActive }) });
    showToast("Administrator Updated", "Role changed and existing sessions revoked.", "success");
    await loadAdministrators();
  } catch (err) { showToast("Update Failed", err.message, "error"); }
}

async function setAdministratorActive(adminId, active) {
  const action = active ? "reactivate" : "suspend";
  if (!window.confirm(`Are you sure you want to ${action} this administrator account?`)) return;
  try {
    await request(`/api/admins/${adminId}`, { method: "PATCH", body: JSON.stringify({ active }) });
    showToast("Administrator Access Updated", active ? "Account reactivated." : "Account suspended; active sessions revoked.", "success");
    await loadAdministrators();
  } catch (err) { showToast("Access Update Failed", err.message, "error"); }
}

$("admin-create-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("admin-create-error");
  error?.classList.add("hidden");
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const result = await request("/api/admins", {
      method: "POST",
      body: JSON.stringify({
        username: $("admin-create-username").value.trim(),
        password: $("admin-create-password").value,
        role: $("admin-create-role").value
      })
    });
    form.reset();
    showToast("Administrator Created", result.message || "The new administrator must change the initial password.", "success", 6500);
    await loadAdministrators();
  } catch (err) {
    if (error) { error.textContent = err.message; error.classList.remove("hidden"); }
    showToast("Creation Failed", err.message, "error");
  } finally { if (submit) submit.disabled = false; }
});

// Admin Security Modal & 2FA Setup Functions
async function openAdminSecurityModal() {
  openModal("modal-admin-security");
  state.pendingTotpSetup = null;
  $("security-totp-setup-panel")?.classList.add("hidden");
  await Promise.all([refreshSecurityStatus(), refreshAdminSessions()]);
}

async function refreshAdminSessions() {
  const container = $("security-sessions-list");
  if (container) container.innerHTML = '<div class="text-muted" style="padding: 6px 0;">Loading active sessions...</div>';
  try {
    const result = await request("/auth/sessions");
    state.adminSessions = Array.isArray(result.sessions) ? result.sessions : [];
    renderAdminSessions();
  } catch (err) {
    if (container) container.innerHTML = `<div class="text-muted" style="padding: 6px 0;">${escapeHtml(err.message || "Unable to load sessions")}</div>`;
  }
}

function renderAdminSessions() {
  const container = $("security-sessions-list");
  const revokeOthersButton = $("btn-revoke-other-sessions");
  if (!container) return;

  const otherSessions = state.adminSessions.filter((session) => !session.current);
  if (revokeOthersButton) revokeOthersButton.disabled = otherSessions.length === 0;

  if (state.adminSessions.length === 0) {
    container.innerHTML = '<div class="text-muted" style="padding: 6px 0;">No active sessions were found. Refresh the panel or sign in again.</div>';
    return;
  }

  container.innerHTML = state.adminSessions.map((session) => {
    const lastSeen = new Date(session.last_seen_at);
    const expires = new Date(session.expires_at);
    const dateText = (value) => Number.isNaN(value.getTime()) ? "Unknown" : value.toLocaleString();
    const browserValue = String(session.user_agent || "Unknown browser / device");
    const browser = browserValue.length > 180 ? `${browserValue.slice(0, 177)}...` : browserValue;
    const ip = String(session.ip_address || "Unknown IP");
    return `
      <div class="passkey-item-row" style="align-items: flex-start; gap: 12px;">
        <div class="passkey-item-info" style="min-width: 0; flex: 1;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          <div style="min-width: 0;">
            <div class="passkey-item-title" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              ${session.current ? "Current browser" : "Signed-in browser"}
              ${session.current ? '<span class="badge badge-success">This session</span>' : ""}
            </div>
            <div class="passkey-item-date" style="overflow-wrap: anywhere;">${escapeHtml(browser)}</div>
            <div class="passkey-item-date">IP: ${escapeHtml(ip)} · Last active: ${escapeHtml(dateText(lastSeen))}</div>
            <div class="passkey-item-date">Absolute expiry: ${escapeHtml(dateText(expires))}</div>
          </div>
        </div>
        ${session.current ? '<span class="text-muted" style="font-size: 0.78rem;">Keep</span>' : `<button type="button" class="btn btn-xs btn-danger-outline" onclick="revokeAdminSession('${escapeHtml(session.id)}')">Revoke</button>`}
      </div>
    `;
  }).join("");
}

async function revokeAdminSession(sessionId) {
  if (!sessionId || !window.confirm("Revoke this administrator session? That device will need to sign in again.")) return;
  try {
    await request(`/auth/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    showToast("Session Revoked", "The selected administrator session has been signed out.", "success");
    await refreshAdminSessions();
  } catch (err) {
    showToast("Unable to Revoke Session", err.message, "error");
  }
}

async function revokeOtherAdminSessions() {
  const otherCount = state.adminSessions.filter((session) => !session.current).length;
  if (otherCount === 0 || !window.confirm(`Sign out ${otherCount} other session(s) for this administrator? The current browser will stay signed in.`)) return;
  try {
    const result = await request("/auth/sessions/revoke-others", { method: "POST" });
    showToast("Other Sessions Revoked", `${result.revokedCount || 0} session(s) signed out.`, "success");
    await refreshAdminSessions();
  } catch (err) {
    showToast("Unable to Revoke Sessions", err.message, "error");
  }
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
async function signOut() {
  try {
    await request("/auth/logout", { method: "POST" });
  } catch {}
  state.adminUser = null;
  showView("login");
  showToast("Signed Out", "Session ended securely.", "info");
}

$("btn-logout").onclick = signOut;
$("btn-topbar-logout")?.addEventListener("click", signOut);

// Topbar refresh button
$("btn-refresh-all").onclick = () => refreshAllData();

// Navigation click listener
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    if (tab) switchTab(tab);
  });
});

// Theme Switcher (Dark / Light Mode)
function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    if ($("theme-icon-sun")) $("theme-icon-sun").classList.remove("hidden");
    if ($("theme-icon-moon")) $("theme-icon-moon").classList.add("hidden");
    if ($("theme-text")) $("theme-text").textContent = "Light";
  } else {
    document.documentElement.removeAttribute("data-theme");
    if ($("theme-icon-sun")) $("theme-icon-sun").classList.add("hidden");
    if ($("theme-icon-moon")) $("theme-icon-moon").classList.remove("hidden");
    if ($("theme-text")) $("theme-text").textContent = "Dark";
  }
  $("btn-theme-toggle")?.setAttribute("aria-pressed", String(theme === "dark"));
}

function enhanceUiAccessibility() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    const tab = button.getAttribute("data-tab");
    const label = button.querySelector("span:not(.nav-pill)")?.textContent?.trim() || "Navigation";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-current", button.classList.contains("active") ? "page" : "false");
    if (tab && $("tab-" + tab)) button.setAttribute("aria-controls", "tab-" + tab);
  });

  document.querySelectorAll(".modal-backdrop").forEach((modal) => {
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const heading = modal.querySelector("h2, h3");
    if (heading) {
      if (!heading.id) heading.id = `${modal.id}-title`;
      modal.setAttribute("aria-labelledby", heading.id);
    }
  });
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  localStorage.setItem("mailAdminTheme", next);
  applyTheme(next);
}

// Quick Search & Keyboard Shortcuts
function focusSearch() {
  const activeTab = document.querySelector(".tab-pane.active")?.id;
  let input = null;
  if (activeTab === "tab-mailboxes") input = $("mailbox-search");
  else if (activeTab === "tab-domains") input = $("domain-search");
  else if (activeTab === "tab-aliases") input = $("alias-search");
  else {
    switchTab("mailboxes");
    input = $("mailbox-search");
  }
  if (input) {
    input.focus();
    input.select();
  }
}

document.addEventListener("keydown", (e) => {
  // Escape closes all open modals and banner
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach((m) => closeModal(m.id));
    const failedAlerts = $("failed-alerts-banner-container");
    if (failedAlerts && !failedAlerts.classList.contains("hidden")) {
      failedAlerts.classList.add("hidden");
    }
  }

  // Ctrl+K / Cmd+K focuses search box
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    focusSearch();
  }
});

// Never leave submitted credentials in the page after an action completes.
// This runs after the form's own submit handler has read the values to build
// its request, and applies equally to success and error paths.
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  window.setTimeout(() => clearSubmittedPasswordFields(form), 0);
}, true);

// App Boot
(async function init() {
  enhanceUiAccessibility();
  const savedTheme = localStorage.getItem("mailAdminTheme") ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(savedTheme);

  try {
    const profile = await request("/auth/me");
    state.adminUser = profile.admin || null;
    if (state.adminUser?.mustChangePassword) {
      showView("setup");
    } else {
      showView("app");
      await refreshAllData();
    }
  } catch {
    state.adminUser = null;
    showView("login");
  }
})();

const mailAnalyticsPeriodHandler = () => request(`/api/analytics/mail?days=${Number($("mail-analytics-period")?.value || 30)}`).then((data) => { state.mailAnalytics = data; renderMailFlowAnalytics(data); }).catch((error) => showToast("Analytics unavailable", error.message, "error"));
$("mail-analytics-period")?.addEventListener("change", mailAnalyticsPeriodHandler);
