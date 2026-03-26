import {
  listSessions,
  getMessages,
  getLastAssistantText,
  getState,
  watchRegistry,
  watchSessionFile,
  summarizeMissingSessions,
  type ChangeCallback,
} from "./sessions";
import { sendPrompt } from "./rpc";
import type { ServerWebSocket } from "bun";
import type { FSWatcher } from "fs";

// MARK: - Config

const PORT = parseInt(process.env.PIMUX2000_PORT ?? "7749", 10);

// MARK: - Types

interface ClientMessage {
  id?: string;
  type: string;
  sessionId?: string;
  sessionFile?: string;
  message?: string;
  cwd?: string;
}

interface WSData {
  sessionWatchers: Map<string, FSWatcher>;
}

// MARK: - Connected clients

const clients = new Set<ServerWebSocket<WSData>>();

// MARK: - Server

const server = Bun.serve<WSData>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    const upgraded = server.upgrade(req, {
      data: { sessionWatchers: new Map() },
    });
    if (upgraded) return undefined;

    return new Response("Expected WebSocket", { status: 400 });
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(
        `Client connected (${clients.size} total)`
      );
    },

    async message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }

      try {
        await handleMessage(ws, msg);
      } catch (err: unknown) {
        const error =
          err instanceof Error ? err.message : "Unknown error";
        ws.send(
          JSON.stringify({
            type: "error",
            id: msg.id,
            command: msg.type,
            error,
          })
        );
      }
    },

    close(ws) {
      clients.delete(ws);
      // Clean up session file watchers for this client
      for (const watcher of ws.data.sessionWatchers.values()) {
        watcher.close();
      }
      ws.data.sessionWatchers.clear();
      console.log(
        `Client disconnected (${clients.size} total)`
      );
    },
  },
});

// MARK: - Message handler

async function handleMessage(
  ws: ServerWebSocket<WSData>,
  msg: ClientMessage
) {
  switch (msg.type) {
    case "list_sessions": {
      const sessions = await listSessions();
      ws.send(
        JSON.stringify({
          type: "sessions",
          id: msg.id,
          data: sessions,
        })
      );

      // Generate summaries in background for sessions that lack one
      summarizeMissingSessions(sessions, () => {
        broadcastSessionsDebounced();
      });
      break;
    }

    case "get_messages": {
      if (!msg.sessionFile) {
        throw new Error("sessionFile required");
      }
      const messages = await getMessages(msg.sessionFile);
      ws.send(
        JSON.stringify({
          type: "messages",
          id: msg.id,
          sessionFile: msg.sessionFile,
          data: messages,
        })
      );

      // Set up a file watcher for this session if not already watching
      if (!ws.data.sessionWatchers.has(msg.sessionFile)) {
        const watcher = watchSessionFile(msg.sessionFile, async () => {
          try {
            const updated = await getMessages(msg.sessionFile!);
            ws.send(
              JSON.stringify({
                type: "messages_updated",
                sessionFile: msg.sessionFile,
                data: updated,
              })
            );
          } catch {
            // file may have been removed
          }
        });
        if (watcher) {
          ws.data.sessionWatchers.set(msg.sessionFile, watcher);
        }
      }
      break;
    }

    case "get_state": {
      if (!msg.sessionId) {
        throw new Error("sessionId required");
      }
      const state = await getState(msg.sessionId);
      ws.send(
        JSON.stringify({
          type: "state",
          id: msg.id,
          sessionId: msg.sessionId,
          data: state,
        })
      );
      break;
    }

    case "get_last_assistant_text": {
      if (!msg.sessionFile) {
        throw new Error("sessionFile required");
      }
      const text = await getLastAssistantText(msg.sessionFile);
      ws.send(
        JSON.stringify({
          type: "last_assistant_text",
          id: msg.id,
          sessionFile: msg.sessionFile,
          text,
        })
      );
      break;
    }

    case "prompt": {
      if (!msg.sessionFile) throw new Error("sessionFile required");
      if (!msg.message) throw new Error("message required");

      const result = await sendPrompt(
        msg.sessionFile,
        msg.message,
        msg.cwd
      );
      ws.send(
        JSON.stringify({
          type: "prompt_complete",
          id: msg.id,
          sessionFile: msg.sessionFile,
          events: result.events,
          responses: result.responses,
        })
      );
      break;
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// MARK: - Debounced session broadcast

let sessionsBroadcastDebounce: ReturnType<typeof setTimeout> | null = null;

function broadcastSessionsDebounced() {
  if (sessionsBroadcastDebounce) clearTimeout(sessionsBroadcastDebounce);
  sessionsBroadcastDebounce = setTimeout(async () => {
    try {
      const sessions = await listSessions();
      const payload = JSON.stringify({
        type: "sessions_updated",
        data: sessions,
      });
      for (const client of clients) {
        client.send(payload);
      }
    } catch {
      // ignore
    }
  }, 2000);
}

// MARK: - Registry watcher → broadcast session updates

let registryDebounce: ReturnType<typeof setTimeout> | null = null;

watchRegistry(() => {
  if (registryDebounce) clearTimeout(registryDebounce);
  registryDebounce = setTimeout(async () => {
    try {
      const sessions = await listSessions();
      const payload = JSON.stringify({
        type: "sessions_updated",
        data: sessions,
      });
      for (const client of clients) {
        client.send(payload);
      }
    } catch {
      // ignore
    }
  }, 300);
});

console.log(`pimux2000 server listening on ws://0.0.0.0:${PORT}`);
