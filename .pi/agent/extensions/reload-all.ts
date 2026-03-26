import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { requestReloadForOtherInteractiveSessions } from "./reload-coordinator";

export default function reloadAllExtension(pi: ExtensionAPI) {
	pi.registerCommand("reload-all", {
		description: "Reload all active pi sessions on this host, including the current one",
		handler: async (_args, ctx) => {
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
		},
	});
}
