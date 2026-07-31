/*
**  mcp-to-harness -- Bridge an MCP chat tool to an AI agent harness CLI
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  built-in dependencies  */
import path              from "node:path"
import { spawn }         from "node:child_process"

/*  internal dependencies  */
import { JsonRpcStdioClient, raceDeadline, killChild } from "./mcp-to-harness-common.js"
import type { HarnessConfig, HarnessDriver, HarnessWorker, Invocation } from "./mcp-to-harness-common.js"

/*  the result of an MCP "tools/call" request (the minimal subset needed here)  */
interface McpToolResult {
    isError?: boolean
    content?: { type: string, text?: string }[]
}

/*  the OpenAI Codex CLI driver  */
export const codexDriver: HarnessDriver = {
    /*  the per-harness authentication and configuration relocation
        environment variables passed through to the child harness CLI  */
    envAllowlist: [ "CODEX_HOME", "XDG_CONFIG_HOME" ],

    /*  assemble the strictly non-interactive one-shot CLI invocation
        (flags verified against 0.14x): skip the Git-repository
        requirement (the cwd is a bare temp directory), confine the
        sandbox to read-only, disable ANSI coloring, avoid persisting a
        session, ignore the user-level configuration and execpolicy rules
        (prevents the child from re-entering this very bridge through a
        user-scope MCP registration and keeps foreign MCP tools out of
        the query -- authentication still resolves from "$CODEX_HOME"),
        switch off the built-in tool surfaces via feature flags (shell
        execution, web search, image generation, multi-agent spawning,
        hosted apps MCP), root the agent in the temp directory, and
        capture just the final agent message in a dedicated output file
        rather than the noisy event transcript on stdout. The prompt is
        passed on stdin ("-"), the optional system prompt is prepended as
        a preamble (the CLI offers no separate system prompt channel)  */
    assembleInvocation (config: HarnessConfig, prompt: string, dir: string): Invocation {
        const output = path.join(dir, "answer.txt")
        const args = [
            "exec",
            "--skip-git-repo-check",
            "--sandbox",             "read-only",
            "--color",               "never",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "-c",                    "features.shell_tool=false",
            "-c",                    "web_search=disabled",
            "-c",                    "features.image_generation=false",
            "-c",                    "features.multi_agent=false",
            "-c",                    "features.multi_agent_v2=false",
            "-c",                    "features.apps=false",
            "-C",                    dir,
            "-o",                    output
        ]
        if (config.model !== undefined)
            args.push("--model", config.model)
        args.push("-")
        const input = config.prompt !== undefined ? `${config.prompt}\n\n${prompt}` : prompt
        return { args, input, output }
    },

    /*  spawn a persistent worker process (verified against 0.14x): the
        "codex mcp-server" subcommand runs Codex as an MCP stdio server
        exposing a single "codex" tool, where every tool call runs a
        fresh, isolated session -- so the process lives across requests
        while the requests stay isolated. The subcommand offers no
        "--ignore-user-config" or "--ephemeral" flags, so the user-level
        configuration is neutralized via "-c" overrides instead (empty
        MCP server set, tool surfaces off) and -- as an accepted
        deviation from the one-shot mode -- the session rollout files are
        persisted under "$CODEX_HOME/sessions", exactly as with regular
        interactive Codex use ("-c ephemeral=true" is verifiably ignored,
        and relocating "$CODEX_HOME" would break the auth token refresh).
        The per-call arguments provide the sandbox and approval
        hardening, plus a proper system prompt channel
        ("base-instructions") which the "exec" subcommand lacks  */
    async spawnWorker (config: HarnessConfig, dir: string, env: Record<string, string>): Promise<HarnessWorker> {
        const args = [
            "mcp-server",
            "-c", "mcp_servers={}",
            "-c", "features.shell_tool=false",
            "-c", "web_search=disabled",
            "-c", "features.image_generation=false",
            "-c", "features.multi_agent=false",
            "-c", "features.multi_agent_v2=false",
            "-c", "features.apps=false"
        ]
        const child = spawn(config.command, args, { cwd: dir, env })

        /*  track the worker state: a tail of the stderr output for
            diagnostics and whether the process is still usable  */
        let stderrTail = ""
        let isBroken   = false
        child.stderr.on("data", (chunk: Buffer) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-4096)
        })

        /*  attach the JSON-RPC client, rejecting any server-initiated
            request (the "codex/event" progress notifications are ignored)  */
        const rpc = new JsonRpcStdioClient(child, (msg) => {
            if (msg.id !== undefined && msg.method !== undefined)
                rpc.respondError(msg.id, -32601, "not supported by mcp-to-harness")
        })
        child.on("error", (error: Error) => {
            isBroken = true
            rpc.failAll(`harness CLI failed: ${error.message}`)
        })
        child.on("close", () => {
            isBroken = true
            const detail = stderrTail.trim() !== "" ? `: ${stderrTail.trim()}` : ""
            rpc.failAll(`harness CLI worker process exited unexpectedly${detail}`)
        })

        /*  perform the MCP handshake, bounded by a fixed spawn timeout  */
        await raceDeadline((async () => {
            await rpc.request("initialize", {
                protocolVersion: "2025-06-18",
                capabilities:    {},
                clientInfo:      { name: config.bridgeName, version: config.bridgeVersion }
            })
            rpc.notify("notifications/initialized", {})
        })(), 30000, undefined, () => {
            isBroken = true
            child.kill("SIGKILL")
        })

        const worker: HarnessWorker = {
            broken: () => isBroken,
            async query (prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
                if (isBroken)
                    throw new Error("harness CLI worker process is broken")
                const work = (async (): Promise<string> => {
                    const args: Record<string, unknown> = {
                        prompt,
                        "cwd":             dir,
                        "sandbox":         "read-only",
                        "approval-policy": "never"
                    }
                    if (config.model !== undefined)
                        args["model"] = config.model
                    if (config.prompt !== undefined)
                        args["base-instructions"] = config.prompt
                    const result = await rpc.request("tools/call",
                        { name: "codex", arguments: args }) as McpToolResult
                    const text = (result.content ?? [])
                        .filter((block) => block.type === "text")
                        .map((block) => block.text ?? "")
                        .join("")
                    if (result.isError === true)
                        throw new Error(`harness CLI failed${text.trim() !== "" ? `: ${text.trim()}` : ""}`)
                    return text
                })()
                return raceDeadline(work, timeoutMs, signal, () => {
                    isBroken = true
                    child.kill("SIGKILL")
                })
            },
            async dispose (): Promise<void> {
                isBroken = true
                await killChild(child)
            }
        }
        return worker
    }
}

