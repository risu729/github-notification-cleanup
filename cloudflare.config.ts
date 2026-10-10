import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "github-notification-cleanup",
    compatibilityDate: "2026-08-04",
    entrypoint: "src/index.ts",
    workersDev: false,
    previewUrls: false,
    observability: {
      logs: {
        enabled: true,
      },
      traces: {
        enabled: true,
      },
    },
    triggers: [
      triggers.scheduled({
        schedule: "*/5 * * * *",
      }),
      triggers.queue({
        deadLetterQueue: "github-notification-cleanup-failures",
        maxBatchSize: 10,
        maxBatchTimeout: 5,
        maxRetries: 7,
        name: "github-notification-cleanup-notifications",
      }),
      triggers.queue({
        maxBatchSize: 10,
        maxBatchTimeout: 5,
        maxRetries: 7,
        name: "github-notification-cleanup-failures",
        retryDelay: 600,
      }),
    ],
    env: {
      DEAD_LETTER_QUEUE_NAME: bindings.text("github-notification-cleanup-failures"),
      GH_TOKEN: bindings.secret(),
      DB: bindings.d1({
        name: "github-notification-cleanup",
        id: "1a52ac9d-62e6-40b7-93c8-31ec58e49075",
      }),
      NOTIFICATION_QUEUE: bindings.queue({
        name: "github-notification-cleanup-notifications",
      }),
    },
  },
});
