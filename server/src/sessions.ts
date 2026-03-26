import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { watch, type FSWatcher } from "fs";

// MARK: - Types

export interface RegistryEntry {
  pid: number;
  cwd: string;
  sessionFile: string;
  sessionId: string;
  sessionName?: string;
  model?: { provider: string; id: string };
  startedAt: string;
  lastSeenAt: string;
  mode: string;
  workSummary?: string;
  workSummaryUpdatedAt?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  lastMessageRole?: string;
}

export interface SessionMessage {
  role: string;
  content: unknown[];
  toolName?: string;
  toolCallId?: string;
  timestamp?: number;
}

// MARK: - Paths

const REGISTRY_DIR = join(
  homedir(),
  ".pi",
  "agent",
  "runtime",
  "instances"
);

// MARK: - Read sessions from registry

export async function listSessions(): Promise<RegistryEntry[]> {
  let files: string[];
  try {
    files = await readdir(REGISTRY_DIR);
  } catch {
    return [];
  }

  const entries: RegistryEntry[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json") || file.includes("-messages")) continue;
    try {
      const raw = await readFile(join(REGISTRY_DIR, file), "utf-8");
      entries.push(JSON.parse(raw));
    } catch {
      // skip corrupt/unreadable files
    }
  }
  return entries;
}

// MARK: - Read messages from JSONL session file

export async function getMessages(
  sessionFile: string
): Promise<SessionMessage[]> {
  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf-8");
  } catch {
    return [];
  }

  const messages: SessionMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "message" && obj.message) {
        messages.push(obj.message);
      }
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

// MARK: - Derive last assistant text

export async function getLastAssistantText(
  sessionFile: string
): Promise<string | null> {
  const messages = await getMessages(sessionFile);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const textParts: string[] = [];
    for (const block of msg.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as any).type === "text" &&
        "text" in block
      ) {
        textParts.push((block as any).text);
      }
    }
    if (textParts.length > 0) return textParts.join("\n");
  }
  return null;
}

// MARK: - Get state from registry entry

export async function getState(
  sessionId: string
): Promise<RegistryEntry | null> {
  const sessions = await listSessions();
  return sessions.find((s) => s.sessionId === sessionId) ?? null;
}

// MARK: - Watch for changes

export type ChangeCallback = () => void;

export function watchRegistry(callback: ChangeCallback): FSWatcher | null {
  try {
    return watch(REGISTRY_DIR, { persistent: false }, () => callback());
  } catch {
    return null;
  }
}

export function watchSessionFile(
  sessionFile: string,
  callback: ChangeCallback
): FSWatcher | null {
  try {
    return watch(sessionFile, { persistent: false }, () => callback());
  } catch {
    return null;
  }
}
