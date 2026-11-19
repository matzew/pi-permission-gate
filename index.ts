import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decide } from "./rules.ts";

// Variante A: confirm risky tool calls; block them when no UI can ask. Spec: permission-gate-design.md.
export default function (pi: ExtensionAPI): void {
  const alwaysAllow = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    const decision = decide(event.toolName, event.input, { cwd: ctx.cwd, home: homedir() });
    if (decision.kind === "allow") return undefined;

    const key = `${event.toolName}\n${JSON.stringify(event.input)}`;
    if (alwaysAllow.has(key)) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: `permission-gate: ${decision.reason} (cannot confirm without a UI)` };
    }

    const input = (event.input ?? {}) as Record<string, unknown>;
    const detail = typeof input.command === "string" ? input.command
      : typeof input.path === "string" ? input.path
      : JSON.stringify(event.input);
    const choice = await ctx.ui.select(
      `permission-gate: ${decision.reason}\n\n  ${detail}\n\nAllow?`,
      ["Yes", "No", "Yes, always this session"],
    );

    if (choice === "Yes, always this session") {
      alwaysAllow.add(key);
      return undefined;
    }
    if (choice === "Yes") return undefined;
    return { block: true, reason: "permission-gate: denied by user" };
  });
}
