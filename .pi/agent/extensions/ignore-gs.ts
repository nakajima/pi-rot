import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const IGNORED_INPUT = "gs";

export default function ignoreGsExtension(pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		if (event.source !== "interactive") {
			return { action: "continue" };
		}

		if ((event.images?.length ?? 0) > 0) {
			return { action: "continue" };
		}

		if (event.text.trim() !== IGNORED_INPUT) {
			return { action: "continue" };
		}

		return { action: "handled" };
	});
}
