/*
**  mcp-to-harness -- Bridge an MCP chat tool to an AI agent harness CLI
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  built-in dependencies  */
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { Readable }                       from "node:stream"

/*  the supported AI agent harness types  */
export const harnessTypes = [ "claude", "codex", "copilot" ] as const
export type Harness = (typeof harnessTypes)[number]

/*  the effective harness configuration handed to a driver  */
export interface HarnessConfig {
    command:       string
    model?:        string
    prompt?:       string
    bridgeName:    string
    bridgeVersion: string
}

/*  the harness-specific one-shot CLI invocation  */
export interface Invocation {
    args:    string[]
    input:   string
    output?: string
}

/*  a persistent harness worker process: spawned once, then queried
    repeatedly, with every query running as an isolated conversation  */
export interface HarnessWorker {
    /*  whether the worker process is no longer usable  */
    broken (): boolean

    /*  perform a single isolated request against the worker  */
    query (prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string>

    /*  terminate the worker process  */
    dispose (): Promise<void>
}

/*  a harness driver: the per-harness environment allowlist, the one-shot
    CLI invocation assembly, and the persistent worker process factory  */
export interface HarnessDriver {
    envAllowlist: string[]
    assembleInvocation (config: HarnessConfig, prompt: string, dir: string): Invocation
    spawnWorker (config: HarnessConfig, dir: string, env: Record<string, string>): Promise<HarnessWorker>
}

/*  the minimal set of parent environment variables passed through to the
    child harness CLI: the executable search path and home directory, the
    user identity (macOS keychain lookups of Claude Code require it), the
    terminal type, the standard HTTP(S) proxy variables (the "extendEnv:
    false" isolation would otherwise cut off network access from behind a
    corporate proxy); every other variable in the parent environment
    is deliberately withheld, except the per-harness additions of the
    respective driver  */
export const envAllowlistCommon = [
    "PATH", "HOME", "USER", "LOGNAME", "TERM",
    "HTTP_PROXY",  "HTTPS_PROXY",  "NO_PROXY",  "ALL_PROXY",
    "http_proxy",  "https_proxy",  "no_proxy",  "all_proxy"
]

/*  attach a newline-splitting reader to a readable stream  */
export const onLines = (stream: Readable, onLine: (line: string) => void): void => {
    let buffer = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
        buffer += chunk
        let idx: number
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            if (line.trim() !== "")
                onLine(line)
        }
    })
}

/*  race a unit of work against a hard timeout and the caller's
    cancellation signal: on either bound, the provided abort action is
    invoked (which is expected to kill the underlying process and thereby
    also settle the pending work) and a distinctive error is raised  */
export const raceDeadline = async <T>(
    work: Promise<T>, timeoutMs: number,
    signal: AbortSignal | undefined, abort: () => void
): Promise<T> => {
    let timer:   ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void)                  | undefined
    try {
        return await new Promise<T>((resolve, reject) => {
            timer = setTimeout(() => {
                abort()
                reject(new Error(`harness CLI timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            if (signal !== undefined) {
                onAbort = () => {
                    abort()
                    reject(new Error("harness CLI execution was canceled"))
                }
                if (signal.aborted)
                    onAbort()
                else
                    signal.addEventListener("abort", onAbort, { once: true })
            }
            work.then(resolve, reject)
        })
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer)
        if (signal !== undefined && onAbort !== undefined)
            signal.removeEventListener("abort", onAbort)
    }
}

/*  terminate a child process: politely first, forcefully after a grace
    period, and await its actual termination  */
export const killChild = async (child: ChildProcessWithoutNullStreams, graceMs = 3000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null)
        return
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs)
    timer.unref()
    await closed
    clearTimeout(timer)
}

/*  a single JSON-RPC 2.0 message on the wire  */
export interface JsonRpcMessage {
    jsonrpc: "2.0"
    id?:     number | string
    method?: string
    params?: unknown
    result?: unknown
    error?:  { code: number, message: string }
}

/*  minimal JSON-RPC 2.0 client over the stdio of a child process, as
    spoken by both "codex mcp-server" (MCP) and "copilot --acp" (ACP):
    newline-delimited JSON, client-initiated requests with correlated
    responses, plus server-initiated requests and notifications which are
    handed to the provided callback  */
export class JsonRpcStdioClient {
    private idCounter = 0
    private pending = new Map<number | string, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
    constructor (
        private child: ChildProcessWithoutNullStreams,
        onMessage: (msg: JsonRpcMessage) => void
    ) {
        /*  swallow asynchronous stdin write errors (e.g. EPIPE after
            the process died), which would otherwise raise as uncaught
            "error" events -- the failure surfaces via the process exit  */
        child.stdin.on("error", () => { /* intentionally ignored */ })
        onLines(child.stdout, (line) => {
            let msg: JsonRpcMessage
            try { msg = JSON.parse(line) as JsonRpcMessage }
            catch { return } /* intentionally ignored: non-JSON noise line */
            if (msg.method === undefined && msg.id !== undefined) {
                /*  response to one of our requests  */
                const entry = this.pending.get(msg.id)
                if (entry !== undefined) {
                    this.pending.delete(msg.id)
                    if (msg.error !== undefined)
                        entry.reject(new Error(msg.error.message))
                    else
                        entry.resolve(msg.result)
                }
            }
            else {
                /*  server-initiated request or notification  */
                onMessage(msg)
            }
        })
    }
    private send (msg: object): void {
        this.child.stdin.write(JSON.stringify(msg) + "\n")
    }
    request (method: string, params: object): Promise<unknown> {
        const id = ++this.idCounter
        const promise = new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
        })
        try {
            this.send({ jsonrpc: "2.0", id, method, params })
        }
        catch (err: unknown) {
            /*  when the write to a dead process raises synchronously,
                take the just registered request back, so nobody later
                rejects an unawaited promise  */
            this.pending.delete(id)
            throw err
        }
        return promise
    }
    notify (method: string, params: object): void {
        this.send({ jsonrpc: "2.0", method, params })
    }
    respond (id: number | string, result: object): void {
        this.send({ jsonrpc: "2.0", id, result })
    }
    respondError (id: number | string, code: number, message: string): void {
        this.send({ jsonrpc: "2.0", id, error: { code, message } })
    }
    failAll (message: string): void {
        for (const entry of this.pending.values())
            entry.reject(new Error(message))
        this.pending.clear()
    }
}

