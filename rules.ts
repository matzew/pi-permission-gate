import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export type Decision = { kind: "allow" } | { kind: "ask"; reason: string };
export interface GateContext {
  cwd: string;
  home: string;
}

const allow: Decision = { kind: "allow" };
const ask = (reason: string): Decision => ({ kind: "ask", reason });

// Read-only commands that may run without asking (spec "Regeln im Detail").
const READ_ONLY = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat",
  "file", "tree", "du", "df", "which", "date", "whoami", "uname", "echo",
]);
const GIT_SUB = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files"]);
const GIT_BRANCH_FLAGS = new Set(["--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--show-current"]);
const KUBE_SUB = new Set(["get", "describe", "logs", "explain", "api-resources", "version"]);
const FIND_BAD = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const SECRET_ARG = /(^|,)secrets?(\/|,|$)/;

// Credential locations, relative to the home directory. `.env` files are matched separately.
const SENSITIVE_REL = [
  ".ssh", ".gnupg", ".kube", ".aws", ".config/gh", ".config/containers/auth.json",
  ".docker/config.json", ".netrc", ".codex/auth.json", ".pi/agent/auth.json", "Claude_Credentials",
];
const ENV_FILE = /^\.env(\..+)?$/;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function tokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

// A shell token referencing a credential path, via ~, $HOME, ${HOME}, the literal home path, or bare.
function mentionsCredential(token: string, home: string): boolean {
  if (ENV_FILE.test(basename(token))) return true;
  const prefixes = ["~/", "$HOME/", "${HOME}/", home.endsWith("/") ? home : `${home}/`];
  for (const p of SENSITIVE_REL) {
    if (token === p || token.startsWith(`${p}/`)) return true;
    for (const pre of prefixes) {
      if (!token.startsWith(pre)) continue;
      const rest = token.slice(pre.length);
      if (rest === p || rest.startsWith(`${p}/`)) return true;
    }
  }
  return false;
}

function gitOk(toks: string[]): boolean {
  const sub = toks[1];
  if (sub === undefined) return false;
  if (GIT_SUB.has(sub)) return !toks.some((t) => t.startsWith("--output"));
  if (sub === "branch") return toks.slice(2).every((t) => GIT_BRANCH_FLAGS.has(t));
  if (sub === "remote") return toks.length === 2 || (toks.length === 3 && toks[2] === "-v");
  return false;
}

function kubeOk(cmd: string, toks: string[]): boolean {
  const sub = toks[1];
  if (sub === undefined) return false;
  if (cmd === "oc" && sub === "whoami") return toks.length === 2;
  if (KUBE_SUB.has(sub)) return !toks.slice(2).some((t) => SECRET_ARG.test(t));
  return false;
}

function segmentOk(segment: string): boolean {
  const toks = tokens(segment);
  const cmd = toks[0];
  if (cmd === undefined || cmd.includes("=")) return false;
  if (READ_ONLY.has(cmd)) {
    if (cmd === "find" && toks.some((t) => FIND_BAD.has(t))) return false;
    return true;
  }
  if (cmd === "git") return gitOk(toks);
  if (cmd === "oc" || cmd === "kubectl") return kubeOk(cmd, toks);
  return false;
}

export function isReadOnlyCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (/[;&><$`\n\r]/.test(command) || command.includes("||")) return false;
  return command.split("|").every(segmentOk);
}

// Expand a leading ~ and resolve against cwd, without following symlinks.
function toAbsolute(path: string, ctx: GateContext): string {
  const expanded = path === "~" ? ctx.home : path.startsWith("~/") ? join(ctx.home, path.slice(2)) : path;
  return resolve(ctx.cwd, expanded);
}

function isSensitivePath(abs: string, home: string): boolean {
  if (ENV_FILE.test(basename(abs))) return true;
  return SENSITIVE_REL.map((p) => join(home, p)).some((root) => abs === root || abs.startsWith(root + sep));
}

// Real path of the nearest existing ancestor, with the missing remainder appended.
function realExisting(abs: string): string {
  const rest: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    cur = realpathSync(cur);
  } catch {
    // Fall back to the lexical path when realpath fails.
  }
  return rest.length ? join(cur, ...rest) : cur;
}

function insideProject(abs: string, ctx: GateContext): boolean {
  const cwd = resolve(ctx.cwd);
  if (cwd === resolve(ctx.home) || cwd === sep) return false;
  const project = realExisting(cwd);
  const target = realExisting(abs);
  return target === project || target.startsWith(project + sep);
}

function isGitInternal(abs: string, ctx: GateContext): boolean {
  const gitDir = join(resolve(ctx.cwd), ".git");
  return abs === gitDir || abs.startsWith(gitDir + sep);
}

export function decide(toolName: string, input: unknown, context: GateContext): Decision {
  const value = (input ?? {}) as Record<string, unknown>;

  if (toolName === "bash") {
    const command = value.command;
    if (!isString(command)) return ask("unexpected input for bash");
    if (tokens(command).some((t) => mentionsCredential(t, context.home))) return ask("command touches credentials");
    return isReadOnlyCommand(command) ? allow : ask("runs a shell command");
  }

  if (toolName === "read") {
    const path = value.path;
    if (!isString(path)) return ask("unexpected input for read");
    return isSensitivePath(toAbsolute(path, context), context.home) ? ask("reads credentials") : allow;
  }

  if (toolName === "write" || toolName === "edit") {
    const path = value.path;
    if (!isString(path)) return ask(`unexpected input for ${toolName}`);
    const abs = toAbsolute(path, context);
    if (isSensitivePath(abs, context.home)) return ask("writes to credentials");
    if (isGitInternal(abs, context)) return ask("modifies Git internals");
    if (!insideProject(abs, context)) return ask("writes outside the project folder");
    return allow;
  }

  return ask(`uses tool ${toolName}`);
}
