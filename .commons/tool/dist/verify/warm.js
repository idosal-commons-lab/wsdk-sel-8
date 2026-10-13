// A worktree-local socket owns a bounded LRU of package runners. Each runner has its own process: NODE_OPTIONS must
// apply at startup, and configs/global setup must see the same cwd and environment as the cold package command.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const WARM_IDLE_MS = 15 * 60 * 1000;
export const WARM_MAX_INSTANCES = 4;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_LIMIT = 1024 * 1024;
const modulePath = fileURLToPath(import.meta.url);
const message = (error) => error instanceof Error ? error.message : String(error);
const rootOf = (root) => realpathSync(resolve(root));
/** Hash the actual worktree path, not its shared git directory; keep the socket below Unix's short path limit. */
export function warmSocketPath(root) {
    return join(tmpdir(), `commons-warm-${createHash("sha256").update(rootOf(root)).digest("hex").slice(0, 20)}.sock`);
}
function launchArgs(args) {
    // Source checkouts use tsx; compiled distributions run plain ESM. Resolve from Commons, not the target package.
    return [...(modulePath.endsWith(".ts") ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] : []), modulePath, ...args];
}
function exchange(path, request, timeoutMs = RUN_TIMEOUT_MS) {
    return new Promise((done, reject) => {
        const socket = createConnection(path);
        socket.setEncoding("utf8");
        let output = "";
        const fail = (error) => { socket.destroy(); reject(error); };
        socket.setTimeout(timeoutMs, () => fail(new Error("warm server timed out")));
        socket.on("error", fail);
        socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk) => {
            output += chunk;
            if (output.length > OUTPUT_LIMIT * 6)
                return fail(new Error("warm response too large"));
            const end = output.indexOf("\n");
            if (end < 0)
                return;
            try {
                const reply = JSON.parse(output.slice(0, end));
                socket.destroy();
                done(reply);
            }
            catch (error) {
                fail(new Error(message(error)));
            }
        });
        socket.on("close", () => reject(new Error("warm server disconnected")));
    });
}
const starting = new Map();
async function ensureServer(root, path) {
    let pending = starting.get(path);
    if (!pending) {
        pending = (async () => {
            const child = spawn(process.execPath, launchArgs(["--serve", root]), { cwd: root, detached: true, stdio: "ignore" });
            let failure;
            child.on("error", (error) => { failure = error; });
            child.unref();
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                if (failure)
                    throw failure;
                try {
                    await exchange(path, { ping: true }, 500);
                    return;
                }
                catch { /* another starter may win the bind */ }
                if (child.exitCode !== null)
                    throw new Error("warm server did not start");
                await new Promise((r) => setTimeout(r, 50));
            }
            child.kill("SIGTERM");
            throw new Error("warm server did not become ready");
        })().finally(() => starting.delete(path));
        starting.set(path, pending);
    }
    await pending;
}
/** Null means transport/API failure: the caller uses its unchanged cold command. A failed test is still a result. */
export async function warmRun(root, request) {
    try {
        const path = warmSocketPath(root);
        if (!existsSync(path)) {
            if (request.env.COMMONS_WARM !== "1")
                return null;
            await ensureServer(rootOf(root), path);
        }
        const reply = await exchange(path, request);
        if (reply.error || !reply.result || ![0, 1].includes(reply.result.code)
            || typeof reply.result.stdout !== "string" || typeof reply.result.stderr !== "string")
            return null;
        return reply.result;
    }
    catch {
        // A crashed process can leave a socket behind. Auto-start also recovers this case, but never retries a test run.
        if (request.env.COMMONS_WARM === "1") {
            try {
                await ensureServer(rootOf(root), warmSocketPath(root));
            }
            catch { /* cold remains available */ }
        }
        return null;
    }
}
function packageRunner(cwd, request) {
    const child = spawn(process.execPath, launchArgs(["--worker"]), { cwd, env: request.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.on("error", () => { }); // the pending run handles a spawn error, including errors before IPC becomes ready
    let stdout = "", stderr = "", overflow = false, outputReady = () => { };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { overflow ||= stdout.length + chunk.length > OUTPUT_LIMIT; stdout = (stdout + chunk).slice(-OUTPUT_LIMIT); outputReady(); });
    child.stderr.on("data", (chunk) => { overflow ||= stderr.length + chunk.length > OUTPUT_LIMIT; stderr = (stderr + chunk).slice(-OUTPUT_LIMIT); outputReady(); });
    return {
        child,
        key: JSON.stringify([request.args, Object.entries(request.env).sort(([a], [b]) => a.localeCompare(b))]),
        run: (req) => new Promise((done, reject) => {
            stdout = "";
            stderr = "";
            overflow = false;
            let finished = false, reply;
            const finish = (reply, error) => {
                if (finished)
                    return;
                finished = true;
                outputReady = () => { };
                clearTimeout(timer);
                child.off("message", onMessage);
                child.off("exit", onExit);
                child.off("error", onError);
                if (error)
                    reject(error);
                else if (overflow)
                    done({ error: "warm output exceeded capture limit" }); // cold preserves every failing name
                else
                    done(reply.result ? { result: { ...reply.result, stdout, stderr } } : { error: reply.error });
            };
            outputReady = () => {
                if (!reply?.outputEnd || !stdout.includes(reply.outputEnd) || !stderr.includes(reply.outputEnd))
                    return;
                stdout = stdout.slice(0, stdout.indexOf(reply.outputEnd));
                stderr = stderr.slice(0, stderr.indexOf(reply.outputEnd));
                finish(reply);
            };
            const onMessage = (value) => { reply = value; outputReady(); };
            const onExit = () => finish(undefined, new Error("warm package runner exited"));
            const onError = (error) => finish(undefined, error);
            const timer = setTimeout(() => { child.kill("SIGKILL"); onExit(); }, RUN_TIMEOUT_MS);
            child.once("message", onMessage);
            child.once("exit", onExit);
            child.once("error", onError);
            if (!child.connected)
                return onExit();
            child.send(req, (error) => { if (error)
                onError(error); });
        }),
        close: () => new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null)
                return done();
            const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
            child.once("exit", () => { clearTimeout(timer); done(); });
            child.kill("SIGTERM");
        }),
    };
}
export async function serveWarm(root, opts = {}) {
    root = rootOf(root);
    const path = warmSocketPath(root), idleMs = opts.idleMs ?? WARM_IDLE_MS, cap = opts.maxInstances ?? WARM_MAX_INSTANCES;
    if (!Number.isSafeInteger(idleMs) || idleMs < 1 || !Number.isSafeInteger(cap) || cap < 1)
        throw new Error("warm idle timeout and instance cap must be positive integers");
    const runners = new Map(), sockets = new Set();
    let queue = Promise.resolve(), idle, closing, stopped = false, pending = 0;
    let resolveClosed;
    const closed = new Promise((r) => { resolveClosed = r; });
    const armIdle = () => { clearTimeout(idle); if (!stopped && pending === 0)
        idle = setTimeout(() => void close(), idleMs); };
    const execute = async (req) => {
        if (stopped)
            throw new Error("warm server stopping");
        const cwd = realpathSync(resolve(root, req.dir));
        const rel = relative(root, cwd);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new Error("package is outside worktree");
        const key = JSON.stringify([req.args, Object.entries(req.env).sort(([a], [b]) => a.localeCompare(b))]);
        let runner = runners.get(cwd);
        if (runner && runner.key !== key) {
            runners.delete(cwd);
            await runner.close();
            runner = undefined;
        }
        if (!runner) {
            if (runners.size >= cap) {
                const [dir, oldest] = runners.entries().next().value;
                runners.delete(dir);
                await oldest.close();
            }
            if (stopped)
                throw new Error("warm server stopping"); // SIGTERM can arrive while eviction awaits teardown
            runner = packageRunner(cwd, req);
        }
        runners.delete(cwd);
        runners.set(cwd, runner);
        try {
            const reply = await runner.run(req);
            if (reply.error) {
                runners.delete(cwd);
                await runner.close();
            }
            return reply;
        }
        catch (error) {
            runners.delete(cwd);
            await runner.close();
            throw error;
        }
    };
    const server = createServer((socket) => {
        socket.setEncoding("utf8");
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => { });
        let input = "", handled = false;
        socket.setTimeout(RUN_TIMEOUT_MS, () => socket.destroy());
        socket.on("data", (chunk) => {
            if (handled)
                return;
            input += chunk;
            if (input.length > OUTPUT_LIMIT) {
                socket.destroy();
                return;
            }
            const end = input.indexOf("\n");
            if (end < 0)
                return;
            handled = true;
            let req;
            try {
                req = JSON.parse(input.slice(0, end));
                if (!req || typeof req !== "object" || (!("ping" in req) && (typeof req.dir !== "string"
                    || !Array.isArray(req.args) || !req.args.every((arg) => typeof arg === "string")
                    || !Array.isArray(req.files) || !req.files.every((file) => typeof file === "string")
                    || !req.env || typeof req.env !== "object")))
                    throw new Error("invalid warm request");
            }
            catch {
                socket.end(`${JSON.stringify({ error: "invalid warm request" })}\n`);
                return;
            }
            if ("ping" in req) {
                socket.end(`${JSON.stringify({ pid: process.pid, instances: [...runners].map(([dir, runner]) => ({ dir, pid: runner.child.pid })) })}\n`);
                return;
            }
            clearTimeout(idle);
            pending++;
            // Requests are serialized, including eviction: process-global setup and per-run output never overlap.
            queue = queue.then(async () => {
                let reply;
                try {
                    reply = await execute(req);
                }
                catch (error) {
                    reply = { error: message(error) };
                }
                if (!socket.destroyed)
                    socket.end(`${JSON.stringify(reply)}\n`);
            }).finally(() => { pending--; armIdle(); });
        });
    });
    async function close() {
        if (closing)
            return closing;
        stopped = true;
        clearTimeout(idle);
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        closing = (async () => {
            for (const socket of sockets)
                socket.destroy();
            await Promise.all([...runners.values()].map((runner) => runner.close()));
            await new Promise((done) => server.close(() => done()));
            resolveClosed();
        })();
        return closing;
    }
    const stop = () => { void close(); };
    const listen = () => new Promise((done, reject) => {
        const fail = (error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", fail); done(); };
        server.once("error", fail);
        server.once("listening", ready);
        server.listen(path);
    });
    try {
        await listen();
    }
    catch (error) {
        if (error.code !== "EADDRINUSE")
            throw error;
        try {
            await exchange(path, { ping: true }, 500);
            throw new Error("warm server already running");
        }
        catch (probe) {
            if (!["ECONNREFUSED", "ENOENT"].includes(probe.code ?? ""))
                throw probe;
            try {
                unlinkSync(path);
            }
            catch (e) {
                if (e.code !== "ENOENT")
                    throw e;
            }
            await listen();
        }
    }
    chmodSync(path, 0o600);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    armIdle();
    return { path, closed, close };
}
function fingerprint(file) {
    try {
        return createHash("sha256").update(readFileSync(file)).digest("hex");
    }
    catch {
        return "missing";
    }
}
function verdict(ctx, specs) {
    // State retains other files across requests: inspect only this selection, never a previous run's passes/failures.
    // A completed module alone is insufficient (a benchmark/custom runner can collect tests without executing them).
    let ran = 0, failed = ctx.state.getUnhandledErrors().length > 0;
    for (const spec of specs) {
        const module = spec.testModule;
        if (!module || !["passed", "failed", "skipped"].includes(module.state()))
            throw new Error(`warm module did not finish: ${spec.moduleId}`);
        failed ||= module.state() === "failed" || module.errors().length > 0;
        for (const test of module.children.allTests()) {
            const result = test.result();
            if (result.state === "pending")
                throw new Error(`warm test did not run: ${test.fullName}`);
            // Declared, filtered and dynamic skips are terminal Vitest results, not missing execution.
            if (result.state === "passed" || result.state === "failed")
                ran++;
            failed ||= result.state === "failed";
        }
    }
    if (!ran)
        throw new Error("warm run executed no tests"); // let the cold CLI decide empty/all-skipped policy
    // Preserve CLI failures outside test results (e.g. snapshots/coverage), but never let exitCode hide failed tests.
    return failed || process.exitCode ? 1 : 0;
}
async function worker() {
    // Resolve the target's installed version and plugins, never the Commons runner's version for another repository.
    const require = createRequire(join(process.cwd(), "package.json"));
    const api = await import(pathToFileURL(require.resolve("vitest/node")).href);
    let ctx, hashes = new Map(), configs = new Map();
    const loaded = () => {
        const files = new Set();
        for (const vite of new Set([ctx.vite, ...ctx.projects.map((project) => project.vite)])) {
            for (const file of vite.moduleGraph.fileToModulesMap.keys())
                files.add(file);
            for (const environment of Object.values(vite.environments ?? {})) {
                for (const file of environment.moduleGraph.fileToModulesMap.keys())
                    files.add(file);
            }
        }
        return files;
    };
    const stop = async () => { await ctx?.close(); process.exit(0); };
    process.on("SIGTERM", () => { void stop(); });
    process.on("disconnect", () => { void stop(); });
    process.on("message", async (req) => {
        let reply;
        try {
            process.exitCode = 0;
            const { options, filter } = api.parseCLI([...req.args, ...req.files]);
            if (options.watch)
                throw new Error("warm requests must run once");
            if ([...configs].some(([file, hash]) => fingerprint(file) !== hash)) {
                await ctx.close();
                ctx = undefined;
                hashes.clear();
                configs.clear();
            }
            if (!ctx) {
                // Vitest 4 requires the mode argument; Vitest 5 still supports it. Passing options first to v4 silently
                // selects its benchmark runner: ordinary tests are collected but left pending and exitCode stays zero.
                ctx = await api.createVitest("test", { ...options, watch: false }, {}, { packageInstaller: {
                        ensureInstalled: async () => false,
                        isPackageExists: (name) => { try {
                            require.resolve(name);
                            return true;
                        }
                        catch {
                            return false;
                        } },
                    } });
                const all = [ctx.vite, ...ctx.projects.map((p) => p.vite)];
                for (const vite of all) {
                    for (const file of vite.config.configFileDependencies)
                        configs.set(file, fingerprint(file));
                    if (vite.config.configFile)
                        configs.set(vite.config.configFile, fingerprint(vite.config.configFile));
                }
                // Global setup is retained by Vitest. Recreate if it changes, so a cached setup never supplies stale state.
                for (const project of new Set([ctx.getRootProject(), ...ctx.projects])) {
                    for (const file of project.config.globalSetup)
                        configs.set(file, fingerprint(file));
                }
            }
            for (const file of loaded()) {
                const hash = fingerprint(file);
                if (hashes.get(file) !== hash) {
                    ctx.invalidateFile(file);
                    ctx.watcher.invalidates.add(file); // also clear evaluated modules in workers with isolate=false
                }
                hashes.set(file, hash);
            }
            ctx.clearSpecificationsCache();
            // start() clears related/changed after a run; restore the CLI selection for every request.
            ctx.config.related = typeof options.related === "string" ? [options.related] : options.related;
            ctx.config.changed = options.changed ?? false;
            const specs = await ctx.getRelevantTestSpecifications(filter);
            // Clear this selection before execution so even a runner that drops a module cannot reuse an old verdict.
            for (const spec of specs)
                ctx.state.clearFiles(spec.project, [spec.moduleId]);
            await ctx.start(filter);
            const code = verdict(ctx, specs);
            for (const file of loaded())
                if (!hashes.has(file))
                    hashes.set(file, fingerprint(file));
            // The server-side graph contains global setup and its imports, including the unselected root project.
            // Invalidation alone cannot rerun retained setup; recreate the context when any of these modules changes.
            for (const vite of new Set([ctx.vite, ...ctx.projects.map((project) => project.vite)])) {
                for (const file of vite.environments.__vitest__?.moduleGraph.fileToModulesMap.keys() ?? [])
                    configs.set(file, fingerprint(file));
            }
            reply = { result: { code, stdout: "", stderr: "" } };
        }
        catch (error) {
            reply = { error: message(error) };
        }
        // IPC and pipes can arrive in either order. The parent waits for both markers before returning the result.
        reply.outputEnd = `\u0000commons-warm-${randomUUID()}\u0000`;
        await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write(reply.outputEnd, () => done()))));
        process.send(reply);
    });
}
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
    const start = process.argv[2] === "--worker" ? worker() : serveWarm(process.argv[3]).then((server) => server.closed);
    start.catch((error) => { process.stderr.write(`${message(error)}\n`); process.exit(1); });
}
//# sourceMappingURL=warm.js.map