import checkForUpdate from "update-check";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { fetchLatestNpmVersion } from "../src/update-check";

vi.mock("update-check", () => ({ default: vi.fn() }));

describe("fetchLatestNpmVersion", () => {
	beforeEach(() => {
		vi.mocked(checkForUpdate).mockResolvedValue({
			latest: "4.14.2",
			fromCache: false,
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetAllMocks();
	});

	it("reports an update when the latest version is not deprecated", async ({
		expect,
	}) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ version: "4.14.2" }))
		);
		expect(await fetchLatestNpmVersion("wrangler", "4.14.1")).toEqual({
			status: "update-available",
			latest: "4.14.2",
		});
	});

	it("does not report an update when the latest version is deprecated", async ({
		expect,
	}) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ version: "4.14.2", deprecated: "Do not use" })
				)
		);
		expect(await fetchLatestNpmVersion("wrangler", "4.14.1")).toEqual({
			status: "up-to-date",
		});
	});

	it("still reports an update if the deprecation lookup fails", async ({
		expect,
	}) => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		expect(await fetchLatestNpmVersion("wrangler", "4.14.1")).toEqual({
			status: "update-available",
			latest: "4.14.2",
		});
	});
});
