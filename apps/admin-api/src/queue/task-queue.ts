import { EventEmitter } from "events";
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

/**
 * Redis-backed at-least-once task queue.
 * Jobs are atomically moved from the pending list to a processing list. A job
 * is acknowledged only after completion or durable dead-letter/retry enqueue.
 * A worker restart requeues unacknowledged jobs; handlers should be idempotent.
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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly allowMemoryFallback: boolean;
  private readonly retryBaseDelayMs: number;

  constructor(start = true, options: { allowMemoryFallback?: boolean; retryBaseDelayMs?: number } = {}) {
    super();
    // Memory fallback is permitted only for explicitly local/test queues. The
    // production singleton rejects durable jobs whenever Redis is unavailable.
    this.allowMemoryFallback = options.allowMemoryFallback ?? !start;
    this.retryBaseDelayMs = Math.max(0, Math.min(10_000, options.retryBaseDelayMs ?? 250));
    this.redis.on("ready", () => { this.redisConnected = true; this.emit("connected", { backend: "redis" }); });
    this.redis.on("end", () => { this.redisConnected = false; });
    this.redis.on("error", () => { this.redisConnected = false; });
    if (start) this.start();
  }

  /** Start Redis consumption only after all job handlers have been registered. */
  start(): void {
    if (this.startRequested) return;
    this.startRequested = true;
    void this.connect(true);
  }

  private scheduleReconnect(start: boolean): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (start) void this.connect(true);
    }, 15_000);
    this.reconnectTimer.unref();
  }

  private async connect(start: boolean): Promise<void> {
    try {
      if (!this.redis.isOpen) await this.redis.connect();
      if (start && !this.worker) {
        this.worker = this.redis.duplicate();
        this.worker.on("error", () => { this.redisConnected = false; });
        await this.worker.connect();
        await this.recoverProcessingJobs();
        void this.consume();
      }
    } catch {
      this.redisConnected = false;
      this.worker = null;
      this.scheduleReconnect(start);
    }
  }

  /** Requeue jobs left in processing after an unclean worker exit. */
  private async recoverProcessingJobs(): Promise<void> {
    const stranded = await this.redis.lRange(PROCESSING_QUEUE, 0, -1);
    for (const payload of stranded) {
      await this.redis.lPush(QUEUE, payload);
      await this.redis.lRem(PROCESSING_QUEUE, 1, payload);
    }
    if (stranded.length) this.emit("recovered", { count: stranded.length });
  }

  private async consume(): Promise<void> {
    while (this.worker?.isReady) {
      try {
        // BRPOPLPUSH atomically claims a job. It remains recoverable until acked.
        const payload = await this.worker.brPopLPush(QUEUE, PROCESSING_QUEUE, 1);
        if (payload) await this.execute(JSON.parse(payload) as QueueJob, payload);
      } catch {
        this.redisConnected = false;
        this.worker = null;
        this.scheduleReconnect(true);
        break;
      }
    }
  }

  registerHandler<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler);
  }

  async enqueue<T>(name: string, data: T, options: { maxAttempts?: number } = {}): Promise<QueueJob<T>> {
    const job: QueueJob<T> = {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name, data, status: "pending", attempts: 0,
      maxAttempts: options.maxAttempts ?? 3, createdAt: Date.now()
    };
    const payload = JSON.stringify(job);
    if (this.redisConnected) {
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
    if (this.processing) return;
    const job = this.memoryQueue.find((candidate) => candidate.status === "pending");
    if (!job) return;
    this.processing = true;
    await this.execute(job);
    if (job.status === "pending") setTimeout(() => void this.processMemory(), 25);
    else void this.processMemory();
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
      this.processing = false;
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
          // Bounded exponential backoff prevents a failing downstream service
          // from causing a tight retry loop. Keep the processing copy until the
          // retry is durably enqueued: crash => recoverable duplicate, not loss.
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
      this.processing = false;
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

  async getStats() {
    let redisPending = 0;
    let redisProcessing = 0;
    let redisDeadLetter = 0;
    if (this.redisConnected) {
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
