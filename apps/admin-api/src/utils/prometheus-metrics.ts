type RequestMetric = { count: number; durationSum: number; buckets: number[] };
const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const requestMetrics = new Map<string, RequestMetric>();
function escapeLabel(value: string): string { return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"'); }
function labels(method: string, route: string, status: number): string { return `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"`; }
export function recordHttpRequest(method: string, route: string, status: number, durationSeconds: number): void {
  const key = labels(method, route, status); let metric = requestMetrics.get(key);
  if (!metric) { metric = { count: 0, durationSum: 0, buckets: HISTOGRAM_BUCKETS.map(() => 0) }; requestMetrics.set(key, metric); }
  metric.count += 1; metric.durationSum += Math.max(0, durationSeconds);
  HISTOGRAM_BUCKETS.forEach((bound, index) => { if (durationSeconds <= bound) metric!.buckets[index] += 1; });
}
export function renderHttpPrometheusMetrics(): string {
  const lines = ["# HELP mailcore_http_requests_total Total completed HTTP requests handled by the API process.", "# TYPE mailcore_http_requests_total counter"];
  for (const [key, value] of requestMetrics) lines.push(`mailcore_http_requests_total{${key}} ${value.count}`);
  lines.push("# HELP mailcore_http_request_duration_seconds HTTP request duration in seconds.", "# TYPE mailcore_http_request_duration_seconds histogram");
  for (const [key, value] of requestMetrics) {
    HISTOGRAM_BUCKETS.forEach((bound, index) => lines.push(`mailcore_http_request_duration_seconds_bucket{${key},le="${bound}"} ${value.buckets[index]}`));
    lines.push(`mailcore_http_request_duration_seconds_bucket{${key},le="+Inf"} ${value.count}`);
    lines.push(`mailcore_http_request_duration_seconds_sum{${key}} ${value.durationSum.toFixed(6)}`);
    lines.push(`mailcore_http_request_duration_seconds_count{${key}} ${value.count}`);
  }
  return lines.join("\n");
}
