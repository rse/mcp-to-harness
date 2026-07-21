/*!
**  mcp-to-harness -- Bridge an MCP chat tool to an AI agent harness CLI
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  run-time tests against the compiled CLI ("npm test" builds first):
    each test performs a full MCP stdio round-trip (initialize,
    tools/list, tools/call) against "dist/mcp-to-harness.js" and -- for
    the harness tests -- executes the real, locally installed and locally
    authenticated harness CLI, so expect several minutes of run-time;
    tests of harnesses which are not installed are skipped  */

/*  built-in dependencies  */
import path                     from "node:path"
import assert                   from "node:assert/strict"
import { spawn, execSync }      from "node:child_process"
import type { ChildProcess }    from "node:child_process"
import { fileURLToPath }        from "node:url"

/*  external dependencies  */
import { describe, it }         from "mocha"

/*  the compiled CLI under test  */
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist", "mcp-to-harness.js")

/*  JSON-RPC / MCP wire types (just the minimal subset needed here)  */
interface RPCMessage { jsonrpc: string, id?: number, result?: unknown }
interface ToolResult { isError?: boolean, content: { type: string, text: string }[] }
interface ToolsList  { tools: { name: string }[] }

/*  check whether a harness CLI is installed  */
const missing = (command: string): boolean => {
    try {
        execSync(`command -v ${command}`, { stdio: "ignore" })
        return false
    }
    catch {
        return true
    }
}

/*  count the still running processes matching a pattern  */
const processCount = (pattern: string): number => {
    try {
        return parseInt(execSync(`pgrep -f "${pattern}" | wc -l`).toString().trim(), 10)
    }
    catch {
        return 0
    }
}

/*  sleep for a number of milliseconds  */
const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

/*  minimal raw JSON-RPC MCP stdio client around a spawned server process  */
class MCPClient {
    private child: ChildProcess
    private buffer = ""
    private pending = new Map<number, (msg: RPCMessage) => void>()
    private id = 0
    constructor (serverArgs: string[]) {
        this.child = spawn("node", [ cli, ...serverArgs ], { stdio: [ "pipe", "pipe", "pipe" ] })
        this.child.stdout?.on("data", (chunk: Buffer) => {
            this.buffer += chunk.toString()
            let idx: number
            while ((idx = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, idx)
                this.buffer = this.buffer.slice(idx + 1)
                if (line.trim() === "")
                    continue
                const msg = JSON.parse(line) as RPCMessage
                if (msg.id !== undefined) {
                    const resolve = this.pending.get(msg.id)
                    if (resolve !== undefined) {
                        this.pending.delete(msg.id)
                        resolve(msg)
                    }
                }
            }
        })
    }
    send (msg: object): void {
        this.child.stdin?.write(JSON.stringify(msg) + "\n")
    }
    request (method: string, params: object): Promise<RPCMessage> {
        const id = ++this.id
        const promise = new Promise<RPCMessage>((resolve) => {
            this.pending.set(id, resolve)
        })
        this.send({ jsonrpc: "2.0", id, method, params })
        return promise
    }
    async initialize (): Promise<void> {
        await this.request("initialize", {
            protocolVersion: "2025-06-18",
            capabilities:    {},
            clientInfo:      { name: "mcp-to-harness-test", version: "0.0.0" }
        })
        this.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    }
    async listTools (): Promise<ToolsList> {
        const response = await this.request("tools/list", {})
        return response.result as ToolsList
    }
    async callTool (name: string, prompt: string): Promise<ToolResult> {
        const response = await this.request("tools/call", { name, arguments: { prompt } })
        return response.result as ToolResult
    }
    /*  fire a tool call without awaiting its response and
        return the request id (for a subsequent cancellation)  */
    callToolNoWait (name: string, prompt: string): number {
        const id = ++this.id
        this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { prompt } } })
        return id
    }
    close (): void {
        this.child.kill()
    }
}

/*  the test prompts: chosen so the expected answer is
    deterministic enough for a substring assertion  */
const promptMath    = "What is 6*7? Answer with just the number."
const promptCapital = "What is the capital of France?"
const promptSystem  = "You must always answer with exactly the single word BANANA."
const promptEssay   = "Write a detailed 1000 word essay about the history of computing."

/*  the per-harness tests: plain query and system prompt round-trip  */
for (const harness of [ "claude", "codex", "copilot" ] as const) {
    describe(`harness ${harness}`, () => {
        const itHarness  = missing(harness) ? it.skip : it
        const serverArgs = [
            "--service",  `Test ${harness}`,
            "--mcp-tool", `chat-${harness}`,
            "--harness",  harness
        ]
        itHarness("plain query", async () => {
            const client = new MCPClient(serverArgs)
            try {
                await client.initialize()
                const tools = await client.listTools()
                assert.equal(tools.tools[0].name, `chat-${harness}`)
                const result = await client.callTool(`chat-${harness}`, promptMath)
                assert.notEqual(result.isError, true)
                assert.match(result.content[0].text, /42/)
            }
            finally {
                client.close()
            }
        }).timeout(300000).slow(60000)
        itHarness("system prompt", async () => {
            const client = new MCPClient([ ...serverArgs, "--harness-prompt", promptSystem ])
            try {
                await client.initialize()
                const result = await client.callTool(`chat-${harness}`, promptCapital)
                assert.notEqual(result.isError, true)
                assert.match(result.content[0].text, /BANANA/)
            }
            finally {
                client.close()
            }
        }).timeout(300000).slow(60000)
    })
}

/*  the remaining special-case tests  */
describe("special cases", () => {
    /*  the model override test (Claude Code only, as its "haiku" model
        alias is stable and the model reliably self-identifies)  */
    const itClaude = missing("claude") ? it.skip : it
    itClaude("model override (claude)", async () => {
        const client = new MCPClient([
            "--service",       "Test claude",
            "--mcp-tool",      "chat-claude",
            "--harness",       "claude",
            "--harness-model", "haiku"
        ])
        try {
            await client.initialize()
            const result = await client.callTool("chat-claude", "Which Claude model are you? Answer briefly.")
            assert.notEqual(result.isError, true)
            assert.match(result.content[0].text, /[Hh]aiku/)
        }
        finally {
            client.close()
        }
    }).timeout(300000).slow(60000)

    /*  the error path test: a nonexistent harness command must yield a clean,
        "ERROR: "-prefixed MCP error result (needs no harness installed at all)  */
    it("nonexistent harness command", async () => {
        const client = new MCPClient([
            "--service",         "Test error",
            "--mcp-tool",        "chat-error",
            "--harness",         "codex",
            "--harness-command", "mcp-to-harness-nonexistent-cli"
        ])
        try {
            await client.initialize()
            const result = await client.callTool("chat-error", promptMath)
            assert.equal(result.isError, true)
            assert.match(result.content[0].text, /^ERROR: harness CLI failed/)
        }
        finally {
            client.close()
        }
    }).timeout(60000).slow(60000)

    /*  the timeout path test: a deliberately tiny timeout must yield a clean,
        "ERROR: "-prefixed MCP error result  */
    const itCodex = missing("codex") ? it.skip : it
    itCodex("harness timeout (codex)", async () => {
        const client = new MCPClient([
            "--service",         "Test timeout",
            "--mcp-tool",        "chat-timeout",
            "--harness",         "codex",
            "--harness-timeout", "2000"
        ])
        try {
            await client.initialize()
            const result = await client.callTool("chat-timeout", promptMath)
            assert.equal(result.isError, true)
            assert.match(result.content[0].text, /^ERROR: harness CLI timed out after 2000ms/)
        }
        finally {
            client.close()
        }
    }).timeout(60000).slow(60000)

    /*  the cancellation test: cancelling an in-flight MCP request must
        terminate the spawned harness CLI process (checked via the process
        table, so skipped on Windows)  */
    const itCancel = (process.platform === "win32" || missing("codex")) ? it.skip : it
    itCancel("cancellation terminates harness process (codex)", async () => {
        const client = new MCPClient([
            "--service",  "Test cancel",
            "--mcp-tool", "chat-cancel",
            "--harness",  "codex"
        ])
        try {
            await client.initialize()
            const id = client.callToolNoWait("chat-cancel", promptEssay)
            await delay(8000)
            const before = processCount("codex exec")
            client.send({
                jsonrpc: "2.0",
                method:  "notifications/cancelled",
                params:  { requestId: id, reason: "test cancellation" }
            })
            await delay(4000)
            const after = processCount("codex exec")
            assert.ok(before > 0, "harness process should be running before cancellation")
            assert.equal(after, 0, "harness process should be gone after cancellation")
        }
        finally {
            client.close()
        }
    }).timeout(120000).slow(60000)
})

