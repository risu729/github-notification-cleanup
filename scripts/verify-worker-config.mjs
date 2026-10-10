import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import testConfig from "../test/wrangler.jsonc";

const worker = JSON.parse(
  readFileSync(".cloudflare/output/v0/workers/default/worker.config.json", "utf8"),
);

// The current Vitest pool reads Wrangler configuration. Fail the build if its
// runtime fixture drifts from the cf configuration that will be deployed.
assert.equal(worker.name, testConfig.name);
assert.equal(worker.compatibilityDate, testConfig.compatibility_date);
assert.deepEqual(worker.compatibilityFlags ?? [], testConfig.compatibility_flags ?? []);
assert.equal(worker.workersDev, testConfig.workers_dev);
assert.equal(worker.previewUrls, testConfig.preview_urls);
assert.deepEqual(worker.observability, testConfig.observability);
assert.deepEqual(
  worker.triggers
    .filter((trigger) => trigger.type === "scheduled")
    .map((trigger) => trigger.schedule),
  testConfig.triggers.crons,
);

const queueKeys = {
  queue: "name",
  dead_letter_queue: "deadLetterQueue",
  max_batch_size: "maxBatchSize",
  max_batch_timeout: "maxBatchTimeout",
  max_retries: "maxRetries",
  retry_delay: "retryDelay",
};
assert.deepEqual(
  worker.triggers.filter((trigger) => trigger.type === "queue"),
  testConfig.queues.consumers.map((consumer) => ({
    type: "queue",
    ...Object.fromEntries(Object.entries(consumer).map(([key, value]) => [queueKeys[key], value])),
  })),
);
assert.deepEqual(
  worker.env,
  Object.fromEntries([
    ...Object.entries(testConfig.vars).map(([name, value]) => [name, { type: "text", value }]),
    ...testConfig.secrets.required.map((name) => [name, { type: "secret" }]),
    ...testConfig.d1_databases.map((database) => [
      database.binding,
      { type: "d1", name: database.database_name, id: database.database_id },
    ]),
    ...testConfig.queues.producers.map((producer) => [
      producer.binding,
      { type: "queue", name: producer.queue },
    ]),
  ]),
);
console.log("Validated production and test runtime configuration parity.");
