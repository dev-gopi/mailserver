const test = require("node:test");
const assert = require("node:assert/strict");
const { TaskQueue } = require("../dist/queue/task-queue");

test("memory queue executes handlers and retries failures", async () => {
  const queue = new TaskQueue(false);
  let attempts = 0;
  queue.registerHandler("demo", async (job) => {
    attempts++;
    if (attempts < 2) throw new Error("retry");
    return job.data.value * 2;
  });
  const completed = new Promise((resolve) => queue.once("completed", resolve));
  const job = await queue.enqueue("demo", { value: 21 }, { maxAttempts: 2 });
  const result = await completed;
  assert.equal(result.result, 42);
  assert.equal(result.attempts, 2);
  assert.equal(job.id, result.id);
});
