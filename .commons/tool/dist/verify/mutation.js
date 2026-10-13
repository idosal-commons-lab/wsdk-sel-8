// A green check constrains a change only if breaking the changed code makes its tests fail. Mutate just the diff's
// lines, in just the functions whose own code changed, and use the recorded base's function hits, including those in
// dependent packages. Missing coverage is a signal of its own, never a reason to run an unrelated whole suite.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { cowCopy } from "../executor/cow.js";
import { niced, runCommand } from "../executor/checks.js";
import { mapsAt } from "./check.js";
import { workspacePackages } from "./dependents.js";
import { changedFunctions, namedFunctions } from "./interaction.js";
import { checkEnv, recordsDirOf } from "./profile.js";
import { nearestBase } from "./records.js";
import { inPackage } from "./workspace.js";
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const swaps = new Map([
    [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
    [ts.SyntaxKind.LessThanToken, "<="], [ts.SyntaxKind.LessThanEqualsToken, "<"],
    [ts.SyntaxKind.GreaterThanToken, ">="], [ts.SyntaxKind.GreaterThanEqualsToken, ">"],
    [ts.SyntaxKind.AmpersandAmpersandToken, "||"], [ts.SyntaxKind.BarBarToken, "&&"],
]);
function git(repo, args) {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function sourceAt(repo, rev, file) {
    try {
        return git(repo, ["show", `${rev}:./${file}`]);
    }
    catch {
        return null;
    }
}
const isFunction = (n) => (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && !!n.body;
function trivial(fn, expr) {
    const type = fn.type?.kind;
    if (type === ts.SyntaxKind.NumberKeyword || ts.isNumericLiteral(expr))
        return "0";
    if (type === ts.SyntaxKind.StringKeyword || ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
        return '""';
    if (type === ts.SyntaxKind.BooleanKeyword || expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword)
        return "false";
    return "undefined";
}
function candidates(repo, base, head, file) {
    const code = sourceAt(repo, head, file);
    if (code === null)
        return [];
    const before = sourceAt(repo, base, file);
    const names = changedFunctions(before, code, file).names;
    const named = namedFunctions(code, file).functions;
    const positions = new Map([...named].map(([name, f]) => [`${f.start.line}:${f.start.character}`, name]));
    const changed = new Set();
    const diff = git(repo, ["diff", "--relative", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", base, head, "--", file]);
    for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
        for (let i = 0; i < count; i++)
            changed.add(start + i);
    }
    const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
    const groups = [];
    const collect = (fn, name) => {
        const edits = [];
        const add = (node, replacement, operator) => {
            const start = node.getStart(sf), end = node.getEnd();
            const line = sf.getLineAndCharacterOfPosition(start).line + 1;
            const endLine = sf.getLineAndCharacterOfPosition(end - 1).line + 1;
            for (let l = line; l <= endLine; l++)
                if (!changed.has(l))
                    return;
            const original = code.slice(start, end);
            if (original === replacement || edits.some((e) => e.start === start && e.end === end && e.mutant.replacement === replacement))
                return;
            const mutated = code.slice(0, start) + replacement + code.slice(end);
            edits.push({ start, end, code, mutant: { file, function: name, line, endLine, operator, original, replacement,
                    mutatedLine: mutated.split(/\r?\n/)[line - 1], testFiles: [], status: "no-tests" } });
        };
        const walk = (node) => {
            // Nested functions have their own diff/coverage identity. Type syntax carries no runtime behaviour.
            if (isFunction(node) || ts.isTypeNode(node))
                return;
            if (ts.isIfStatement(node) || ts.isWhileStatement(node))
                add(node.expression, `!(${node.expression.getText(sf)})`, "negate-condition");
            if (ts.isConditionalExpression(node))
                add(node.condition, `!(${node.condition.getText(sf)})`, "negate-condition");
            if (ts.isBinaryExpression(node)) {
                const replacement = swaps.get(node.operatorToken.kind);
                if (replacement)
                    add(node.operatorToken, replacement, `${node.operatorToken.getText(sf)} -> ${replacement}`);
            }
            if (ts.isReturnStatement(node) && node.expression)
                add(node.expression, trivial(fn, node.expression), "replace-return");
            if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression))
                add(node, ";", "remove-call");
            if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
                add(node, node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true", "flip-boolean");
            ts.forEachChild(node, walk);
        };
        if (fn.body && !ts.isBlock(fn.body))
            add(fn.body, trivial(fn, fn.body), "replace-return");
        if (fn.body)
            walk(fn.body);
        if (edits.length)
            groups.push(edits);
    };
    const visit = (node) => {
        if (isFunction(node)) {
            const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const name = positions.get(`${p.line}:${p.character}`);
            if (name && names.has(name))
                collect(node, name);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return groups;
}
function testsFor(repo, coverageBase, maps, file, name) {
    if (!coverageBase)
        return [];
    const code = sourceAt(repo, coverageBase, file);
    const fn = code === null ? undefined : namedFunctions(code, file).functions.get(name);
    if (!fn)
        return [];
    const tests = new Set();
    for (const map of maps) {
        const prefix = map.packageDir === "." || map.packageDir === "" ? "" : `${map.packageDir}/`;
        const key = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file;
        for (const test of map.hits[`${key}#${fn.start.line + 1}:${fn.start.character}`] ?? [])
            tests.add(inPackage(map.packageDir, test));
    }
    return [...tests].sort();
}
/**
 * A copy-on-write snapshot of the caller's checkout at `head`, with its installed dependencies and build outputs: a
 * monorepo's tests import their workspace dependencies' builds, which an export of the committed tree does not have
 * (on workers-sdk every unmutated baseline failed that way). The snapshot gets a private Git directory (a linked
 * worktree's `.git` file would point back at the caller's) that reads the caller's objects through alternates, and
 * every tracked file is reset to `head`. Returns the path of `repo` inside the snapshot.
 */
async function headSnapshot(repo, head, dir) {
    const top = git(repo, ["rev-parse", "--show-toplevel"]).trim();
    const prefix = git(repo, ["rev-parse", "--show-prefix"]).trim();
    const objects = git(top, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trim();
    await cowCopy(top, dir);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    git(dir, ["init", "--quiet"]);
    writeFileSync(join(dir, ".git", "objects", "info", "alternates"), `${objects}\n`);
    git(dir, ["read-tree", head]);
    git(dir, ["checkout-index", "--all", "--force"]);
    // An installation linked in from elsewhere stays shared; give the snapshot a private node_modules of links instead,
    // so the trials' caches (vitest's .vite-temp) never land in the caller's installation.
    for (const pkg of [".", ...workspacePackages(dir).map((p) => p.dir)]) {
        const nm = join(dir, pkg, "node_modules");
        let shared;
        try {
            if (!lstatSync(nm).isSymbolicLink())
                continue;
            shared = realpathSync(nm);
        }
        catch {
            continue;
        }
        rmSync(nm);
        mkdirSync(nm);
        for (const entry of readdirSync(shared)) {
            if (entry.startsWith(".") && entry !== ".bin" && entry !== ".pnpm")
                continue;
            const source = join(shared, entry);
            if (entry.startsWith("@") && lstatSync(source).isDirectory()) {
                mkdirSync(join(nm, entry));
                for (const name of readdirSync(source))
                    symlinkSync(snapshotLink(top, dir, join(source, name)), join(nm, entry, name));
            }
            else
                symlinkSync(snapshotLink(top, dir, source), join(nm, entry));
        }
    }
    return prefix ? join(dir, prefix) : dir;
}
/** A link to an installed package: into the snapshot when it is one of the checkout's own workspace packages. */
function snapshotLink(top, dir, source) {
    try {
        const rel = relative(top, realpathSync(source));
        if (rel && !rel.startsWith("..") && existsSync(join(dir, rel)))
            return join(dir, rel);
    }
    catch {
        // dangling: link it as it is
    }
    return source;
}
// The planner helper lives in a separate, marked process group: a hung vitest worker (even one that starts a detached
// child) is reaped by runCommand. Running the helper in-process would leave its 30-minute timeout in force.
async function defaultTests(dir, files, maps, env, timeoutMs) {
    const groups = new Map();
    for (const file of files) {
        const dirs = maps.filter((m) => m.tests.some((t) => inPackage(m.packageDir, t) === file)).map((m) => m.packageDir).sort((a, b) => b.length - a.length);
        const pkg = dirs[0] ?? ".";
        const rel = pkg === "." || pkg === "" ? file : file.slice(pkg.length + 1);
        groups.set(pkg, [...(groups.get(pkg) ?? []), rel]);
    }
    const script = `const { vitestInPackage, readPackage } = await import(${JSON.stringify(new URL("./workspace.js", import.meta.url).href)});
for (const [pkg, files] of ${JSON.stringify([...groups])}) {
  const r = await vitestInPackage(${JSON.stringify(dir)}, readPackage(${JSON.stringify(dir)}, pkg), "run", files, ["--maxWorkers=1"], ${JSON.stringify(env)});
  if (r.code !== 0) { console.error(r.stdout + "\\n" + r.stderr); process.exit(1); }
}`;
    const loader = import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
    const r = await runCommand(niced([process.execPath, ...loader, "--input-type=module", "-e", script]), {
        cwd: dir, timeoutMs, env: Object.fromEntries(Object.entries(env).filter((e) => e[1] !== undefined)),
    });
    if (r.timedOut)
        throw new Error(`test run exceeded ${timeoutMs} ms`);
    if (r.signal || r.code === null)
        throw new Error(`test runner terminated (${r.signal ?? "no exit code"})`);
    return r.code === 0;
}
async function bounded(run, dir, files, timeoutMs) {
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => run(dir, files, controller.signal)),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`test run exceeded ${timeoutMs} ms`);
                    reject(error);
                    controller.abort(error);
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
export async function mutateChange(opts) {
    const max = opts.maxMutants ?? 6, timeoutMs = opts.timeoutMs ?? 60_000;
    if (!Number.isInteger(max) || max < 0)
        throw new Error("maxMutants must be a non-negative integer");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
        throw new Error("timeoutMs must be a positive timer-sized integer");
    const repo = realpathSync(resolve(opts.repo));
    const base = git(repo, ["rev-parse", "--verify", "--end-of-options", `${opts.base}^{commit}`]).trim();
    const head = git(repo, ["rev-parse", "--verify", "--end-of-options", `${opts.head ?? "HEAD"}^{commit}`]).trim();
    const records = opts.recordsDir ?? recordsDirOf(resolve(opts.repo));
    const coverageBase = nearestBase(repo, records, base);
    const maps = coverageBase ? mapsAt(coverageBase, records) : [];
    const files = git(repo, ["diff", "--relative", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=AM", base, head, "--", "."]).split("\0").filter((f) => SOURCE.test(f) && !TEST.test(f) && !/\.d\.[cm]?ts$/.test(f));
    const groups = max ? files.flatMap((file) => candidates(repo, base, head, file)) : [];
    const edits = [];
    // Round robin, so one large function does not consume the entire review budget.
    for (let round = 0; edits.length < max; round++) {
        const next = groups.flatMap((group) => group[round] ? [group[round]] : []);
        if (!next.length)
            break;
        edits.push(...next.slice(0, max - edits.length));
    }
    for (const edit of edits)
        edit.mutant.testFiles = testsFor(repo, coverageBase, maps, edit.mutant.file, edit.mutant.function);
    const covered = edits.filter((e) => e.mutant.testFiles.length);
    if (covered.length) {
        const root = mkdtempSync(join(tmpdir(), "commons-mutants-"));
        const template = join(root, "head");
        const run = opts.runTests
            ? (dir, files) => bounded(opts.runTests, dir, files, timeoutMs)
            : (dir, files) => defaultTests(dir, files, maps, checkEnv(resolve(opts.repo)), timeoutMs);
        // One snapshot; each mutant is written into it, its tests run, and the file is restored: copying a monorepo per
        // mutant took a minute each.
        let snapshot = template;
        const trial = async (files, edit) => {
            const path = edit ? join(snapshot, edit.mutant.file) : null;
            try {
                if (edit && path) {
                    if (!lstatSync(path).isFile())
                        throw new Error("cannot mutate a symlink or non-file");
                    writeFileSync(path, edit.code.slice(0, edit.start) + edit.mutant.replacement + edit.code.slice(edit.end));
                }
                return await run(snapshot, files);
            }
            finally {
                if (edit && path)
                    writeFileSync(path, edit.code);
            }
        };
        try {
            snapshot = await headSnapshot(repo, head, template);
            // Pre-existing failures must not masquerade as killed mutants. One baseline run amortizes setup across them.
            if (!await trial([...new Set(covered.flatMap((e) => e.mutant.testFiles))].sort()))
                throw new Error("unmutated head tests failed; mutation results would be inconclusive");
            for (const edit of covered) {
                try {
                    edit.mutant.status = await trial(edit.mutant.testFiles, edit) ? "survived" : "killed";
                }
                catch (error) {
                    edit.mutant.status = "error";
                    edit.mutant.error = error instanceof Error ? error.message : String(error);
                }
            }
        }
        catch (error) {
            for (const edit of covered) {
                edit.mutant.status = "error";
                edit.mutant.error = error instanceof Error ? error.message : String(error);
            }
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
    const mutants = edits.map((e) => e.mutant);
    const killed = mutants.filter((m) => m.status === "killed"), survived = mutants.filter((m) => m.status === "survived");
    return { base, head, coverageBase, mutants, killed, survived, noTests: mutants.filter((m) => m.status === "no-tests"), errors: mutants.filter((m) => m.status === "error"), score: killed.length + survived.length ? killed.length / (killed.length + survived.length) : null };
}
export function formatMutationReport(report) {
    return [`${report.mutants.length} mutant(s): ${report.killed.length} killed, ${report.survived.length} survived, ${report.noTests.length} no-tests, ${report.errors.length} error; score ${report.score === null ? "n/a" : `${Math.round(report.score * 100)}%`}`,
        ...report.mutants.map((m) => `${m.status} ${m.file}:${m.line} ${m.function}: ${m.operator}\n  ${m.mutatedLine.trim()}${m.error ? `\n  ${m.error}` : ""}`)].join("\n");
}
//# sourceMappingURL=mutation.js.map