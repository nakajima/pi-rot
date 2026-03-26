import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { watch, type FSWatcher } from "fs";
import { spawn } from "child_process";

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
      const entry: RegistryEntry = JSON.parse(raw);

      // Use cached summary if registry doesn't have one
      if (!entry.workSummary && entry.sessionFile) {
        const cached = summaryCache.get(entry.sessionFile);
        if (cached) entry.workSummary = cached.summary;
      }

      entries.push(entry);
    } catch {
      // skip corrupt/unreadable files
    }
  }
  return entries;
}

// Kick off background summarization for sessions missing workSummary.
// Calls onComplete with the sessionFile and summary when each one finishes.
export function summarizeMissingSessions(
  entries: RegistryEntry[],
  onComplete: (sessionFile: string, summary: string) => void
): void {
  for (const entry of entries) {
    if (entry.workSummary || !entry.sessionFile) continue;
    const sessionFile = entry.sessionFile;

    // Already in-flight or cached
    if (summaryCache.has(sessionFile) || summarizeInFlight.has(sessionFile))
      continue;

    summarizeInFlight.add(sessionFile);
    deriveWorkSummary(sessionFile).then((summary) => {
      summarizeInFlight.delete(sessionFile);
      if (summary) onComplete(sessionFile, summary);
    });
  }
}

const summarizeInFlight = new Set<string>();

// MARK: - Derive a summary from the first user message in the session file

// MARK: - LLM-based summary generation

// Resolve paths at startup — launchd has a minimal PATH
const BUN_BIN = process.execPath; // we're already running under bun
const PI_SCRIPT = join(homedir(), ".bun", "bin", "pi");

const summaryCache = new Map<
  string,
  { summary: string; messageCount: number }
>();

async function deriveWorkSummary(
  sessionFile: string
): Promise<string | undefined> {
  const messages = await getMessages(sessionFile);
  if (messages.length === 0) return undefined;

  const cached = summaryCache.get(sessionFile);
  if (cached && cached.messageCount === messages.length) {
    return cached.summary;
  }

  const summary = await summarizeWithPi(messages);
  if (summary) {
    summaryCache.set(sessionFile, { summary, messageCount: messages.length });
  }
  return summary;
}

async function summarizeWithPi(
  messages: SessionMessage[]
): Promise<string | undefined> {
  const recent = messages.slice(-20);
  const transcript = recent
    .map((m) => {
      const text = extractText(m.content);
      if (!text) return null;
      const truncated =
        text.length > 300 ? text.slice(0, 300) + "..." : text;
      return `${m.role}: ${truncated}`;
    })
    .filter(Boolean)
    .join("\n");

  if (!transcript.trim()) return undefined;

  const prompt = `Summarize what this coding session is working on in a single short phrase (under 60 chars). No quotes, no punctuation at the end, no emojis. Just the topic.\n\n${transcript}`;

  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: string | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const proc = spawn(
      BUN_BIN,
      [PI_SCRIPT, "-p", "--no-session", "--model", "anthropic/claude-haiku-4-5", prompt],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    // pi -p prints the answer then may hang; give it 15s then take what we have
    const timeout = setTimeout(() => {
      const text = stdout.trim();
      if (text) done(text);
      else done(undefined);
      proc.kill();
    }, 15_000);

    proc.on("error", () => {
      clearTimeout(timeout);
      done(undefined);
    });
    proc.on("close", () => {
      clearTimeout(timeout);
      const text = stdout.trim();
      done(text || undefined);
    });
  });
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      const text = (block.text as string).trim();
      if (text) parts.push(text);
    }
  }
  return parts.join(" ") || undefined;
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
