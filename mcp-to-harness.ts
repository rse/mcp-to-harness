#!/usr/bin/env node
/*!
**  mcp-to-harness -- Bridge an MCP chat tool to an AI agent harness CLI
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Distributed under MIT license <https://spdx.org/licenses/MIT.html>
*/

/*  built-in dependencies  */
import os                       from "node:os"
import path                     from "node:path"
import fs                       from "node:fs/promises"
import fsSync                   from "node:fs"
import process                  from "node:process"
import { fileURLToPath }        from "node:url"

/*  external dependencies  */
import * as dotenvx             from "@dotenvx/dotenvx"
import { Command, Option }      from "commander"
import { execa }                from "execa"
import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z }                    from "zod"

/*  internal dependencies  */
import { harnessTypes, envAllowlistCommon }                          from "./mcp-to-harness-common.js"
import type { Harness, HarnessConfig, HarnessDriver, HarnessWorker } from "./mcp-to-harness-common.js"
import { claudeDriver }                                              from "./mcp-to-harness-claude.js"
import { codexDriver }                                               from "./mcp-to-harness-codex.js"
import { copilotDriver }                                             from "./mcp-to-harness-copilot.js"

/*  own package information
    (read package.json at run-time relative to this module, so it
    resolves both when run as source and when run as compiled dist/ output)  */
const pkgFile = [ "./package.json", "../package.json" ]
    .map((rel)  => fileURLToPath(new URL(rel, import.meta.url)))
    .find((file) => fsSync.existsSync(file))
if (pkgFile === undefined)
    throw new Error("cannot locate package.json")
const pkg = JSON.parse(fsSync.readFileSync(pkgFile, "utf8")) as
    { name: string, version: string }

/*  load potential .env file into the environment
    (optional, so stay silent if absent)  */
dotenvx.config({ quiet: true, ignore: [ "MISSING_ENV_FILE" ] })

/*  emit a fatal error and terminate the process  */
const fatal = (msg: string): never => {
    process.stderr.write(`${pkg.name}: ERROR: ${msg}\n`)
    process.exit(1)
}

/*  parse the command-line options (flags take precedence over environment variables)  */
const program = new Command()
program
    .name(pkg.name)
    .description("Bridge an MCP chat tool to an AI agent harness CLI")
    .version(`${pkg.name} ${pkg.version}`, "-V, --version", "show program version information")
    .helpOption("-h, --help", "show this usage help")
    .addOption(new Option("-s, --service <service>", "name of AI service")
        .env("SERVICE"))
    .addOption(new Option("-t, --mcp-tool <tool>", "MCP tool name")
        .env("MCP_TOOL"))
    .addOption(new Option("-a, --harness <type>", "AI agent harness type")
        .choices(harnessTypes)
        .env("HARNESS"))
    .addOption(new Option("-c, --harness-command <command>", "AI agent harness CLI command")
        .env("HARNESS_COMMAND"))
    .addOption(new Option("-m, --harness-model <model>", "AI agent harness model identifier")
        .env("HARNESS_MODEL"))
    .addOption(new Option("-p, --harness-prompt <prompt>", "AI agent harness system prompt")
        .env("HARNESS_PROMPT"))
    .addOption(new Option("-T, --harness-timeout <ms>", "AI agent harness execution timeout")
        .env("HARNESS_TIMEOUT").default("300000"))
    .addOption(new Option("-P, --harness-pool <n>", "AI agent harness worker pool size (0 for one-shot execution)")
        .env("HARNESS_POOL").default("0"))
    .addOption(new Option("-I, --harness-pool-idle <ms>", "AI agent harness worker pool idle timeout")
        .env("HARNESS_POOL_IDLE").default("120000"))
    .addHelpText("after",
        "\n" +
        "Example:\n" +
        "  $ claude mcp add \\\n" +
        "    --scope user \\\n" +
        "    --transport stdio \\\n" +
        "    -- \\\n" +
        "    chat-openai-codex \\\n" +
        `    ${pkg.name} \\\n` +
        "      --service       \"OpenAI Codex\" \\\n" +
        "      --mcp-tool      chat-openai-codex \\\n" +
        "      --harness       codex \\\n" +
        "      --harness-model gpt-5\n"
    )
    .allowExcessArguments(false)
    .parse()

const opts = program.opts<{
    service?:        string
    mcpTool?:        string
    harness?:        Harness
    harnessCommand?: string
    harnessModel?:   string
    harnessPrompt?:  string
    harnessTimeout:  string
    harnessPool:     string
    harnessPoolIdle: string
}>()

/*  resolve the effective configuration and ensure all required values are present  */
const SERVICE           = opts.service        ?? fatal("service required (use --service or $SERVICE)")
const MCP_TOOL          = opts.mcpTool        ?? fatal("MCP tool required (use --mcp-tool or $MCP_TOOL)")
const HARNESS           = opts.harness        ?? fatal("harness type required (use --harness or $HARNESS)")
const HARNESS_COMMAND   = opts.harnessCommand ?? HARNESS
const HARNESS_MODEL     = opts.harnessModel
const HARNESS_PROMPT    = opts.harnessPrompt
const HARNESS_TIMEOUT   = opts.harnessTimeout
const HARNESS_POOL      = opts.harnessPool
const HARNESS_POOL_IDLE = opts.harnessPoolIdle

/*  parse and validate the execution timeout  */
const timeoutMs = Number(HARNESS_TIMEOUT)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    fatal(`invalid harness timeout "${HARNESS_TIMEOUT}" (use a positive integer of milliseconds)`)

/*  parse and validate the worker pool size and idle timeout  */
const poolSize = Number(HARNESS_POOL)
if (!Number.isSafeInteger(poolSize) || poolSize < 0)
    fatal(`invalid harness pool size "${HARNESS_POOL}" (use a non-negative integer)`)
const poolIdleMs = Number(HARNESS_POOL_IDLE)
if (!Number.isSafeInteger(poolIdleMs) || poolIdleMs <= 0)
    fatal(`invalid harness pool idle timeout "${HARNESS_POOL_IDLE}" (use a positive integer of milliseconds)`)

/*  the maximum number of requests served by a single pool worker before
    it is recycled (insurance against slow resource accumulation inside
    a long-lived harness CLI process)  */
const poolWorkerMaxUses = 100

/*  the per-harness driver  */
const drivers: Record<Harness, HarnessDriver> = {
    claude:  claudeDriver,
    codex:   codexDriver,
    copilot: copilotDriver
}
const driver = drivers[HARNESS]

/*  the effective harness configuration handed to the driver  */
const config: HarnessConfig = {
    command:       HARNESS_COMMAND,
    model:         HARNESS_MODEL,
    prompt:        HARNESS_PROMPT,
    bridgeName:    pkg.name,
    bridgeVersion: pkg.version
}

/*  build a minimized child environment from the explicit allowlist
    (never the inherited parent environment) and force headless mode so
    that -- when the child harness has hooks installed which emit a
    session banner -- those hooks can suppress it instead of leaking it
    into the captured answer  */
const buildEnv = (): Record<string, string> => {
    const env: Record<string, string> = { ASE_HEADLESS: "true" }
    for (const key of [ ...envAllowlistCommon, ...driver.envAllowlist ])
        if (process.env[key] !== undefined)
            env[key] = process.env[key]
    return env
}

/*  create a throw-away working directory so the harness CLI cannot
    read or write anything relevant in the current project  */
const makeWorkDir = (): Promise<string> =>
    fs.mkdtemp(path.join(os.tmpdir(), `${pkg.name}-`))

/*  best-effort removal of a throw-away working directory,
    surfacing (but not propagating) a removal failure on stderr  */
const removeWorkDir = (dir: string): Promise<void> =>
    fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`${pkg.name}: WARNING: failed to remove temporary directory ${dir}: ${message}\n`)
    })

/*  query the AI agent harness CLI in a strictly non-interactive,
    one-shot fashion and return its final answer: the CLI is rooted in a
    throw-away temporary working directory, runs with a minimized
    environment assembled from an explicit allowlist, and is bounded by a
    hard timeout and the caller's cancellation signal  */
const queryHarnessOneShot = async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const dir = await makeWorkDir()
    try {
        /*  assemble the harness-specific CLI invocation  */
        const invocation = driver.assembleInvocation(config, prompt, dir)

        /*  run the harness CLI with the minimized environment, the prompt
            piped on stdin (where supported), a hard timeout, and the
            caller's cancellation signal wired through, never throwing on
            a non-zero exit so we can surface a clean MCP error  */
        const result = await execa(HARNESS_COMMAND, invocation.args, {
            cwd:          dir,
            env:          buildEnv(),
            extendEnv:    false,
            input:        invocation.input,
            timeout:      timeoutMs,
            cancelSignal: signal,
            reject:       false
        })
        if (result.failed) {
            if (result.timedOut)
                throw new Error(`harness CLI timed out after ${timeoutMs}ms`)
            if (result.isCanceled)
                throw new Error("harness CLI execution was canceled")
            const detail = result.stderr.trim() !== "" ?
                result.stderr.trim() : (result.originalMessage ?? "")
            throw new Error("harness CLI failed" +
                (typeof result.exitCode === "number" ? ` (exit code: ${result.exitCode})` : "") +
                (detail !== "" ? `: ${detail}` : ""))
        }

        /*  determine the final answer: from the dedicated output file
            (where the harness supports one), falling back to stdout  */
        let answer = ""
        if (invocation.output !== undefined)
            answer = await fs.readFile(invocation.output, "utf8").catch(() => "")
        if (answer.trim() === "")
            answer = result.stdout
        return answer
    }
    finally {
        await removeWorkDir(dir)
    }
}

/*  the worker pool for persistent harness CLI processes: workers are
    spawned lazily on demand (so the worst case equals the one-shot
    behavior), reused when idle, retired after an idle period, after a
    maximum number of uses, or whenever they break -- a request timeout
    or cancellation simply kills the worker, since the pool respawns
    lazily and a poisoned conversation must never leak into the next
    request  */
interface PoolEntry {
    worker:    HarnessWorker
    dir:       string
    busy:      boolean
    uses:      number
    idleTimer: ReturnType<typeof setTimeout> | null
}
const pool: PoolEntry[] = []
let poolSlotsInUse = 0
const poolWaiters: (() => void)[] = []

/*  retire a pool worker: remove it from the pool, terminate its process
    and remove its working directory  */
const poolRetire = async (entry: PoolEntry): Promise<void> => {
    const idx = pool.indexOf(entry)
    if (idx >= 0)
        pool.splice(idx, 1)
    if (entry.idleTimer !== null)
        clearTimeout(entry.idleTimer)
    await entry.worker.dispose().catch(() => { /* intentionally ignored */ })
    await removeWorkDir(entry.dir)
}

/*  park a pool worker as idle and arm its idle retirement timer  */
const poolParkIdle = (entry: PoolEntry): void => {
    entry.busy = false
    entry.idleTimer = setTimeout(() => {
        if (!entry.busy)
            poolRetire(entry).catch(() => { /* intentionally ignored */ })
    }, poolIdleMs)
    entry.idleTimer.unref()
}

/*  query the AI agent harness CLI through a pooled persistent worker
    process and return its final answer: a free capacity slot is awaited
    (bounding the number of concurrent workers), then an idle worker is
    reused or a new one spawned, and the request runs as an isolated
    conversation bounded by a hard timeout and the caller's cancellation
    signal  */
const queryHarnessPooled = async (prompt: string, signal?: AbortSignal): Promise<string> => {
    /*  acquire a capacity slot (released slots are handed over to the
        longest-waiting request first)  */
    if (poolSlotsInUse >= poolSize)
        await new Promise<void>((resolve) => poolWaiters.push(resolve))
    else
        poolSlotsInUse++
    let entry: PoolEntry | undefined
    try {
        /*  fail fast when the request got canceled while awaiting
            the capacity slot, instead of spawning a worker just to fail  */
        if (signal?.aborted === true)
            throw new Error("harness CLI execution was canceled")

        /*  reuse an idle worker, retiring the ones found broken  */
        for (;;) {
            entry = pool.find((e) => !e.busy)
            if (entry === undefined)
                break
            entry.busy = true
            if (entry.idleTimer !== null) {
                clearTimeout(entry.idleTimer)
                entry.idleTimer = null
            }
            if (!entry.worker.broken())
                break
            await poolRetire(entry)
            entry = undefined
        }

        /*  or else spawn a fresh worker on demand  */
        if (entry === undefined) {
            const dir = await makeWorkDir()
            let worker: HarnessWorker
            try {
                worker = await driver.spawnWorker(config, dir, buildEnv())
            }
            catch (err: unknown) {
                await removeWorkDir(dir)
                throw err
            }
            entry = { worker, dir, busy: true, uses: 0, idleTimer: null }
            pool.push(entry)
        }

        /*  perform the isolated request  */
        const answer = await entry.worker.query(prompt, timeoutMs, signal)
        entry.uses++

        /*  recycle exhausted or broken workers, park the healthy ones  */
        if (entry.worker.broken() || entry.uses >= poolWorkerMaxUses)
            await poolRetire(entry)
        else
            poolParkIdle(entry)
        entry = undefined
        return answer
    }
    catch (err: unknown) {
        /*  a failed request never returns its worker to the pool  */
        if (entry !== undefined)
            await poolRetire(entry)
        throw err
    }
    finally {
        /*  release the capacity slot  */
        const next = poolWaiters.shift()
        if (next !== undefined)
            next()
        else
            poolSlotsInUse--
    }
}

/*  query the AI agent harness CLI (one-shot or pooled) and return its
    final, whitespace-trimmed, non-empty answer  */
const queryHarness = async (prompt: string, signal?: AbortSignal): Promise<string> => {
    let answer = poolSize > 0 ?
        await queryHarnessPooled(prompt, signal) :
        await queryHarnessOneShot(prompt, signal)
    answer = answer.trim()
    if (answer === "")
        throw new Error("harness CLI returned an empty answer")
    return answer
}

/*  establish the MCP server  */
const server = new McpServer({
    name:    pkg.name,
    version: pkg.version
})

/*  register the single tool which relays to the configured AI agent harness  */
server.registerTool(
    MCP_TOOL,
    {
        title: `Chat with ${SERVICE}`,
        description:
            `Chat with ${SERVICE} AI service (through its locally installed ` +
            "AI agent harness CLI, used here purely in a one-shot, non-interactive " +
            "query mode as a chat-completion substitute, authenticating via the " +
            "CLI's own configured credentials). " +
            "Provide chat prompt in \"prompt\" parameter. " +
            "Receive chat response in \"text\" field.",
        inputSchema: {
            prompt: z.string().min(1)
                .describe(`The prompt to send to ${SERVICE} AI service.`)
        }
    },
    async ({ prompt }, extra) => {
        try {
            /*  execute the harness CLI and tunnel its answer to MCP  */
            const answer = await queryHarness(prompt, extra.signal)
            return {
                content: [ { type: "text", text: answer } ]
            }
        }
        catch (error: unknown) {
            /*  tunnel exception to MCP  */
            const errorMessage = error instanceof Error ? error.message : String(error)
            process.stderr.write(`${pkg.name}: WARNING: harness execution error: ${errorMessage}\n`)
            return {
                isError: true,
                content: [ { type: "text", text: `ERROR: ${errorMessage}` } ]
            }
        }
    }
)

/*  gracefully shut down: retire all pool workers and terminate  */
let shuttingDown = false
const shutdown = (): void => {
    if (shuttingDown)
        return
    shuttingDown = true
    Promise.all(pool.slice().map((entry) => poolRetire(entry)))
        .catch(() => { /* intentionally ignored */ })
        .finally(() => process.exit(0))
}
process.on("SIGINT",  shutdown)
process.on("SIGTERM", shutdown)

/*  main entry point  */
const main = async (): Promise<void> => {
    const transport = new StdioServerTransport()
    await server.connect(transport)

    /*  when the MCP host closes the transport, take the
        pool workers down with it  */
    server.server.onclose = shutdown
}
main().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error)
    fatal(msg)
})

