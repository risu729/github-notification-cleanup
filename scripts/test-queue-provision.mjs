import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "queue-provision-test-"));
try {
  mkdirSync(join(directory, "bin"));
  writeFileSync(join(directory, "mise.toml"), '[task_config]\nincludes = ["tasks.toml"]\n');
  writeFileSync(join(directory, "tasks.toml"), readFileSync("tasks.toml"));
  const executable = join(directory, "bin", "bun");
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(["run", "cf", "queues", "list"])) {
  console.log(process.env.QUEUE_INVENTORY);
  process.exit(Number(process.env.INVENTORY_EXIT));
}
if (args.slice(0, 5).join(" ") === "run cf queues create --queue-name") {
  appendFileSync(process.env.CREATE_LOG, args[5] + "\\n");
  process.exit(Number(process.env.CREATE_EXIT));
}
throw new Error("Unexpected command: " + args.join(" "));
`,
  );
  chmodSync(executable, 0o755);
  const environment = {
    ...process.env,
    PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_API_TOKEN: "test-token",
    CREATE_LOG: join(directory, "created.txt"),
    MISE_TRUSTED_CONFIG_PATHS: directory,
  };
  const primary = "github-notification-cleanup-notifications";
  const deadLetter = "github-notification-cleanup-failures";
  const cases = [
    {
      name: "both queues exist",
      inventory: [{ queue_name: primary }, { queue_name: deadLetter }],
      created: [],
    },
    { name: "both queues missing", inventory: [], created: [primary, deadLetter] },
    { name: "one queue missing", inventory: [{ queue_name: primary }], created: [deadLetter] },
    {
      name: "similar names are distinct",
      inventory: [{ queue_name: primary + "-other" }],
      created: [primary, deadLetter],
    },
    { name: "invalid JSON", inventory: "invalid-json", created: [], fails: true },
    { name: "invalid inventory shape", inventory: {}, created: [], fails: true },
    { name: "inventory request fails", inventory: [], inventoryExit: 1, created: [], fails: true },
    { name: "creation fails", inventory: [], createExit: 1, created: [primary], fails: true },
  ];
  for (const scenario of cases) {
    writeFileSync(environment.CREATE_LOG, "");
    const result = spawnSync("mise", ["run", "worker:provision"], {
      cwd: directory,
      env: {
        ...environment,
        QUEUE_INVENTORY:
          typeof scenario.inventory === "string"
            ? scenario.inventory
            : JSON.stringify(scenario.inventory),
        INVENTORY_EXIT: String(scenario.inventoryExit ?? 0),
        CREATE_EXIT: String(scenario.createExit ?? 0),
      },
      encoding: "utf8",
    });
    assert.equal(
      result.status === 0,
      !scenario.fails,
      `${scenario.name}: ${result.stdout} ${result.stderr}`,
    );
    const created = readFileSync(environment.CREATE_LOG, "utf8").trim().split("\n").filter(Boolean);
    assert.deepEqual(created, scenario.created, scenario.name);
    console.log(`Queue provisioning via mise passed: ${scenario.name}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
