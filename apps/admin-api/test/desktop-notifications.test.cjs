'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const appPath = path.resolve(__dirname, '../../admin-ui/app.js');
const appSource = fs.readFileSync(appPath, 'utf8');

function extractFunctionSection(name, nextMarker) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `Expected ${name}() in admin UI source`);
  return appSource.slice(start, end).trim();
}

const desktopNotificationCode = extractFunctionSection(
  'showDesktopNotification',
  '// View Switching:'
);
const realtimeEventCode = extractFunctionSection(
  'handleRealtimeEvent',
  'function renderLiveServiceSnapshot'
);

function createBrowserContext({ permission = 'granted', apiAvailable = true, role = 'owner' } = {}) {
  const notifications = [];
  let focusCount = 0;
  let toasts = [];

  class MockNotification {
    static permission = permission;

    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      notifications.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  const window = {
    focus() {
      focusCount += 1;
    }
  };
  if (apiAvailable) window.Notification = MockNotification;

  const context = {
    state: { adminUser: { role }, currentTab: 'events' },
    window,
    console,
    seenRealtimeEventIds: new Set(),
    scheduleEventUiRefresh() {},
    showToast(title, message, type) {
      toasts.push({ title, message, type });
    },
    loadQuarantine() {},
    pollFastMetrics() {}
  };

  vm.runInNewContext(
    `${desktopNotificationCode}\n${realtimeEventCode}\n` +
      'this.showDesktopNotification = showDesktopNotification;\n' +
      'this.handleRealtimeEvent = handleRealtimeEvent;',
    context
  );

  return {
    context,
    notifications,
    toasts,
    get focusCount() { return focusCount; }
  };
}

test('creates a desktop notification with the configured body and favicon when permission is granted', () => {
  const browser = createBrowserContext();
  browser.context.showDesktopNotification(
    'Security Alert',
    'A sensitive security event was detected.',
    'test-security-event'
  );

  assert.equal(browser.notifications.length, 1);
  assert.equal(browser.notifications[0].title, 'Security Alert');
  assert.equal(browser.notifications[0].options.body, 'A sensitive security event was detected.');
  assert.equal(browser.notifications[0].options.icon, '/favicon.ico');
  assert.equal(browser.notifications[0].options.tag, 'test-security-event');
  assert.equal(browser.notifications[0].options.renotify, false);

  browser.notifications[0].onclick();
  assert.equal(browser.focusCount, 1);
  assert.equal(browser.notifications[0].closed, true);
});

test('does not show or request a desktop notification when permission is default or denied', () => {
  assert.equal(createBrowserContext({ permission: 'default' }).notifications.length, 0);
  assert.equal(createBrowserContext({ permission: 'denied' }).notifications.length, 0);
  assert.equal(createBrowserContext({ apiAvailable: false }).notifications.length, 0);
  assert.doesNotMatch(appSource, /Notification\.requestPermission\s*\(/);
});

test('limits desktop notifications to owner and admin sessions', () => {
  const browser = createBrowserContext({ role: 'user' });
  browser.context.showDesktopNotification('Security Alert', 'A sensitive security event was detected.');
  assert.equal(browser.notifications.length, 0);
});

test('uses a generic desktop body for sensitive security events and keeps the in-app toast', () => {
  const browser = createBrowserContext();
  browser.context.handleRealtimeEvent({
    id: 'security-event-1',
    category: 'security',
    severity: 'warning',
    action: 'security.login.failed',
    summary: 'Sensitive account and request details must not appear in the OS notification'
  });

  assert.equal(browser.notifications.length, 1);
  assert.equal(browser.notifications[0].options.body, 'A sensitive security event was detected.');
  assert.equal(browser.notifications[0].options.body.includes('Sensitive account'), false);
  assert.equal(browser.toasts.length, 1);
});

test('notifies for new quarantined mail, deduplicates events, and marks quarantine recovery as success', () => {
  const browser = createBrowserContext();

  const heldMail = {
    id: 'quarantine-held-1',
    category: 'security',
    severity: 'notice',
    action: 'security.quarantine.message.held',
    summary: 'A message was held'
  };
  browser.context.handleRealtimeEvent(heldMail);
  browser.context.handleRealtimeEvent(heldMail);

  assert.equal(browser.notifications.length, 1);
  assert.equal(browser.notifications[0].title, 'New Quarantined Mail');
  assert.equal(browser.toasts.length, 1);

  browser.context.handleRealtimeEvent({
    id: 'quarantine-recovered-1',
    category: 'security',
    severity: 'notice',
    action: 'security.quarantine.service.recovered'
  });
  assert.equal(browser.notifications.length, 2);
  assert.equal(browser.notifications[1].title, 'Quarantine Service Recovered');
  assert.equal(browser.toasts[1].type, 'success');
});
