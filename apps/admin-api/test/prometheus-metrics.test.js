const test = require("node:test");
const assert = require("node:assert/strict");
const { recordHttpRequest, renderHttpPrometheusMetrics } = require("../dist/utils/prometheus-metrics.js");

test("Prometheus HTTP metrics include counter and cumulative histogram buckets", () => {
  recordHttpRequest("GET", "/api/dashboard", 200, 0.02);
  recordHttpRequest("GET", "/api/dashboard", 200, 0.2);
  const output = renderHttpPrometheusMetrics();
  assert.match(output, /mailcore_http_requests_total\{method="GET",route="\/api\/dashboard",status="200"\} 2/);
  assert.match(output, /mailcore_http_request_duration_seconds_bucket\{[^\n]*le="\+Inf"\} 2/);
  assert.match(output, /mailcore_http_request_duration_seconds_count\{[^\n]*\} 2/);
});

test("Prometheus metrics escape label control characters", () => {
  recordHttpRequest("GET", "/route\nwith\"quotes", 500, 0.01);
  const output = renderHttpPrometheusMetrics();
  assert.match(output, /route="\/route\\nwith\\"quotes"/);
  assert.doesNotMatch(output, /route="\/route\nwith/);
});
