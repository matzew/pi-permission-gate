import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decide } from "../rules.ts";

const project = mkdtempSync(join(tmpdir(), "pg-project-"));
const home = mkdtempSync(join(tmpdir(), "pg-home-"));
const ctx = { cwd: project, home };

// Task 1: bash rules
{
  const allow = (c: string) => assert.deepEqual(decide("bash", { command: c }, ctx), { kind: "allow" }, c);
  const ask = (c: string, reason: string) => assert.deepEqual(decide("bash", { command: c }, ctx), { kind: "ask", reason }, c);

  test("read-only commands run without asking", () => {
    for (const c of ["ls -la", "git status", "git log --oneline -5", "git branch", "git remote -v",
      "oc get pods -n foo", "kubectl logs deploy/x", "grep -rn foo . | head -20", "oc whoami"]) allow(c);
  });
  test("chained, redirected or substituted commands ask", () => {
    for (const c of ["ls; rm -rf x", "git status && git push", "ls || true", "echo hi > f", "cat < f",
      "cat $(which ls)", "ls `id`", "ls &", "ls\nrm x", 'grep "a|b" f']) ask(c, "runs a shell command");
  });
  test("other and excluded commands ask", () => {
    for (const c of ["rm -rf build", "git push", "git branch -D x", "git -C x status", "oc delete pod x",
      "npm test", "go test ./...", "env", "printenv", "FOO=1 ls", "find . -delete", "find . -exec rm {} +",
      "oc get secret x -o yaml", "kubectl get pods,secrets", "oc whoami -t", "git diff --output=x",
      "echo $ENMAAS_API_TOKEN"]) ask(c, "runs a shell command");
  });
  test("commands touching credentials ask with their own reason", () => {
    for (const c of ["cat ~/.ssh/id_ed25519", "cat $HOME/Claude_Credentials/x", `ls ${home}/.kube`,
      "cat .env", "ls .config/gh"]) ask(c, "command touches credentials");
  });
}

// Task 2: file and other tool rules
{
  const d = (tool: string, input: unknown, c = ctx) => decide(tool, input, c);
  symlinkSync(mkdtempSync(join(tmpdir(), "pg-out-")), join(project, "link-out"));

  test("read asks only for credentials", () => {
    assert.deepEqual(d("read", { path: "src/a.ts" }), { kind: "allow" });
    for (const p of ["~/.ssh/id_rsa", join(home, ".pi/agent/auth.json"), ".env.local"])
      assert.deepEqual(d("read", { path: p }), { kind: "ask", reason: "reads credentials" }, p);
  });
  test("write and edit are free inside the project only", () => {
    for (const tool of ["write", "edit"]) {
      assert.deepEqual(d(tool, { path: "src/a.ts" }), { kind: "allow" });
      for (const p of ["/tmp/x", "../other/f", join(home, ".zshrc"), "link-out/f"])
        assert.deepEqual(d(tool, { path: p }), { kind: "ask", reason: "writes outside the project folder" }, p);
      assert.deepEqual(d(tool, { path: ".git/config" }), { kind: "ask", reason: "modifies Git internals" });
      assert.deepEqual(d(tool, { path: "~/.kube/config" }), { kind: "ask", reason: "writes to credentials" });
    }
  });
  test("home and root are never a project folder", () => {
    for (const cwd of [home, "/"])
      assert.deepEqual(d("write", { path: "f" }, { ...ctx, cwd }), { kind: "ask", reason: "writes outside the project folder" });
  });
  test("other tools and malformed input ask", () => {
    assert.deepEqual(d("mcp__x__y", {}), { kind: "ask", reason: "uses tool mcp__x__y" });
    assert.deepEqual(d("bash", {}), { kind: "ask", reason: "unexpected input for bash" });
    assert.deepEqual(d("write", { path: 7 }), { kind: "ask", reason: "unexpected input for write" });
  });
}

// Task 3: Pi wiring
{
  type Handler = (event: { toolName: string; input: unknown }, c: unknown) => Promise<unknown>;
  async function load(): Promise<Handler> {
    const handlers: Record<string, Handler> = {};
    const { default: extension } = await import("../index.ts") as { default: (pi: unknown) => void };
    extension({ on: (name: string, fn: Handler) => { handlers[name] = fn; } });
    return handlers["tool_call"];
  }
  const uiCtx = (choice: string, hasUI = true) => {
    const state = { calls: 0 };
    return { ctx: { cwd: project, hasUI, ui: { select: async () => { state.calls++; return choice; } } }, state };
  };

  test("allowed calls pass without prompting", async () => {
    const handler = await load();
    const { ctx: c, state } = uiCtx("No");
    assert.equal(await handler({ toolName: "bash", input: { command: "ls" } }, c), undefined);
    assert.equal(state.calls, 0);
  });
  test("without a UI, a call needing confirmation is blocked", async () => {
    const handler = await load();
    assert.deepEqual(await handler({ toolName: "bash", input: { command: "rm x" } }, uiCtx("Yes", false).ctx),
      { block: true, reason: "permission-gate: runs a shell command (cannot confirm without a UI)" });
  });
  test("No blocks, Yes allows", async () => {
    const handler = await load();
    assert.deepEqual(await handler({ toolName: "bash", input: { command: "rm x" } }, uiCtx("No").ctx),
      { block: true, reason: "permission-gate: denied by user" });
    assert.equal(await handler({ toolName: "bash", input: { command: "rm x" } }, uiCtx("Yes").ctx), undefined);
  });
  test("always-allow remembers the exact call for the session", async () => {
    const handler = await load();
    const { ctx: c, state } = uiCtx("Yes, always this session");
    assert.equal(await handler({ toolName: "bash", input: { command: "rm x" } }, c), undefined);
    assert.equal(await handler({ toolName: "bash", input: { command: "rm x" } }, c), undefined);
    assert.equal(state.calls, 1);
    assert.equal(await handler({ toolName: "bash", input: { command: "rm y" } }, c), undefined);
    assert.equal(state.calls, 2);
  });
}
