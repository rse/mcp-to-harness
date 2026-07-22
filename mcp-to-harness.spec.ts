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
import os                       from "node:os"
import fs                       from "node:fs"
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
for (const harness of [ "claude", "codex", "copilot", "kimi" ] as const) {
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

/*  the kimi containment test: the kimi harness supplies part of its
    containment through materialized asset files -- a built-in-tool-empty
    agent definition and an empty explicit MCP config -- rather than pure
    flags, so a fake harness command (a small script that reports its
    canonicalized working directory, its full argument vector, and the
    contents of the files its own "--mcp-config-file" / "--agent-file"
    arguments point at) lets the enforced inputs be asserted by value,
    without a real, installed kimi CLI (skipped on Windows, where the
    POSIX script cannot run)  */
describe("kimi containment", () => {
    const itKimi = process.platform === "win32" ? it.skip : it
    itKimi("materializes a built-in-tool-empty agent and an empty explicit MCP config in the throw-away directory", async () => {
        const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-to-harness-fake-"))
        const fakeCmd = path.join(fakeDir, "fake-harness.sh")
        fs.writeFileSync(fakeCmd,
            "#!/bin/sh\n" +
            "echo \"CWD=$(pwd -P)\"\n" +
            "prev=\"\"\n" +
            "for a in \"$@\"; do\n" +
            "    echo \"ARG=$a\"\n" +
            "    case \"$prev\" in\n" +
            "        --work-dir)        echo \"WORKDIR=$(cd \"$a\" 2>/dev/null && pwd -P)\" ;;\n" +
            "        --mcp-config-file) echo \"MCP<<\"; cat \"$a\"; echo \">>MCP\" ;;\n" +
            "        --agent-file)      echo \"AGENT<<\"; cat \"$a\"; echo \">>AGENT\" ;;\n" +
            "    esac\n" +
            "    prev=\"$a\"\n" +
            "done\n",
            { mode: 0o755 })
        const client = new MCPClient([
            "--service",         "Test kimi",
            "--mcp-tool",        "chat-kimi",
            "--harness",         "kimi",
            "--harness-command", fakeCmd,
            "--harness-model",   "test-model"
        ])
        try {
            await client.initialize()
            const result = await client.callTool("chat-kimi", promptMath)
            assert.notEqual(result.isError, true)
            const lines = result.content[0].text.split("\n")
            const valueLine = (prefix: string): string | undefined => {
                const line = lines.find((l) => l.startsWith(prefix))
                return line === undefined ? undefined : line.slice(prefix.length)
            }
            const args = lines.filter((l) => l.startsWith("ARG=")).map((l) => l.slice(4))
            const block = (start: string, end: string): string =>
                lines.slice(lines.indexOf(start) + 1, lines.indexOf(end)).join("\n")

            /*  with an explicit "--harness-model" the invocation is a
                fixed vector (the explicit flag also overrides any ambient
                $HARNESS_MODEL, so the process environment cannot perturb
                it), so assert the whole argument list by value -- exact
                tokens, exact order, nothing extra. This rejects every
                alias, "--flag=value" and repeated-option form (e.g. "-w",
                a second "--skills-dir", an additive "--mcp-config=...")
                that the kimi CLI would still act on but that a token-name
                count would miss. The variable throw-away path sits at
                args[2]; the remaining paths are pinned relative to it  */
            const workDir = args[2]
            assert.deepEqual(args, [
                "--quiet",
                "--work-dir",        workDir,
                "--skills-dir",      workDir,
                "--mcp-config-file", path.join(workDir, "mcp.json"),
                "--agent-file",      path.join(workDir, "agent.yaml"),
                "--model",           "test-model"
            ])

            /*  and that args[2] is the process's actual working directory,
                compared fully and canonicalized on both sides while the
                directory still exists, so a different parent with the same
                leaf name cannot pass  */
            assert.equal(valueLine("WORKDIR="), valueLine("CWD="))

            /*  the file behind --mcp-config-file (read by the fake harness
                at that very path) has a truly empty server map, so it
                overrides rather than merges the user's default, and the
                file behind --agent-file disables the built-in tools  */
            assert.deepEqual(JSON.parse(block("MCP<<", ">>MCP")).mcpServers, {})
            assert.match(block("AGENT<<", ">>AGENT"), /^\s*tools:\s*\[\]\s*$/m)
        }
        finally {
            client.close()
            fs.rmSync(fakeDir, { recursive: true, force: true })
        }
    }).timeout(30000)
})

