/*
**  mcp-to-harness -- Bridge an MCP chat tool to an AI agent harness CLI
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  built-in dependencies  */
import os                from "node:os"
import path              from "node:path"
import fs                from "node:fs/promises"
import { spawn }         from "node:child_process"

/*  internal dependencies  */
import { JsonRpcStdioClient, raceDeadline, killChild } from "./mcp-to-harness-common.js"
import type { HarnessConfig, HarnessDriver, HarnessWorker, Invocation } from "./mcp-to-harness-common.js"

/*  the built-in tools of the Copilot CLI (names verified against 1.0.x by
    enumeration through the model): in ACP mode "--available-tools" with
    an empty list is NOT honored (unlike in one-shot prompt mode), so the
    tools must be stripped one by one via "--excluded-tools" -- most
    notably "sql" and "session_store_sql", through which the model can
    otherwise verifiably read past conversations back out of the session
    store, breaking the per-request isolation  */
const copilotBuiltinTools = [
    "bash", "read_bash", "stop_bash", "list_bash",
    "view", "create", "edit", "grep", "glob",
    "web_fetch", "skill", "task",
    "sql", "session_store_sql",
    "read_agent", "list_agents", "write_agent"
]

/*  the Copilot CLI verifiably routes its informational messages into the
    ACP agent message stream, prefixed to the answer of every turn, so
    this deterministic prefix has to be stripped (the tool names are
    reported in alphabetical order)  */
const copilotInfoPrefix = `Info: Disabled tools: ${[ ...copilotBuiltinTools ].sort().join(", ")}`

/*  the ACP messages (the minimal subset needed here)  */
interface AcpSessionNew    { sessionId?: string }
interface AcpPromptResult  { stopReason?: string }
interface AcpUpdateParams {
    sessionId?: string
    update?: {
        sessionUpdate?: string
        content?: { type?: string, text?: string }
    }
}
interface AcpPermissionParams {
    options?: { optionId?: string, kind?: string }[]
}

/*  the GitHub Copilot CLI driver  */
export const copilotDriver: HarnessDriver = {
    /*  the per-harness authentication and configuration relocation
        environment variables passed through to the child harness CLI  */
    envAllowlist: [ "GITHUB_TOKEN", "GH_TOKEN", "XDG_CONFIG_HOME", "COPILOT_HOME" ],

    /*  assemble the strictly non-interactive one-shot CLI invocation
        (flags verified against 1.0.x): non-interactive prompt mode with
        response-only output, no coloring, an empty available-tools list
        (strips all tools from the model), built-in MCP servers disabled,
        no custom instructions loaded, no interactive questions asked, no
        automatic self-update, no session export, and logging switched
        off. The CLI offers neither a stdin prompt channel nor a separate
        system prompt channel, so the prompt travels as an argument and
        the optional system prompt is prepended as a preamble  */
    assembleInvocation (config: HarnessConfig, prompt: string): Invocation {
        const promptText = config.prompt !== undefined ? `${config.prompt}\n\n${prompt}` : prompt
        const args = [
            "--prompt", promptText,
            "--silent",
            "--no-color",
            "--available-tools=",
            "--disable-builtin-mcps",
            "--no-custom-instructions",
            "--no-ask-user",
            "--no-auto-update",
            "--no-remote-export",
            "--log-level", "none"
        ]
        if (config.model !== undefined)
            args.push("--model", config.model)
        return { args, input: "" }
    },

    /*  spawn a persistent worker process (verified against 1.0.x): the
        "--acp" flag runs Copilot as an Agent Client Protocol (ACP)
        JSON-RPC stdio server, where every request gets its own fresh
        "session/new" + "session/prompt" pair -- so the process lives
        across requests while the requests stay isolated. Additionally
        "$COPILOT_HOME" is relocated into the throw-away worker
        directory, because the model can otherwise read past
        conversations back out of the global session store
        "$COPILOT_HOME/session-store.db" (authentication survives the
        relocation: on macOS it resolves via the keychain, elsewhere the
        user-level "config.json" is seeded into the relocated home). Any
        "session/request_permission" round-trip is answered with the
        reject option, and file system service requests are refused  */
    async spawnWorker (config: HarnessConfig, dir: string, env: Record<string, string>): Promise<HarnessWorker> {
        /*  relocate the Copilot state home into the worker directory and
            seed the user-level configuration file (a best-effort copy:
            on macOS authentication resolves via the keychain instead)  */
        const home = path.join(dir, "copilot-home")
        await fs.mkdir(home, { recursive: true })
        const homeSource = process.env["COPILOT_HOME"] ?? path.join(os.homedir(), ".copilot")
        await fs.copyFile(path.join(homeSource, "config.json"), path.join(home, "config.json"))
            .catch(() => { /* intentionally ignored */ })
        env = { ...env, COPILOT_HOME: home }

        const args = [
            "--acp",
            "--no-color",
            `--excluded-tools=${copilotBuiltinTools.join(",")}`,
            "--disable-builtin-mcps",
            "--no-custom-instructions",
            "--no-ask-user",
            "--no-auto-update",
            "--no-remote-export",
            "--log-level", "none"
        ]
        if (config.model !== undefined)
            args.push("--model", config.model)
        const child = spawn(config.command, args, { cwd: dir, env })

        /*  track the worker state: the currently prompted ACP session
            (whose agent message chunks are collected as the answer), a
            tail of the stderr output for diagnostics, and whether the
            process is still usable  */
        let activeSession: string | undefined
        let chunks:        string[] = []
        let stderrTail = ""
        let isBroken   = false
        child.stderr.on("data", (chunk: Buffer) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-4096)
        })

        /*  attach the JSON-RPC client: collect the streamed answer
            chunks, answer permission requests with the reject option,
            and refuse all other server-initiated requests  */
        const rpc = new JsonRpcStdioClient(child, (msg) => {
            if (msg.method === "session/update") {
                const params = msg.params as AcpUpdateParams
                if (params.sessionId === activeSession
                    && params.update?.sessionUpdate === "agent_message_chunk"
                    && params.update.content?.type === "text")
                    chunks.push(params.update.content.text ?? "")
            }
            else if (msg.id !== undefined && msg.method === "session/request_permission") {
                const options = (msg.params as AcpPermissionParams).options ?? []
                const option  = options.find((o) => o.kind?.startsWith("reject"))
                if (option !== undefined)
                    rpc.respond(msg.id, { outcome: { outcome: "selected", optionId: option.optionId } })
                else
                    rpc.respond(msg.id, { outcome: { outcome: "cancelled" } })
            }
            else if (msg.id !== undefined && msg.method !== undefined)
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

        /*  perform the ACP handshake, bounded by a fixed spawn timeout,
            with the file system client capabilities switched off  */
        await raceDeadline(rpc.request("initialize", {
            protocolVersion:    1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            clientInfo:         { name: config.bridgeName, version: config.bridgeVersion }
        }), 30000, undefined, () => {
            isBroken = true
            child.kill("SIGKILL")
        }).catch(async (err: unknown) => {
            /*  a failed handshake must not leak a still running process  */
            isBroken = true
            await killChild(child)
            throw err
        })

        const worker: HarnessWorker = {
            broken: () => isBroken,
            async query (prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
                if (isBroken)
                    throw new Error("harness CLI worker process is broken")
                const work = (async (): Promise<string> => {
                    /*  the optional system prompt is prepended as a
                        preamble (ACP offers no system prompt channel)  */
                    const text = config.prompt !== undefined ? `${config.prompt}\n\n${prompt}` : prompt

                    /*  a fresh session per request keeps the requests isolated  */
                    const session = await rpc.request("session/new",
                        { cwd: dir, mcpServers: [] }) as AcpSessionNew
                    if (session.sessionId === undefined)
                        throw new Error("harness CLI failed: no ACP session id")
                    activeSession = session.sessionId
                    chunks = []
                    const result = await rpc.request("session/prompt", {
                        sessionId: session.sessionId,
                        prompt:    [ { type: "text", text } ]
                    }) as AcpPromptResult
                    activeSession = undefined

                    /*  any non-successful stop reason (e.g. "max_tokens",
                        "max_turn_requests", "refusal", or "cancelled") is a
                        hard failure, even when partial answer text was
                        already streamed -- a truncated or refused answer
                        must not be returned as if it were complete  */
                    if (result.stopReason !== "end_turn")
                        throw new Error(`harness CLI failed (stop reason: ${result.stopReason ?? "unknown"})`)

                    /*  strip the deterministic informational prefix  */
                    let answer = chunks.join("")
                    while (answer.startsWith(copilotInfoPrefix))
                        answer = answer.slice(copilotInfoPrefix.length)
                    return answer
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

