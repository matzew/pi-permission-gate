# pi-permission-gate

A [Pi](https://pi.dev) extension that asks before risky tool calls and blocks them when no UI is available to confirm. Pi runs tools without asking by default; this adds a Claude-Code-style confirmation step.

Requires Pi 1.5.0 or newer and Node.js 22.19 or newer. No runtime dependencies beyond Pi.

## What it does

On every `tool_call`, the extension classifies the action and either allows it or asks for confirmation. With no UI (for example `pi -p`), anything that would need confirmation is blocked with a reason instead.

| Tool | Allowed without asking | Asks |
| --- | --- | --- |
| `bash` | read-only commands from an allowlist (see below) | everything else |
| `write`, `edit` | paths inside the current project | paths outside the project, `.git` internals, credential files |
| `read` | any path | credential files |
| others (MCP, custom) | - | always |

The read-only allowlist covers `ls pwd cat head tail wc grep rg find stat file tree du df which date whoami uname echo`, plus `git status|diff|log|show|blame|rev-parse|ls-files`, `git branch`/`git remote` in listing form, and `oc`/`kubectl get|describe|logs|explain|api-resources|version` (`oc whoami`). A command only counts as read-only when it has no chaining or redirection (`;`, `&&`, `||`, `>`, `<`, `$(...)`, backticks) and every pipe segment starts with an allowlisted command. Deliberately excluded even though they look read-only: `env`/`printenv` (print secrets), `oc get secret`, `find -exec`/`-delete`, and `go test`/`npm test` (run code).

Credential locations that always prompt: `~/.ssh`, `~/.gnupg`, `~/.kube`, `~/.aws`, `~/.config/gh`, `~/.config/containers/auth.json`, `~/.docker/config.json`, `~/.netrc`, `~/.codex/auth.json`, `~/.pi/agent/auth.json`, `~/Claude_Credentials`, and any `.env` file.

The confirmation dialog offers **Yes**, **No**, and **Yes, always this session** (remembered in memory only, never persisted).

## Install

```sh
pi install git:github.com/matzew/pi-permission-gate
```

Or auto-load it globally by placing it under `~/.pi/agent/extensions/permission-gate/`.

## Configure

The lists of read-only commands and credential paths are constants at the top of `rules.ts`. Edit them and run `/reload`.

## Develop

```sh
npm install --ignore-scripts
npm run check
npm test
```

Pi supplies the runtime when loading the extension; `npm install` here is only for the type check and tests. Tests use Node's built-in runner and need no network or model calls.

## License

Apache-2.0
