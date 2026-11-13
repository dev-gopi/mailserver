import net from "net";
import { EventEmitter } from "events";
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

class TaskQueue extends EventEmitter {
  private memoryQueue: QueueJob[] = [];
  private completedJobs: QueueJob[] = [];
  private handlers: Map<string, JobHandler> = new Map();
  private isProcessing = false;
  private redisConnected = false;
  private redisClient: net.Socket | null = null;
  private redisHost: string;
  private redisPort: number;

  constructor() {
    super();
    this.redisHost = process.env.REDIS_HOST || "redis";
    this.redisPort = Number(process.env.REDIS_PORT || 6379);

    // Attempt Redis connection in background
    this.tryConnectRedis();

    // Start background processing loop
    setInterval(() => this.processNext(), 500);
  }

  private tryConnectRedis(): void {
    const socket = new net.Socket();
    socket.setTimeout(2500);

    socket.connect(this.redisPort, this.redisHost, () => {
      this.redisConnected = true;
      this.redisClient = socket;
      this.emit("connected", { backend: "redis", host: this.redisHost, port: this.redisPort });
      // Send PING
      socket.write("*1\r\n$4\r\nPING\r\n");
    });

    socket.on("data", (data) => {
      const resp = data.toString();
      if (resp.includes("PONG")) {
        this.redisConnected = true;
      }
    });

    socket.on("error", () => {
      this.redisConnected = false;
      this.redisClient = null;
    });

    socket.on("close", () => {
      this.redisConnected = false;
      this.redisClient = null;
      // Retry in 15 seconds
      setTimeout(() => this.tryConnectRedis(), 15000);
    });
  }

  public registerHandler<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler);
  }

  public async enqueue<T>(name: string, data: T, options: { maxAttempts?: number } = {}): Promise<QueueJob<T>> {
    const job: QueueJob<T> = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name,
      data,
      status: "pending",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      createdAt: Date.now()
    };

    if (this.redisConnected && this.redisClient) {
      try {
        const payload = JSON.stringify(job);
        // Redis LPUSH mail_tasks <payload>
        const cmd = `*3\r\n$5\r\nLPUSH\r\n$10\r\nmail_tasks\r\n$${Buffer.byteLength(payload)}\r\n${payload}\r\n`;
        this.redisClient.write(cmd);
      } catch {
        // Fallback to memory
        this.memoryQueue.push(job);
      }
    } else {
      this.memoryQueue.push(job);
    }

    this.emit("enqueued", job);
    return job;
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing) return;
    if (this.memoryQueue.length === 0) return;

    const job = this.memoryQueue.find((j) => j.status === "pending");
    if (!job) return;

    const handler = this.handlers.get(job.name);
    if (!handler) {
      job.status = "failed";
      job.error = `No handler registered for task: ${job.name}`;
      return;
    }

    this.isProcessing = true;
    job.status = "processing";
    job.attempts++;

    try {
      const result = await handler(job);
      job.status = "completed";
      job.result = result;
      job.completedAt = Date.now();
      this.emit("completed", job);
    } catch (err: any) {
      if (job.attempts < job.maxAttempts) {
        job.status = "pending"; // will retry
      } else {
        job.status = "failed";
        job.error = err.message || "Execution error";
        this.emit("failed", job);
      }
    } finally {
      this.isProcessing = false;
      // Keep recent 100 finished jobs for status inspection
      if (job.status === "completed" || job.status === "failed") {
        const idx = this.memoryQueue.indexOf(job);
        if (idx !== -1) {
          this.memoryQueue.splice(idx, 1);
          this.completedJobs.unshift(job);
          if (this.completedJobs.length > 100) this.completedJobs.pop();
        }
      }
    }
  }

  public getStats() {
    return {
      backend: this.redisConnected ? "redis" : "memory_resilient",
      redisHost: this.redisHost,
      redisPort: this.redisPort,
      pendingCount: this.memoryQueue.filter((j) => j.status === "pending").length,
      processingCount: this.memoryQueue.filter((j) => j.status === "processing").length,
      completedCount: this.completedJobs.filter((j) => j.status === "completed").length,
      failedCount: this.completedJobs.filter((j) => j.status === "failed").length,
      recentJobs: this.completedJobs.slice(0, 10).map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        attempts: j.attempts,
        createdAt: j.createdAt,
        completedAt: j.completedAt
      }))
    };
  }
}

export const taskQueue = new TaskQueue();
