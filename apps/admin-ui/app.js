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
  activeDnsDomain: null
};

// DOM Helper
const $ = (id) => document.getElementById(id);

// Auth Header helper
const getHeaders = (extra = {}) => ({
  "Content-Type": "application/json",
  ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  ...extra
});

// Central API Request Handler
async function request(path, options = {}) {
  const url = path;
  const config = {
    ...options,
    headers: getHeaders(options.headers || {})
  };

  try {
    const res = await fetch(url, config);

    if (res.status === 401) {
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
      throw new Error(data.error || `Request failed with status ${res.status}`);
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

// View Switching: login, setup, app
function showView(name) {
  $("view-login").classList.toggle("hidden", name !== "login");
  $("view-setup").classList.toggle("hidden", name !== "setup");
  $("view-app").classList.toggle("hidden", name !== "app");

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
    users: "Users & Mailbox Accounts",
    mailboxes: "Users & Mailbox Accounts",
    domains: "Hosted Domains",
    aliases: "Email Aliases & Forwarding",
    services: "Services, Mail Queue & Diagnostics",
    audit: "Audit Log & Security Trail",
    settings: "Settings & Company Profile"
  };
  $("page-title").textContent = titles[tabId] || "Control Panel";

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

// Password Generator
function generatePassword(length = 16) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*()-_=+";
  const all = upper + lower + digits + symbols;

  let pwd = "";
  pwd += upper[Math.floor(Math.random() * upper.length)];
  pwd += lower[Math.floor(Math.random() * lower.length)];
  pwd += digits[Math.floor(Math.random() * digits.length)];
  pwd += symbols[Math.floor(Math.random() * symbols.length)];

  for (let i = 4; i < length; i++) {
    pwd += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pwd.split("").sort(() => 0.5 - Math.random()).join("");
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
    const [dashboard, company, domains, mailboxes, aliases, clientConfig] = await Promise.all([
      request("/api/dashboard"),
      request("/api/company"),
      request("/api/domains"),
      request("/api/users"),      // Uses virtual_users view (Dovecot-compatible)
      request("/api/aliases"),    // Admin view — includes inactive aliases
      request("/api/users/client-config")
    ]);

    state.dashboardData = dashboard;
    state.company = company;
    state.domains = domains;
    state.mailboxes = mailboxes;
    state.aliases = aliases;
    state.clientConfig = clientConfig;

    renderOverview();
    renderMailboxes();
    renderDomains();
    renderAliases();
    renderCompanyForm();
    renderConnectionHelp(clientConfig);
    populateDomainSelectors();

    if (dashboard.services) {
      renderServicesHealth(dashboard.services);
      renderInfrastructureSummary(dashboard.services);
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
function renderMailboxes() {
  const tbody = $("mailboxes-tbody");
  const empty = $("mailbox-empty");

  const query = ($("mailbox-search")?.value || "").toLowerCase().trim();
  const domainFilter = $("mailbox-domain-filter")?.value || "";
  const statusFilter = $("mailbox-status-filter")?.value || "";

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
    return `
      <tr>
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
          <span class="badge ${m.quota_bytes ? "badge-secondary" : "badge-primary"}">
            ${formatBytes(m.quota_bytes)}
          </span>
        </td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <span class="badge badge-success" style="font-size: 0.72rem; padding: 2px 6px;">IMAP ${state.clientConfig?.incoming.port ?? "—"}</span>
            <span class="badge badge-success" style="font-size: 0.72rem; padding: 2px 6px;">SMTP ${state.clientConfig?.outgoing.port ?? "—"}</span>
          </div>
        </td>
        <td>
          <span class="badge ${m.active ? "badge-success" : "badge-danger"}">
            <span class="badge-status-dot ${m.active ? "online" : "offline"}"></span>
            ${m.active ? "Active" : "Suspended"}
          </span>
        </td>
        <td>${formatDate(m.created_at)}</td>
        <td class="text-right">
          <div class="table-actions">
            <button class="btn-action-icon" title="Mail Client Setup Guide" onclick="openClientGuide('${m.address}', '${m.domain_name}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <button class="btn-action-icon" title="Test User IMAP / SMTP Password" onclick="openTestUserAuth(${m.id}, '${m.address}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            <button class="btn-action-icon" title="Edit User / Password / Quota" onclick="openEditMailbox(${m.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button class="btn-action-icon ${m.active ? "danger" : "verify"}" title="${m.active ? "Suspend User" : "Activate User"}" onclick="toggleMailboxActive(${m.id}, ${!m.active})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${m.active ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>'}</svg>
            </button>
            <button class="btn-action-icon danger" title="Delete User" onclick="deleteMailbox(${m.id}, '${m.address}')">
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
  const aliasSelect = $('alias-domain-select');
  const mbFilter = $('mailbox-domain-filter');
  const domainAlert = $('modal-mailbox-domain-alert');

  if (mbSelect) {
    if (virtualDomains.length === 0) {
      mbSelect.innerHTML = '<option value="">No verified domains</option>';
      if (domainAlert) domainAlert.classList.remove('hidden');
    } else {
      mbSelect.innerHTML = virtualDomains.map((d) => '<option value="' + d.name + '">' + d.name + '</option>').join('');
      if (domainAlert) domainAlert.classList.add('hidden');
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
  document.querySelectorAll(".quota-presets .btn-preset").forEach((b) => b.classList.remove("active"));
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
    showToast("Creation Failed", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Mailbox";
  }
}

// Edit Mailbox Handler
function openEditMailbox(id) {
  const mailbox = state.mailboxes.find((m) => m.id === id);
  if (!mailbox) return;

  $("edit-mb-id").value = mailbox.id;
  $("edit-mb-address").textContent = mailbox.address;
  $("edit-mb-display-name").value = mailbox.display_name || "";
  $("edit-mb-password").value = "";
  $("edit-mb-active").checked = mailbox.active;

  const currentQuota = mailbox.quota_bytes || 0;
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

  if (password && password.length >= 12) {
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
    showToast(newActive ? "Mailbox Activated" : "Mailbox Suspended", `Status updated successfully.`, "info");
    await refreshAllData();
  } catch (err) {
    showToast("Status Change Failed", err.message, "error");
  }
}

// Delete Mailbox
async function deleteMailbox(id, address) {
  if (!confirm(`Are you sure you want to permanently delete mailbox "${address}"?\nAll associated maildir storage and email logs will be removed.`)) {
    return;
  }

  try {
    await request(`/api/mailboxes/${id}`, { method: "DELETE" });
    showToast("Mailbox Deleted", `Account ${address} has been removed.`, "info");
    await refreshAllData();
  } catch (err) {
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
      showToast("Login Failed", res.message, "warning");
    }
  } catch (err) {
    resultBox.classList.remove("hidden");
    resultBox.className = "alert-box alert-warning";
    resultBox.innerHTML = `<strong>Error:</strong> ${escapeHtml(err.message)}`;
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
            <button class="btn btn-secondary btn-sm" onclick="openDnsWizard(${d.id})" title="View DNS records and verify ownership">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><circle cx="12" cy="12" r="10"/></svg>
              <span>DNS Setup</span>
            </button>
            <button class="btn-action-icon ${d.active ? "danger" : "verify"}" title="${d.active ? "Disable Domain" : "Enable Domain"}" onclick="toggleDomainActive(${d.id}, ${!d.active})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${d.active ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>'}</svg>
            </button>
            <button class="btn-action-icon danger" title="Delete Domain" onclick="deleteDomain(${d.id}, '${d.name}')">
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
  const domain = state.domains.find((d) => d.id === domainId);
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
  $("dns-txt-val").textContent = records?.verification.value || "Token pending...";
  $("dns-a-name").textContent = records?.mailHost.name || "mail hostname";
  $("dns-a-val").textContent = records?.mailHost.value || "Set MAIL_PUBLIC_IP";
  $("dns-a-guidance").textContent = records?.mailHost.guidance ||
    "The mail hostname must resolve to this server's public IP. Configure reverse DNS/PTR for the same hostname with your VPS or network provider.";
  $("dns-mx-val").textContent = records?.mx.value || "mail hostname";
  $("dns-mx-priority").textContent = records?.mx.priority ?? "—";
  $("dns-spf-val").textContent = records?.spf.value || "SPF value unavailable";
  $("dns-dkim-host").textContent = records?.dkim.name || "DKIM hostname unavailable";
  $("dns-dkim-val").textContent = records?.dkim.value || "DKIM key pending...";
  $("dns-dmarc-host").textContent = records?.dmarc.name || `_dmarc.${domain.name}`;
  $("dns-dmarc-val").textContent = records?.dmarc.value || "DMARC value unavailable";

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
          <button class="btn-action-icon ${a.active ? "danger" : "verify"}" title="${a.active ? "Disable" : "Enable"}" onclick="toggleAliasActive(${a.id}, ${!a.active})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${a.active ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>'}</svg>
          </button>
          <button class="btn-action-icon danger" title="Delete Alias" onclick="deleteAlias(${a.id}, '${a.source}')">
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
    showToast("Flush Failed", err.message, "error");
  }
}

async function handleTestSmtp(event) {
  event.preventDefault();
  const recipient = $("test-smtp-recipient").value.trim();
  const subject = $("test-smtp-subject").value.trim();
  const body = $("test-smtp-body").value.trim();

  const btn = $("btn-send-test-smtp");
  btn.disabled = true;

  try {
    const res = await request("/api/system/test-smtp", {
      method: "POST",
      body: JSON.stringify({ recipient, subject, body })
    });

    showToast("Diagnostic Email Queued", res.message, "success");
  } catch (err) {
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
   Authentication & Initial Startup
   ========================================================================== */

// Login form
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  const btn = $("btn-login");
  btn.disabled = true;

  try {
    const data = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("username").value.trim(),
        password: $("password").value
      })
    });

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
    showToast("Authentication Failed", err.message, "error");
  } finally {
    btn.disabled = false;
  }
};

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
