// Checks are part of the acceptance boundary, not evidence an incoming change may silently rewrite. Compare the
// submitted trees, never the worktree or a cached test verdict: a green run after deleting a test proves nothing.
import ts from "typescript";
import { changedFiles, showFile } from "../executor/git.js";
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CONFIG = /(^|\/)(vitest|jest)(?:\.[^/]+)?\.config\.(?:[cm]?[jt]s|json)$/;
const ROOTS = new Set(["it", "test", "describe", "xit", "xtest", "xdescribe"]);
const MODIFIERS = new Set(["skip", "only", "todo", "skipIf", "fails"]);
function parse(code, file) {
    const kind = file.endsWith(".json") ? ts.ScriptKind.JSON : /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
}
function property(n) {
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n))
        return n.text;
    if (ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression))
        return n.expression.text;
    return null;
}
function unwrap(n) {
    while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n))
        n = n.expression;
    return n;
}
function constants(sf) {
    const out = new Map();
    // Top-level constants only: resolving arbitrary local bindings without a checker would mistake shadowed names.
    for (const st of sf.statements)
        if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
            for (const d of st.declarationList.declarations)
                if (ts.isIdentifier(d.name) && d.initializer)
                    out.set(d.name.text, d.initializer);
        }
    return out;
}
function resolve(n, vars, seen = new Set()) {
    n = unwrap(n);
    if (ts.isIdentifier(n) && vars.has(n.text) && !seen.has(n.text))
        return resolve(vars.get(n.text), vars, new Set([...seen, n.text]));
    return n;
}
function chain(n, aliases) {
    n = unwrap(n);
    if (ts.isIdentifier(n))
        return { root: aliases.get(n.text) ?? n.text, members: [] };
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const member = ts.isPropertyAccessExpression(n) ? n.name.text : property(n.argumentExpression);
        if (!member)
            return null;
        const c = chain(n.expression, aliases);
        if (!c)
            return null;
        // Namespace imports and globals such as vitest.test / jest.it.
        if (c.members.length === 0 && (ROOTS.has(member) || c.root === "<framework>" && member === "expect"))
            return { root: member, members: [] };
        return { ...c, members: [...c.members, member] };
    }
    if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
        const c = chain(ts.isCallExpression(n) ? n.expression : n.tag, aliases);
        if (!c)
            return null;
        return { ...c, ...(c.members.at(-1) === "each" ? { each: ts.isCallExpression(n) ? n.arguments[0] : n.template } : {}) };
    }
    return null;
}
function eachCount(c, vars) {
    if (!c.each)
        return 1;
    const n = resolve(c.each, vars);
    const rows = (n, seen = new Set()) => {
        n = resolve(n, vars);
        if (!ts.isArrayLiteralExpression(n) || seen.has(n))
            return 1;
        return n.elements.reduce((sum, el) => sum + (ts.isSpreadElement(el) ? rows(el.expression, new Set([...seen, n])) : 1), 0);
    };
    if (ts.isArrayLiteralExpression(n))
        return rows(n);
    // A tagged table has a header and one row per nonempty line. Expressions are placeholders, not executable cases.
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const table = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => "value" + s.literal.text).join("") : n.text;
        return Math.max(0, table.split(/\r?\n/).filter((line) => line.trim()).length - 1);
    }
    return 1; // Runtime-generated data is unknowable here; count the registration, not guessed executions.
}
function testStats(code, file) {
    const sf = parse(code, file);
    const vars = constants(sf);
    const aliases = new Map();
    for (const st of sf.statements)
        if (ts.isImportDeclaration(st) && st.importClause && !st.importClause.isTypeOnly) {
            const assertionModule = ts.isStringLiteral(st.moduleSpecifier) && /^(node:)?assert(?:\/strict)?$/.test(st.moduleSpecifier.text);
            const frameworkModule = ts.isStringLiteral(st.moduleSpecifier) && /^(vitest|@jest\/globals)$/.test(st.moduleSpecifier.text);
            if (assertionModule && st.importClause.name)
                aliases.set(st.importClause.name.text, "assert");
            const bindings = st.importClause.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings) && (frameworkModule || assertionModule))
                aliases.set(bindings.name.text, assertionModule ? "assert" : "<framework>");
            if (bindings && ts.isNamedImports(bindings))
                for (const el of bindings.elements)
                    if (!el.isTypeOnly)
                        aliases.set(el.name.text, assertionModule ? "assert" : el.propertyName?.text ?? el.name.text);
        }
    const stats = { cases: 0, suites: 0, assertions: 0, modifiers: new Map() };
    const add = (modifier, context) => {
        const key = `${modifier} in ${context.join(" > ") || "<file>"}`;
        stats.modifiers.set(key, (stats.modifiers.get(key) ?? 0) + 1);
    };
    const visit = (n, weight, context) => {
        if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
            const c = chain(n, aliases);
            if (c && ROOTS.has(c.root) && MODIFIERS.has(c.members.at(-1) ?? ""))
                add(`${c.root}.${c.members.at(-1)}`, context);
        }
        if (ts.isCallExpression(n)) {
            const c = chain(n.expression, aliases);
            // Builder calls (each(rows), skipIf(condition)) feed another call. Count only the final registration.
            let outer = n;
            while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent) || ts.isNonNullExpression(outer.parent))
                outer = outer.parent;
            const p = outer.parent;
            const builder = (ts.isCallExpression(p) || ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === outer;
            if (c && ROOTS.has(c.root) && !builder) {
                const count = eachCount(c, vars) * weight;
                context = [...context, n.arguments[0] ? value(n.arguments[0], sf, vars) : "<unnamed>"];
                if (c.root.includes("describe"))
                    stats.suites += count;
                else
                    stats.cases += count;
                if (c.root.startsWith("x"))
                    add(c.root, context);
                // Parameterized suites multiply the leaf cases inside them too.
                if (c.root.includes("describe"))
                    weight = count;
            }
            if (c?.root === "expect" && (c.members.length === 0 || c.members.length === 1 && ["soft", "poll", "assertions", "hasAssertions"].includes(c.members[0])))
                stats.assertions++;
            else if (c?.root === "assert")
                stats.assertions++; // node:assert's equal/ok/strictEqual/etc.
        }
        ts.forEachChild(n, (child) => visit(child, weight, context));
    };
    visit(sf, 1, []);
    return stats;
}
// Print AST values without comments so formatting and commented-out options cannot change the gate. Resolve simple
// constants as well: replacing the value behind `exclude: excluded` must be visible even if that property is intact.
const printer = ts.createPrinter({ removeComments: true });
function value(n, sf, vars) {
    const seen = new Set();
    const transformed = ts.transform(n, [(ctx) => {
            const visit = (node) => {
                if (ts.isFunctionExpression(node) || ts.isArrowFunction(node))
                    return node; // No guessed bindings in local scopes.
                if (ts.isShorthandPropertyAssignment(node) && vars.has(node.name.text)) {
                    return ts.factory.createPropertyAssignment(node.name, ts.visitNode(node.name, visit));
                }
                const p = node.parent;
                const key = p && ((ts.isPropertyAssignment(p) || ts.isPropertyAccessExpression(p)) && p.name === node);
                if (ts.isIdentifier(node) && !key && vars.has(node.text) && !seen.has(node.text)) {
                    seen.add(node.text);
                    const replacement = ts.visitNode(unwrap(vars.get(node.text)), visit);
                    seen.delete(node.text);
                    return replacement;
                }
                // Quotes, comments and whitespace do not change a literal's meaning. Nested constants in spreads do:
                // `exclude: [...ignored]` must see a change to ignored even when the option's own syntax is unchanged.
                if (ts.isStringLiteral(node))
                    return ts.factory.createStringLiteral(node.text);
                return ts.visitEachChild(node, visit, ctx);
            };
            return (root) => ts.visitNode(unwrap(root), visit);
        }]);
    try {
        return printer.printNode(ts.EmitHint.Expression, transformed.transformed[0], sf);
    }
    finally {
        transformed.dispose();
    }
}
function configStats(code, file) {
    const sf = parse(code, file);
    const vars = constants(sf);
    const out = new Map();
    const add = (key, v) => out.set(key, [...(out.get(key) ?? []), v]);
    const thresholds = (n, prefix, seen = new Set()) => {
        n = resolve(n, vars);
        if (ts.isObjectLiteralExpression(n) && !seen.has(n)) {
            const next = new Set([...seen, n]);
            for (const p of n.properties)
                if (ts.isPropertyAssignment(p))
                    thresholds(p.initializer, `${prefix}.${property(p.name) ?? p.name.getText(sf)}`, next);
                else if (ts.isShorthandPropertyAssignment(p))
                    thresholds(p.name, `${prefix}.${p.name.text}`, next);
                else if (ts.isSpreadAssignment(p))
                    thresholds(p.expression, prefix, next);
        }
        else
            add(prefix, value(n, sf, vars));
    };
    const option = (key, n) => {
        if (key === "include" || key === "exclude" || key === "testNamePattern" || key === "passWithNoTests")
            add(key, value(n, sf, vars));
        if (key === "coverageThreshold" || key === "thresholds")
            thresholds(n, key);
    };
    const visit = (n) => {
        if (ts.isPropertyAssignment(n))
            option(property(n.name), n.initializer);
        if (ts.isShorthandPropertyAssignment(n))
            option(n.name.text, n.name);
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))) {
            option(ts.isPropertyAccessExpression(n.left) ? n.left.name.text : property(n.left.argumentExpression), n.right);
            const c = chain(n.left, new Map());
            const threshold = c?.members.findIndex((m) => m === "thresholds" || m === "coverageThreshold") ?? -1;
            if (c && threshold >= 0 && threshold < c.members.length - 1)
                add(c.members.slice(threshold).join("."), value(n.right, sf, vars));
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}
function configChanges(before, after, file) {
    if (after === null)
        return ["test configuration deleted"];
    const a = configStats(before ?? "", file);
    const b = configStats(after, file);
    const changes = [];
    for (const key of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(key) ?? [];
        const y = b.get(key) ?? [];
        if (JSON.stringify(x) === JSON.stringify(y))
            continue;
        if (key === "passWithNoTests") {
            if (y.some((v) => v !== "false"))
                changes.push("passWithNoTests enabled or changed to a computed value");
        }
        else if (key.startsWith("thresholds.") || key.startsWith("coverageThreshold.")) {
            // Positive thresholds are minimum percentages; negative Jest thresholds are maximum uncovered counts.
            const weaker = (old, current) => !Number.isFinite(Number(current)) ||
                (Number(old) >= 0 ? Number(current) < Number(old) : Number(current) < Number(old) || Number(current) >= 0);
            const weakened = x.some((v, i) => y[i] === undefined || weaker(v, y[i])) ||
                y.slice(x.length).some((v) => x.some((old) => weaker(old, v))); // A later duplicate/assignment can override a strong value.
            if (weakened)
                changes.push(`${key} lowered or removed (${x.join(", ")} -> ${y.join(", ") || "absent"})`);
        }
        else
            changes.push(`${key} changed (may exclude tests)`);
    }
    return changes;
}
/** CLI-friendly, read-only findings for exactly base..head. No allow policy or test execution is hidden here. */
export async function gateFindings(repo, base, head) {
    const files = await changedFiles(repo, base, head);
    const findings = [];
    const sourceChanged = files.some((f) => SOURCE.test(f.path) && !TEST.test(f.path) && !CONFIG.test(f.path));
    for (const f of files) {
        const add = (kind, message, severity = "block") => findings.push({ severity, kind, path: f.path, message });
        if (f.path.endsWith(".snap")) {
            if (sourceChanged)
                add("snapshot-update", "snapshot updated together with source; review the expected output", "note");
            continue;
        }
        if (!(SOURCE.test(f.path) && TEST.test(f.path)) && !CONFIG.test(f.path) && !/(^|\/)package\.json$/.test(f.path))
            continue;
        const [before, after] = await Promise.all([showFile(repo, base, f.path), showFile(repo, head, f.path)]);
        if (CONFIG.test(f.path)) {
            for (const message of configChanges(before, after, f.path))
                add("test-config", message);
        }
        else if (/(^|\/)package\.json$/.test(f.path)) {
            const a = before === null ? {} : JSON.parse(before).scripts ?? {};
            const b = after === null ? {} : JSON.parse(after).scripts ?? {};
            for (const key of ["test", "test:ci"])
                if (a[key] !== b[key])
                    add("test-script", `${key} script changed (${a[key] ?? "absent"} -> ${b[key] ?? "absent"})`);
        }
        else if (after === null)
            add("deleted-test", "test file deleted; restore it");
        else {
            const a = testStats(before ?? "", f.path);
            const b = testStats(after, f.path);
            if (b.cases < a.cases || b.suites < a.suites)
                add("test-count", `test count decreased (cases ${a.cases} -> ${b.cases}, suites ${a.suites} -> ${b.suites}); restore the removed cases`);
            for (const [modifier, count] of b.modifiers)
                if (count > (a.modifiers.get(modifier) ?? 0))
                    add("test-modifier", `added ${modifier} (${a.modifiers.get(modifier) ?? 0} -> ${count}); restore normal test execution`);
            if (b.assertions < a.assertions && b.cases <= a.cases)
                add("assertion-count", `expect/assert calls decreased (${a.assertions} -> ${b.assertions}) without more test cases; restore the assertions`);
        }
    }
    return findings;
}
/** Shared submission policy and message for MCP, executors and future hosting checks. Findings remain reviewable
 * even when the task explicitly permits them; a blank reason or a directive embedded in another line is no waiver. */
export async function testChangeGate(repo, base, head, taskBody = "") {
    const findings = await gateFindings(repo, base, head);
    const hasBlock = findings.some((f) => f.severity === "block");
    // Executors only need the coordinator round trip for findings that require an exception, never a second diff.
    const body = typeof taskBody === "function" ? hasBlock ? await taskBody() : "" : taskBody;
    const allowReason = /^COMMONS-ALLOW-TEST-CHANGES:[ \t]*(\S[^\r\n]*)$/m.exec(body)?.[1]?.trim() ?? null;
    const blocked = !allowReason && hasBlock;
    return {
        findings,
        allowReason,
        message: blocked ? `Test-change gate refused this commit:\n${findings.map((f) => `- ${f.severity}: ${f.path}: ${f.kind}: ${f.message}`).join("\n")}\nRestore the named checks and commit the fix. Intentional test changes require COMMONS-ALLOW-TEST-CHANGES: <reason> on its own line in the task body.` : null,
    };
}
//# sourceMappingURL=gate.js.map