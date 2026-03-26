#!/usr/bin/env bun

import { installServer, uninstallServer } from "./install";

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "install-server": {
    const portArg = args.find((a) => a.startsWith("--port="));
    const port = portArg ? parseInt(portArg.split("=")[1], 10) : 7749;
    installServer(port);
    break;
  }

  case "uninstall-server":
    uninstallServer();
    break;

  case "serve": {
    // Run the server directly (foreground)
    await import("./index");
    break;
  }

  default:
    console.log(`pimux2000 - pi session server for iOS

Usage:
  pimux2000 install-server [--port=7749]   Install as systemd user service
  pimux2000 uninstall-server               Remove systemd service
  pimux2000 serve                          Run server in foreground
`);
    if (command && command !== "help" && command !== "--help") {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
