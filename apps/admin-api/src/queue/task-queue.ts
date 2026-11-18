import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createClient } from "redis";
import { env } from "../config/env";

export interface QueueJob<T = any> {
  id: string;
  name: string;
  data: T;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  result?: any;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export type JobHandler<T = any> = (job: QueueJob<T>) => Promise<any>;

const QUEUE = process.env.REDIS_QUEUE || "mail_tasks";
const PROCESSING_QUEUE = `${QUEUE}:processing`;
const DEAD_LETTER_QUEUE = `${QUEUE}:dead_letter`;

export interface QueuePayloadParseResult {
  job: QueueJob | null;
  error?: "invalid_json" | "invalid_shape";
}

/** Parse and normalize queue payloads before they reach a handler. */
export function parseQueuePayload(payload: string): QueuePayloadParseResult {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { job: null, error: "invalid_json" };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { job: null, error: "invalid_shape" };
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > 160
    || typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 120) {
    return { job: null, error: "invalid_shape" };
  }

  const attempts = Number.isInteger(raw.attempts) && Number(raw.attempts) >= 0
    ? Math.min(100, Number(raw.attempts)) : 0;
  const maxAttempts = Number.isInteger(raw.maxAttempts) && Number(raw.maxAttempts) >= 1
    ? Math.min(100, Number(raw.maxAttempts)) : 3;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) && raw.createdAt > 0
    ? raw.createdAt : Date.now();
  const status = raw.status === "processing" || raw.status === "completed" || raw.status === "failed"
    ? raw.status : "pending";

  return {
    job: {
      ...(raw as unknown as QueueJob),
      id: raw.id,
      name: raw.name,
      status,
      attempts,
      maxAttempts,
      createdAt
    }
  };
}

function malformedPayloadRecord(payload: string, reason: string): Record<string, unknown> {
  // Do not copy raw job contents into the dead-letter queue: job data may
  // contain mailbox identifiers or other sensitive application metadata.
  const digest = createHash("sha256").update(payload).digest("hex");
  return {
    type: "malformed_queue_payload",
    id: `malformed_${digest.slice(0, 24)}`,
    reason,
    payloadBytes: Buffer.byteLength(payload),
    payloadSha256: digest,
    deadLetteredAt: Date.now()
  };
}

/**
 * Redis-backed at-least-once task queue.
 * Jobs are atomically moved from the pending list to a processing list. A job
 * is acknowledged only after completion or durable dead-letter/retry enqueue.
 * A worker restart requeues unacknowledged jobs; handlers must be idempotent.
 * This is a single-active-worker queue: run one API replica for this queue key.
 */
export class TaskQueue extends EventEmitter {
  private readonly memoryQueue: QueueJob[] = [];
  private readonly completedJobs: QueueJob[] = [];
  private readonly handlers = new Map<string, JobHandler>();
  private readonly redis = createClient({
    socket: { host: env.services.redisHost, port: env.services.redisPort, reconnectStrategy: () => false },
    password: env.services.redisPassword || undefined
  });
  private worker: any = null;
  private startRequested = false;
  private redisConnected = false;
  private processing = false;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionPromise: Promise<void> | null = null;
  private consumePromise: Promise<void> | null = null;
  private stopPromise: Promise<{ drained: boolean }> | null = null;
  private readonly allowMemoryFallback: boolean;
  private readonly retryBaseDelayMs: number;

  constructor(start = true, options: { allowMemoryFallback?: boolean; retryBaseDelayMs?: number } = {}) {
    super();
    // Memory fallback is permitted only for explicitly local/test queues. The
    // production singleton rejects durable jobs whenever Redis is unavailable.
    this.allowMemoryFallback = options.allowMemoryFallback ?? !start;
    this.retryBaseDelayMs = Math.max(0, Math.min(10_000, options.retryBaseDelayMs ?? 250));
    this.redis.on("ready", () => {
      if (!this.stopping) {
        this.redisConnected = true;
        this.emit("connected", { backend: "redis" });
      }
    });
    this.redis.on("end", () => { this.redisConnected = false; });
    this.redis.on("error", () => { this.redisConnected = false; });
    if (start) this.start();
  }

  /** Start Redis consumption only after all job handlers have been registered. */
  start(): void {
    if (this.startRequested || this.stopping) return;
    this.startRequested = true;
    this.connectionPromise = this.connect(true);
  }

  private scheduleReconnect(start: boolean): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (start && !this.stopping) this.connectionPromise = this.connect(true);
    }, 15_000);
    this.reconnectTimer.unref();
  }

  private async closeClient(client: any): Promise<void> {
    if (!client?.isOpen) return;
    try {
      await client.quit();
    } catch {
      try { client.disconnect(); } catch { /* already closed */ }
    }
  }

  private async connect(start: boolean): Promise<void> {
    if (this.stopping) return;
    let newWorker: any = null;
    try {
      if (!this.redis.isOpen) await this.redis.connect();
      if (!start || this.stopping || this.worker) return;

      newWorker = this.redis.duplicate();
      this.worker = newWorker;
      newWorker.on("error", () => { this.redisConnected = false; });
      await newWorker.connect();
      if (this.stopping) {
        await this.closeClient(newWorker);
        if (this.worker === newWorker) this.worker = null;
        return;
      }
      await this.recoverProcessingJobs();
      if (this.stopping) return;

      const consumer = this.consume();
      this.consumePromise = consumer;
      void consumer.then(
        () => { if (this.consumePromise === consumer) this.consumePromise = null; },
        (error) => {
          if (this.consumePromise === consumer) this.consumePromise = null;
          this.redisConnected = false;
          this.emit("workerError", { message: error instanceof Error ? error.message : "Unknown worker error" });
          if (!this.stopping) this.scheduleReconnect(true);
        }
      );
    } catch {
      this.redisConnected = false;
      if (newWorker) await this.closeClient(newWorker);
      if (this.worker === newWorker) this.worker = null;
      if (!this.stopping) this.scheduleReconnect(start);
    }
  }

  /** Requeue jobs left in processing after an unclean worker exit. */
  private async recoverProcessingJobs(): Promise<void> {
    const stranded = await this.redis.lRange(PROCESSING_QUEUE, 0, -1);
    for (const payload of stranded) {
      // Push first, then remove from processing. A crash between commands can
      // create a duplicate, but cannot lose the job (at-least-once semantics).
      await this.redis.lPush(QUEUE, payload);
      await this.redis.lRem(PROCESSING_QUEUE, 1, payload);
    }
    if (stranded.length) this.emit("recovered", { count: stranded.length });
  }

  private async deadLetterMalformedPayload(payload: string, reason: string): Promise<void> {
    const record = malformedPayloadRecord(payload, reason);
    // Persist the failure record before acknowledging the processing entry.
    await this.redis.rPush(DEAD_LETTER_QUEUE, JSON.stringify(record));
    await this.redis.lRem(PROCESSING_QUEUE, 1, payload);
    this.emit("deadLetteredMalformed", record);
  }

  private async consume(): Promise<void> {
    while (this.worker?.isReady && !this.stopping) {
      try {
        // BRPOPLPUSH atomically claims a job. It remains recoverable until acked.
        const payload = await this.worker.brPopLPush(QUEUE, PROCESSING_QUEUE, 1);
        if (!payload) continue;

        // Shutdown must not start new work. Return the claimed payload to the
        // pending list before leaving the consumer loop.
        if (this.stopping) {
          await this.redis.lPush(QUEUE, payload);
          await this.redis.lRem(PROCESSING_QUEUE, 1, payload);
          break;
        }

        const parsed = parseQueuePayload(payload);
        if (!parsed.job) {
          await this.deadLetterMalformedPayload(payload, parsed.error ?? "invalid_shape");
          continue;
        }
        await this.execute(parsed.job, payload);
      } catch {
        this.redisConnected = false;
        const failedWorker = this.worker;
        this.worker = null;
        if (failedWorker) {
          try { failedWorker.disconnect(); } catch { /* already disconnected */ }
        }
        if (!this.stopping) this.scheduleReconnect(true);
        break;
      }
    }
  }

  registerHandler<T>(name: string, handler: JobHandler<T>): void {
    if (this.stopping) throw new Error("Cannot register queue handlers after shutdown has started");
    this.handlers.set(name, handler as JobHandler);
  }

  async enqueue<T>(name: string, data: T, options: { maxAttempts?: number } = {}): Promise<QueueJob<T>> {
    if (this.stopping) throw new Error("Task queue is shutting down; refusing new jobs");
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("maxAttempts must be an integer between 1 and 100");
    }
    const job: QueueJob<T> = {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name, data, status: "pending", attempts: 0,
      maxAttempts, createdAt: Date.now()
    };
    const payload = JSON.stringify(job);
    if (this.redisConnected && this.redis.isReady) {
      try {
        await this.redis.lPush(QUEUE, payload);
      } catch {
        this.redisConnected = false;
        if (!this.allowMemoryFallback) {
          this.emit("unavailable", { name, id: job.id });
          throw new Error(`Redis unavailable; refusing non-durable task ${name}`);
        }
        this.memoryQueue.push(job);
      }
    } else if (this.allowMemoryFallback) {
      this.memoryQueue.push(job);
    } else {
      this.emit("unavailable", { name, id: job.id });
      throw new Error(`Redis unavailable; refusing non-durable task ${name}`);
    }
    this.emit("enqueued", job);
    if (!this.redisConnected && this.allowMemoryFallback) void this.processMemory();
    return job;
  }

  private async processMemory(): Promise<void> {
    if (this.processing || this.stopping) return;
    const job = this.memoryQueue.find((candidate) => candidate.status === "pending");
    if (!job) return;
    this.processing = true;
    try {
      await this.execute(job);
    } finally {
      this.processing = false;
      if (!this.stopping && job.status === "pending") setTimeout(() => void this.processMemory(), 25);
      else if (!this.stopping) void this.processMemory();
    }
  }

  private async execute(job: QueueJob, redisPayload?: string): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      job.status = "failed";
      job.error = `No handler registered for task: ${job.name}`;
      if (redisPayload) {
        await this.redis.rPush(DEAD_LETTER_QUEUE, JSON.stringify(job));
        await this.redis.lRem(PROCESSING_QUEUE, 1, redisPayload);
      }
      this.emit("failed", job);
      this.finishMemory(job);
      return;
    }

    job.status = "processing";
    job.attempts++;
    try {
      job.result = await handler(job);
      job.status = "completed";
      job.completedAt = Date.now();
      if (redisPayload) await this.redis.lRem(PROCESSING_QUEUE, 1, redisPayload);
      this.emit("completed", job);
    } catch (error: any) {
      job.error = error?.message || "Execution error";
      if (job.attempts < job.maxAttempts) {
        job.status = "pending";
        if (redisPayload) {
          // Keep the processing copy until the retry is durably enqueued. A
          // crash can cause a duplicate, never a lost retry.
          const delayMs = Math.min(30_000, this.retryBaseDelayMs * (2 ** Math.max(0, job.attempts - 1)));
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          await this.redis.lPush(QUEUE, JSON.stringify(job));
          await this.redis.lRem(PROCESSING_QUEUE, 1, redisPayload);
        } else if (!this.memoryQueue.includes(job)) {
          this.memoryQueue.push(job);
        }
      } else {
        job.status = "failed";
        if (redisPayload) {
          await this.redis.rPush(DEAD_LETTER_QUEUE, JSON.stringify(job));
          await this.redis.lRem(PROCESSING_QUEUE, 1, redisPayload);
        }
        this.emit("failed", job);
      }
    } finally {
      this.finishMemory(job);
    }
  }

  private finishMemory(job: QueueJob): void {
    if (job.status === "completed" || job.status === "failed") {
      const index = this.memoryQueue.indexOf(job);
      if (index >= 0) this.memoryQueue.splice(index, 1);
      this.completedJobs.unshift(job);
      if (this.completedJobs.length > 100) this.completedJobs.pop();
    }
  }

  /**
   * Stop intake, let the current job finish, and close Redis clients. Pending
   * jobs remain in the pending list. A false result means the caller must let
   * the process terminate so the processing-list entry is recovered on boot.
   */
  async stop(drainTimeoutMs = 25_000): Promise<{ drained: boolean }> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    this.stopPromise = (async () => {
      const timeoutMs = Number.isInteger(drainTimeoutMs) ? Math.max(0, Math.min(120_000, drainTimeoutMs)) : 25_000;
      let timeout: NodeJS.Timeout | undefined;
      const timeoutResult = new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      });
      const finish = (async () => {
        if (this.connectionPromise) await this.connectionPromise.catch(() => undefined);
        const consumer = this.consumePromise;
        if (consumer) await consumer.catch(() => undefined);
        return true;
      })();
      const drained = await Promise.race([finish, timeoutResult]);
      if (timeout) clearTimeout(timeout);

      if (drained) {
        await this.closeClient(this.worker);
        await this.closeClient(this.redis);
      } else {
        // The active job will be left in the processing list. Terminating this
        // process allows the next worker to recover it; do not acknowledge it.
        try { this.worker?.disconnect(); } catch { /* already disconnected */ }
        try { this.redis.disconnect(); } catch { /* already disconnected */ }
      }
      this.worker = null;
      this.redisConnected = false;
      return { drained };
    })();
    return this.stopPromise;
  }

  async getStats() {
    let redisPending = 0;
    let redisProcessing = 0;
    let redisDeadLetter = 0;
    if (this.redisConnected && this.redis.isReady) {
      try {
        [redisPending, redisProcessing, redisDeadLetter] = await Promise.all([
          this.redis.lLen(QUEUE), this.redis.lLen(PROCESSING_QUEUE), this.redis.lLen(DEAD_LETTER_QUEUE)
        ]);
      } catch { /* connection state is reported below */ }
    }
    return {
      backend: this.redisConnected ? "redis_at_least_once" : (this.allowMemoryFallback ? "memory_degraded_non_durable_test_mode" : "unavailable_rejecting_non_durable_jobs"),
      redisHost: env.services.redisHost,
      redisPort: env.services.redisPort,
      pendingCount: this.memoryQueue.filter((j) => j.status === "pending").length + redisPending,
      processingCount: this.memoryQueue.filter((j) => j.status === "processing").length + redisProcessing,
      deadLetterCount: redisDeadLetter,
      completedCount: this.completedJobs.filter((j) => j.status === "completed").length,
      failedCount: this.completedJobs.filter((j) => j.status === "failed").length,
      recentJobs: this.completedJobs.slice(0, 10).map(({ id, name, status, attempts, createdAt, completedAt }) =>
        ({ id, name, status, attempts, createdAt, completedAt }))
    };
  }
}

export const taskQueue = new TaskQueue(false, { allowMemoryFallback: false });
