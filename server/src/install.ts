import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { execSync } from "child_process";

const SERVICE_NAME = "pimux2000";
const isMac = platform() === "darwin";

function findBun(): string {
  try {
    return execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {
    console.error("Error: bun not found in PATH");
    process.exit(1);
  }
}

// MARK: - Install

export function installServer(port: number = 7749) {
  const bunPath = findBun();
  const serverEntry = join(import.meta.dir, "index.ts");

  if (isMac) {
    installLaunchd(bunPath, serverEntry, port);
  } else {
    installSystemd(bunPath, serverEntry, port);
  }
}

// MARK: - Uninstall

export function uninstallServer() {
  if (isMac) {
    uninstallLaunchd();
  } else {
    uninstallSystemd();
  }
}

// MARK: - Restart

export function restartServer() {
  if (isMac) {
    const label = `com.pimux2000.server`;
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/${label}`, {
        stdio: "inherit",
      });
      console.log(`${SERVICE_NAME} restarted`);
    } catch {
      console.error("Failed to restart. Is the service installed?");
    }
  } else {
    try {
      execSync(`systemctl --user restart ${SERVICE_NAME}`, {
        stdio: "inherit",
      });
      console.log(`${SERVICE_NAME} restarted`);
    } catch {
      console.error("Failed to restart. Is the service installed?");
    }
  }
}

// MARK: - macOS launchd

const LAUNCHD_LABEL = "com.pimux2000.server";

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function installLaunchd(bunPath: string, serverEntry: string, port: number) {
  const plistPath = launchdPlistPath();
  const logPath = join(homedir(), "Library", "Logs", `${SERVICE_NAME}.log`);

  // Capture the current PATH so pi/node/bun are all findable at runtime
  const currentPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${serverEntry}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PIMUX2000_PORT</key>
    <string>${port}</string>
    <key>PATH</key>
    <string>${currentPath}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;

  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist);
  console.log(`Wrote ${plistPath}`);

  try {
    // Unload first in case it's already loaded
    execSync(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL} 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {
    // may not be loaded
  }

  try {
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, {
      stdio: "inherit",
    });
    console.log(`${SERVICE_NAME} service loaded and started`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load service: ${msg}`);
    console.log(`You can manually load it with:`);
    console.log(`  launchctl bootstrap gui/$(id -u) ${plistPath}`);
  }
}

function uninstallLaunchd() {
  try {
    execSync(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, {
      stdio: "inherit",
    });
  } catch {
    // may not be loaded
  }

  const plistPath = launchdPlistPath();
  try {
    unlinkSync(plistPath);
    console.log(`Removed ${plistPath}`);
  } catch {
    // may not exist
  }

  console.log(`${SERVICE_NAME} service removed`);
}

// MARK: - Linux systemd

function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function installSystemd(bunPath: string, serverEntry: string, port: number) {
  const unitPath = systemdUnitPath();

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

  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unitPath, unit);
  console.log(`Wrote ${unitPath}`);

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync(`systemctl --user enable --now ${SERVICE_NAME}`, {
      stdio: "inherit",
    });
    console.log(`${SERVICE_NAME} service enabled and started`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to enable service: ${msg}`);
    console.log(`  systemctl --user enable --now ${SERVICE_NAME}`);
  }
}

function uninstallSystemd() {
  try {
    execSync(`systemctl --user disable --now ${SERVICE_NAME}`, {
      stdio: "inherit",
    });
  } catch {
    // may not be running
  }

  try {
    unlinkSync(systemdUnitPath());
    console.log(`Removed ${systemdUnitPath()}`);
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
