import { spawn } from "child_process";

// MARK: - Types

interface RPCCommand {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface RPCResult {
  responses: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

// MARK: - Run pi RPC commands

export async function runRPC(
  commands: RPCCommand[],
  cwd?: string
): Promise<RPCResult> {
  const input = commands.map((c) => JSON.stringify(c)).join("\n") + "\n";

  return new Promise((resolve, reject) => {
    const proc = spawn("pi", ["--mode", "rpc"], {
      cwd: cwd ?? undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn pi: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`pi exited with code ${code}: ${stderr.slice(0, 500)}`)
        );
        return;
      }

      const responses: Record<string, unknown>[] = [];
      const events: Record<string, unknown>[] = [];

      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "response") {
            responses.push(obj);
          } else {
            events.push(obj);
          }
        } catch {
          // skip non-JSON lines
        }
      }

      resolve({ responses, events });
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// MARK: - High-level: send prompt to a session

let rpcRequestCounter = 0;

function nextId(): string {
  return `srv-${++rpcRequestCounter}`;
}

export async function sendPrompt(
  sessionFile: string,
  message: string,
  cwd?: string
): Promise<RPCResult> {
  return runRPC(
    [
      { id: nextId(), type: "switch_session", sessionPath: sessionFile },
      { id: nextId(), type: "prompt", message },
    ],
    cwd
  );
}
