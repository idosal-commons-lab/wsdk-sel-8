import { statSync } from "node:fs";
import path from "node:path";
import { UserError } from "@cloudflare/workers-utils";

/** Location of Cloudflare Build Output, relative to the project root. */
const BUILD_OUTPUT_SEGMENTS = [".cloudflare", "output"] as const;

/**
 * Returns the path of the Cloudflare Build Output directory in `projectDir`,
 * or `undefined` if there is none.
 */
export function findCloudflareBuildOutput(
	projectDir: string
): string | undefined {
	const candidate = path.join(path.resolve(projectDir), ...BUILD_OUTPUT_SEGMENTS);
	try {
		return statSync(candidate).isDirectory() ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Throws a `UserError` if `projectDir` contains Cloudflare Build Output,
 * which must be deployed with `cf` rather than Wrangler.
 * This performs no remote calls, and never prompts, so it behaves
 * identically in interactive, non-interactive and `--json` modes.
 */
export function assertNoCloudflareBuildOutput(projectDir: string): void {
	const found = findCloudflareBuildOutput(projectDir);
	if (found !== undefined) {
		throw new UserError(
			`Found Cloudflare Build Output at "${found}".\n` +
				"This output cannot be deployed with Wrangler. Deploy it with the `cf` command instead:\n\n" +
				"  cf deploy\n\n" +
				"See https://developers.cloudflare.com/workers/ for more information.",
			{ telemetryMessage: "deploy cloudflare build output detected" }
		);
	}
}
