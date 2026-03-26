import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const SERVICE_NAME = "pimux2000";

export function installServer(port: number = 7749) {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitFile = join(unitDir, `${SERVICE_NAME}.service`);

  // Resolve the server entry point relative to this file
  const serverEntry = join(import.meta.dir, "index.ts");

  // Find bun binary
  let bunPath: string;
  try {
    bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {
    console.error("Error: bun not found in PATH");
    process.exit(1);
  }

  const unit = `[Unit]
Description=pimux2000 server
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} run ${serverEntry}
Environment=PIMUX2000_PORT=${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitFile, unit);
  console.log(`Wrote ${unitFile}`);

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync(`systemctl --user enable --now ${SERVICE_NAME}`, {
      stdio: "inherit",
    });
    console.log(`${SERVICE_NAME} service enabled and started`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to enable service: ${msg}`);
    console.log(`You can manually enable it with:`);
    console.log(`  systemctl --user enable --now ${SERVICE_NAME}`);
  }
}

export function uninstallServer() {
  try {
    execSync(`systemctl --user disable --now ${SERVICE_NAME}`, {
      stdio: "inherit",
    });
  } catch {
    // may not be running
  }

  const unitFile = join(
    homedir(),
    ".config",
    "systemd",
    "user",
    `${SERVICE_NAME}.service`
  );

  try {
    const { unlinkSync } = require("fs");
    unlinkSync(unitFile);
    console.log(`Removed ${unitFile}`);
  } catch {
    // may not exist
  }

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  } catch {
    // best effort
  }

  console.log(`${SERVICE_NAME} service removed`);
}
