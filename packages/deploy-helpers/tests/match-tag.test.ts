import { COMPLIANCE_REGION_CONFIG_UNKNOWN } from "@cloudflare/workers-utils";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { verifyWorkerMatchesCITag } from "../src/deploy/helpers/match-tag";
import { fetchResult } from "../src/shared/context";

vi.mock("../src/shared/context", () => ({
	fetchResult: vi.fn(),
	logger: { debug: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));

describe("verifyWorkerMatchesCITag", () => {
	beforeEach(() => {
		vi.stubEnv("WRANGLER_CI_MATCH_TAG", "abc123");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
		vi.mocked(fetchResult).mockResolvedValue({
			default_environment: { script: { tag: "abc123" } },
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("honours the legacy CF_ACCOUNT_ID variable", async ({ expect }) => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined as unknown as string);
		delete process.env.CLOUDFLARE_ACCOUNT_ID;
		vi.stubEnv("CF_ACCOUNT_ID", "some-account-id");
		await expect(
			verifyWorkerMatchesCITag(
				COMPLIANCE_REGION_CONFIG_UNKNOWN,
				"some-account-id",
				"my-worker",
				undefined
			)
		).resolves.toBeUndefined();
	});

	it("prefers CLOUDFLARE_ACCOUNT_ID over CF_ACCOUNT_ID", async ({ expect }) => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "some-account-id");
		vi.stubEnv("CF_ACCOUNT_ID", "other-account-id");
		await expect(
			verifyWorkerMatchesCITag(
				COMPLIANCE_REGION_CONFIG_UNKNOWN,
				"some-account-id",
				"my-worker",
				undefined
			)
		).resolves.toBeUndefined();
	});
});
