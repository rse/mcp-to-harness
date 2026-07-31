/*
**  mcp-to-harness -- Bridge an MCP chat tool to an AI agent harness CLI
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  built-in dependencies  */
import { spawn }         from "node:child_process"

/*  internal dependencies  */
import { onLines, raceDeadline, killChild } from "./mcp-to-harness-common.js"
import type { HarnessConfig, HarnessDriver, HarnessWorker, Invocation } from "./mcp-to-harness-common.js"

/*  the stream-json events of the Claude Code CLI (the minimal subset needed here)  */
interface ClaudeEvent {
    type:      string
    subtype?:  string
    is_error?: boolean
    result?:   string
}

/*  neutralize a leading "/" in a bridged user prompt by prepending a
    newline, so the CLI answers it as chat instead of executing it as
    a slash command (verified against 2.x: command detection triggers
    on a raw leading "/" only, and a leading newline is semantically
    negligible for the model)  */
const neutralizePrompt = (prompt: string): string =>
    prompt.startsWith("/") ? "\n" + prompt : prompt

/*  the Anthropic Claude Code CLI driver  */
export const claudeDriver: HarnessDriver = {
    /*  the per-harness authentication and configuration relocation
        environment variables passed through to the child harness CLI  */
    envAllowlist: [ "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME" ],

    /*  assemble the strictly non-interactive one-shot CLI invocation
        (flags verified against 2.x): print mode with plain text output,
        all customizations disabled ("--safe-mode": no hooks, plugins, MCP
        servers, CLAUDE.md, or skills), all built-in tools disabled
        ("--tools" with an empty list), MCP servers restricted to the
        (empty) explicit configuration (prevents the child from
        re-entering this very bridge through a user-scope MCP
        registration, which would recurse indefinitely), and no session
        persisted to disk. The prompt is passed on stdin, so an
        arbitrarily long prompt neither overflows the argument list
        (E2BIG) nor becomes visible in the process table  */
    assembleInvocation (config: HarnessConfig, prompt: string): Invocation {
        const args = [
            "--print", "--output-format", "text",
            "--safe-mode", "--tools", "",
            "--strict-mcp-config", "--no-session-persistence"
        ]
        if (config.model !== undefined)
            args.push("--model", config.model)
        if (config.prompt !== undefined)
            args.push("--system-prompt", config.prompt)
        return { args, input: neutralizePrompt(prompt) }
    },

    /*  spawn a persistent worker process (flags verified against 2.x):
        the same containment flags as the one-shot invocation, but in
        streaming JSON input/output mode, which keeps the process alive
        across turns and accepts newline-delimited JSON user messages
        until stdin is closed. The process is inherently stateful (one
        growing conversation), so every query is preceded by a "/clear"
        command which verifiably resets the conversation to a fresh
        session (new session id, no context carry-over) while retaining
        the "--system-prompt" and "--model" settings  */
    async spawnWorker (config: HarnessConfig, dir: string, env: Record<string, string>): Promise<HarnessWorker> {
        const args = [
            "--print",
            "--input-format",  "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--safe-mode", "--tools", "",
            "--strict-mcp-config", "--no-session-persistence"
        ]
        if (config.model !== undefined)
            args.push("--model", config.model)
        if (config.prompt !== undefined)
            args.push("--system-prompt", config.prompt)
        const child = spawn(config.command, args, { cwd: dir, env })

        /*  track the worker state: the FIFO of turns awaiting their
            "result" event, a tail of the stderr output for diagnostics,
            and whether the process is still usable  */
        const pending: { resolve: (event: ClaudeEvent) => void, reject: (error: Error) => void }[] = []
        let stderrTail = ""
        let isBroken   = false
        let isVirgin   = true
        child.stderr.on("data", (chunk: Buffer) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-4096)
        })
        child.stdin.on("error", () => {
            /*  intentionally ignored: an asynchronous write failure is
                already surfaced through the "close" handler  */
        })
        child.on("error", (error: Error) => {
            isBroken = true
            for (const entry of pending.splice(0))
                entry.reject(new Error(`harness CLI failed: ${error.message}`))
        })
        child.on("close", () => {
            isBroken = true
            const detail = stderrTail.trim() !== "" ? `: ${stderrTail.trim()}` : ""
            for (const entry of pending.splice(0))
                entry.reject(new Error(`harness CLI worker process exited unexpectedly${detail}`))
        })

        /*  correlate emitted "result" events with the pending turns
            (all other event types are progress noise and are ignored)  */
        onLines(child.stdout, (line) => {
            let event: ClaudeEvent
            try { event = JSON.parse(line) as ClaudeEvent }
            catch { return }
            if (event.type === "result") {
                const entry = pending.shift()
                if (entry !== undefined)
                    entry.resolve(event)
            }
        })

        /*  send a single turn and await its "result" event: a turn
            started after the process died must fail fast here, because
            Node surfaces a write on a destroyed stdin only through the
            asynchronous "error" event (swallowed above) and the "close"
            handler rejects only the turns already pending at close
            time (when the write nevertheless raises synchronously, the
            just registered turn is taken back, so nobody later rejects
            an unawaited promise)  */
        const turn = (text: string): Promise<ClaudeEvent> => {
            if (isBroken)
                return Promise.reject(new Error("harness CLI worker process is broken"))
            const { promise, resolve, reject } = Promise.withResolvers<ClaudeEvent>()
            const entry = { resolve, reject }
            pending.push(entry)
            try {
                child.stdin.write(JSON.stringify({
                    type: "user",
                    message: { role: "user", content: [ { type: "text", text } ] }
                }) + "\n")
            }
            catch (err: unknown) {
                isBroken = true
                const idx = pending.indexOf(entry)
                if (idx >= 0)
                    pending.splice(idx, 1)
                throw err
            }
            return promise
        }

        const worker: HarnessWorker = {
            broken: () => isBroken,
            async query (prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
                if (isBroken)
                    throw new Error("harness CLI worker process is broken")
                const work = (async (): Promise<string> => {
                    /*  reset the conversation before (not after) the
                        prompt: a leading reset also recovers isolation
                        when a previous request died mid-turn, and is
                        skipped only on a virgin process where there is
                        nothing to reset yet  */
                    if (!isVirgin) {
                        const cleared = await turn("/clear")
                        if (cleared.subtype !== "success" || cleared.is_error === true)
                            throw new Error("harness CLI failed to reset the conversation")
                    }
                    isVirgin = false
                    const event = await turn(neutralizePrompt(prompt))
                    if (event.subtype !== "success" || event.is_error === true)
                        throw new Error(`harness CLI failed (${event.subtype ?? "unknown"})`)
                    return event.result ?? ""
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

