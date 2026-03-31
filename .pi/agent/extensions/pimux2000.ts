import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { REGISTRY_DIR, requestReloadForOtherInteractiveSessions } from "./reload-coordinator";

export default function pimux2000Extension(pi: ExtensionAPI) {
	pi.registerCommand("pimux2000", {
		description: "pimux2000 utilities: reload-all, sessions-path",
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/)[0];

			switch (subcommand) {
				case "reload-all": {
					const { requested, interactiveCount, skipped } = await requestReloadForOtherInteractiveSessions(process.pid, {
						reason: "reload-all",
					});

					const parts = ["Reloaded current session"];
					if (requested > 0) {
						parts.push(`queued /reload for ${requested} other active session${requested === 1 ? "" : "s"}`);
					}
					if (interactiveCount === 1) {
						parts.push("no other active interactive sessions found");
					}
					ctx.ui.notify(parts.join("; "), "info");
					if (skipped.length > 0) {
						ctx.ui.notify(`Skipped: ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ", …" : ""}`, "warning");
					}

					await ctx.reload();
					return;
				}

				case "sessions-path": {
					ctx.ui.notify(`Active session registry: ${REGISTRY_DIR}`, "info");
					return;
				}

				default:
					ctx.ui.notify(
						"Usage: /pimux2000 <subcommand>\n" +
						"  reload-all      Reload all active pi sessions\n" +
						"  sessions-path   Show the session registry directory",
						subcommand ? "warning" : "info"
					);
					return;
			}
		},
	});
}

