import { describe, it, vi } from "vitest";
import { initDeployHelpersContext } from "../src/shared/context";
import { triggersDeploy } from "../src/triggers/deploy";
import type { Config } from "@cloudflare/workers-utils";

vi.mock("@cloudflare/workers-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cloudflare/workers-utils")>()),
	isNonInteractiveOrCI: () => true,
}));

describe("triggersDeploy with only custom domain routes", () => {
	it("does not list zone Workers Routes when workers.dev is already disabled", async ({
		expect,
	}) => {
		const fetchListResult = vi.fn(async () => {
			throw new Error("No access to the specified resource.");
		});
		const fetchResult = vi.fn(
			async (_config: Config, path: string, init?: RequestInit) => {
				if (path.endsWith("/subdomain")) {
					return { enabled: false, previews_enabled: false };
				}
				if (path.includes("/domains/changeset")) {
					return { added: [], removed: [], updated: [], conflicting: [] };
				}
				if (path.endsWith("/domains/records") && init?.method === "PUT") {
					return {};
				}
				throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
			}
		);

		initDeployHelpersContext({
			createCloudflareClient: (() => ({
				workers: {
					beta: {
						workers: {
							get: async () => ({
								subdomain: { enabled: false, previews_enabled: false },
							}),
						},
					},
				},
			})) as never,
			logger: { debug() {}, info() {}, warn() {}, log() {}, error() {} },
			fetchResult: fetchResult as never,
			fetchListResult: fetchListResult as never,
			fetchPagedListResult: (() => {}) as never,
			fetchKVGetValue: (() => {}) as never,
			confirm: (() => {}) as never,
			prompt: (() => {}) as never,
			select: (() => {}) as never,
		});

		await triggersDeploy({
			config: {
				workers_dev: false,
				preview_urls: false,
				queues: { producers: [], consumers: [] },
				workflows: [],
			} as unknown as Config,
			accountId: "some-account-id",
			scriptName: "my-worker",
			crons: undefined,
			routes: [{ pattern: "app.example.com", custom_domain: true }],
			firstDeploy: false,
			dryRun: false,
			validated: false,
		});

		expect(fetchListResult).not.toHaveBeenCalled();
	});
});
