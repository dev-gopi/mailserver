import { EventEmitter } from "events";
import { createClient } from "redis";

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

export class TaskQueue extends EventEmitter {
  private readonly memoryQueue: QueueJob[] = [];
  private readonly completedJobs: QueueJob[] = [];
  private readonly handlers = new Map<string, JobHandler>();
  private readonly redis = createClient({
    socket: { host: process.env.REDIS_HOST || "redis", port: Number(process.env.REDIS_PORT || 6379), reconnectStrategy: () => false }
  });
  private worker: any = null;
  private redisConnected = false;
  private processing = false;

  constructor(start = true) {
    super();
    this.redis.on("ready", () => { this.redisConnected = true; this.emit("connected", { backend: "redis" }); });
    this.redis.on("end", () => { this.redisConnected = false; });
    this.redis.on("error", () => { this.redisConnected = false; });
    void this.connect(start);
  }

  private async connect(start: boolean) {
    try {
      await this.redis.connect();
      if (start) {
        this.worker = this.redis.duplicate();
        await this.worker.connect();
        void this.consume();
      }
    } catch {
      this.redisConnected = false;
      if (start) setInterval(() => void this.connect(true), 15000).unref();
    }
  }

  private async consume() {
    while (this.worker?.isReady) {
      try {
        const item = await this.worker.brPop(QUEUE, 1);
        if (item) await this.execute(JSON.parse(item.element) as QueueJob);
      } catch {
        this.redisConnected = false;
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
      try { await this.redis.lPush(QUEUE, payload); }
      catch { this.memoryQueue.push(job); }
    } else this.memoryQueue.push(job);
    this.emit("enqueued", job);
    if (!this.redisConnected) void this.processMemory();
    return job;
  }

  private async processMemory() {
    if (this.processing) return;
    const job = this.memoryQueue.find((candidate) => candidate.status === "pending");
    if (!job) return;
    await this.execute(job);
    if (job.status === "pending") setTimeout(() => void this.processMemory(), 25);
    else void this.processMemory();
  }

  private async execute(job: QueueJob) {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      job.status = "failed";
      job.error = `No handler registered for task: ${job.name}`;
      this.finishMemory(job);
      return;
    }
    this.processing = true;
    job.status = "processing";
    job.attempts++;
    try {
      job.result = await handler(job);
      job.status = "completed";
      job.completedAt = Date.now();
      this.emit("completed", job);
    } catch (error: any) {
      if (job.attempts < job.maxAttempts) job.status = "pending";
      else {
        job.status = "failed";
        job.error = error?.message || "Execution error";
        this.emit("failed", job);
      }
    } finally {
      this.processing = false;
      this.finishMemory(job);
    }
  }

  private finishMemory(job: QueueJob) {
    if (job.status === "completed" || job.status === "failed") {
      const index = this.memoryQueue.indexOf(job);
      if (index >= 0) this.memoryQueue.splice(index, 1);
      this.completedJobs.unshift(job);
      if (this.completedJobs.length > 100) this.completedJobs.pop();
    }
  }

  async getStats() {
    let redisPending = 0;
    if (this.redisConnected) {
      try { redisPending = await this.redis.lLen(QUEUE); } catch { /* health is reported below */ }
    }
    return {
      backend: this.redisConnected ? "redis" : "memory_resilient",
      redisHost: process.env.REDIS_HOST || "redis",
      redisPort: Number(process.env.REDIS_PORT || 6379),
      pendingCount: this.memoryQueue.filter((j) => j.status === "pending").length + redisPending,
      processingCount: this.memoryQueue.filter((j) => j.status === "processing").length,
      completedCount: this.completedJobs.filter((j) => j.status === "completed").length,
      failedCount: this.completedJobs.filter((j) => j.status === "failed").length,
      recentJobs: this.completedJobs.slice(0, 10).map(({ id, name, status, attempts, createdAt, completedAt }) =>
        ({ id, name, status, attempts, createdAt, completedAt }))
    };
  }
}

export const taskQueue = new TaskQueue();
