import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	assertNoCloudflareBuildOutput,
	findCloudflareBuildOutput,
} from "../../deploy/cloudflare-build-output";

describe("Cloudflare Build Output detection", () => {
	const dirs: string[] = [];
	function tmp() {
		const d = mkdtempSync(path.join(tmpdir(), "cf-build-output-"));
		dirs.push(d);
		return d;
	}
	afterEach(() => {
		for (const d of dirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("detects .cloudflare/output using platform path handling", ({ expect }) => {
		const dir = tmp();
		mkdirSync(path.join(dir, ".cloudflare", "output"), { recursive: true });
		expect(findCloudflareBuildOutput(dir)).toBe(
			path.join(dir, ".cloudflare", "output")
		);
		expect(() => assertNoCloudflareBuildOutput(dir)).toThrowError(
			/cf deploy/
		);
	});

	it("ignores ordinary projects", ({ expect }) => {
		const dir = tmp();
		writeFileSync(path.join(dir, "wrangler.toml"), "name='a'");
		expect(findCloudflareBuildOutput(dir)).toBeUndefined();
		expect(() => assertNoCloudflareBuildOutput(dir)).not.toThrow();
	});

	it("ignores a .cloudflare/output that is a file or in an unrelated directory", ({
		expect,
	}) => {
		const dir = tmp();
		mkdirSync(path.join(dir, ".cloudflare"));
		writeFileSync(path.join(dir, ".cloudflare", "output"), "");
		expect(findCloudflareBuildOutput(dir)).toBeUndefined();
		const other = tmp();
		expect(findCloudflareBuildOutput(path.join(other, "sub"))).toBeUndefined();
	});
});
