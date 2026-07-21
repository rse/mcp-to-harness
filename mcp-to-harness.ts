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
import process                  from "node:process"
import { readFileSync }         from "node:fs"
import { fileURLToPath }        from "node:url"

/*  external dependencies  */
import * as dotenvx             from "@dotenvx/dotenvx"
import { Command, Option }      from "commander"
import { execa }                from "execa"
import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z }                    from "zod"

/*  internal dependencies
    (read package.json at run-time relative to this module, so it
    resolves both when run as source and when run as compiled dist/ output)  */
const pkg = JSON.parse(readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as
    { name: string, version: string }

/*  load potential .env file into the environment
    (optional, so stay silent if absent)  */
dotenvx.config({ quiet: true, ignore: [ "MISSING_ENV_FILE" ] })

/*  emit a fatal error and terminate the process  */
const fatal = (msg: string): never => {
    process.stderr.write(`${pkg.name}: ERROR: ${msg}\n`)
    process.exit(1)
}

/*  the supported AI agent harness types  */
type Harness = "claude" | "codex" | "copilot"

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
        .choices([ "claude", "codex", "copilot" ])
        .env("HARNESS"))
    .addOption(new Option("-c, --harness-command <command>", "AI agent harness CLI command")
        .env("HARNESS_COMMAND"))
    .addOption(new Option("-m, --harness-model <model>", "AI agent harness model identifier")
        .env("HARNESS_MODEL"))
    .addOption(new Option("-p, --harness-prompt <prompt>", "AI agent harness system prompt")
        .env("HARNESS_PROMPT"))
    .addOption(new Option("-T, --harness-timeout <ms>", "AI agent harness execution timeout")
        .env("HARNESS_TIMEOUT").default("300000"))
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
}>()

/*  resolve the effective configuration and ensure all required values are present  */
const SERVICE          = opts.service        ?? fatal("service required (use --service or $SERVICE)")
const MCP_TOOL         = opts.mcpTool        ?? fatal("MCP tool required (use --mcp-tool or $MCP_TOOL)")
const HARNESS          = opts.harness        ?? fatal("harness type required (use --harness or $HARNESS)")
const HARNESS_COMMAND  = opts.harnessCommand ?? HARNESS
const HARNESS_MODEL    = opts.harnessModel
const HARNESS_PROMPT   = opts.harnessPrompt
const HARNESS_TIMEOUT  = opts.harnessTimeout

/*  parse and validate the execution timeout  */
const timeoutMs = parseInt(HARNESS_TIMEOUT, 10)
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    fatal(`invalid harness timeout "${HARNESS_TIMEOUT}" (use a positive integer of milliseconds)`)

/*  the minimal set of parent environment variables passed through to the
    child harness CLI: the executable search path and home directory, the
    user identity (macOS keychain lookups of Claude Code require it), the
    terminal type, the standard HTTP(S) proxy variables (the "extendEnv:
    false" isolation would otherwise cut off network access from behind a
    corporate proxy), plus per-harness authentication and configuration
    relocation variables; every other variable in the parent environment
    is deliberately withheld  */
const envAllowlistCommon = [
    "PATH", "HOME", "USER", "LOGNAME", "TERM",
    "HTTP_PROXY",  "HTTPS_PROXY",  "NO_PROXY",  "ALL_PROXY",
    "http_proxy",  "https_proxy",  "no_proxy",  "all_proxy"
]
const envAllowlistHarness: Record<Harness, string[]> = {
    claude:  [ "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME" ],
    codex:   [ "CODEX_HOME",        "XDG_CONFIG_HOME" ],
    copilot: [ "GITHUB_TOKEN",      "GH_TOKEN",          "XDG_CONFIG_HOME" ]
}

/*  the harness-specific CLI invocation  */
interface Invocation {
    args:    string[]
    input:   string
    output?: string
}

/*  assemble the harness-specific, strictly non-interactive CLI invocation:
    every harness runs as a one-shot query, rooted in a throw-away temporary
    working directory, with its built-in tool surfaces (shell execution,
    file editing, web access, MCP servers) switched off as far as the
    respective CLI allows -- the harness is used purely as a
    chat-completion substitute, not as an autonomous agent  */
const assembleInvocation = (harness: Harness, prompt: string, dir: string): Invocation => {
    if (harness === "claude") {
        /*  Anthropic Claude Code CLI (flags verified against 2.x):
            print mode with plain text output, all customizations disabled
            ("--safe-mode": no hooks, plugins, MCP servers, CLAUDE.md, or
            skills), all built-in tools disabled ("--tools" with an empty
            list), MCP servers restricted to the (empty) explicit
            configuration (prevents the child from re-entering this very
            bridge through a user-scope MCP registration, which would
            recurse indefinitely), and no session persisted to disk. The
            prompt is passed on stdin, so an arbitrarily long prompt
            neither overflows the argument list (E2BIG) nor becomes
            visible in the process table  */
        const args = [
            "--print", "--output-format", "text",
            "--safe-mode", "--tools", "",
            "--strict-mcp-config", "--no-session-persistence"
        ]
        if (HARNESS_MODEL !== undefined)
            args.push("--model", HARNESS_MODEL)
        if (HARNESS_PROMPT !== undefined)
            args.push("--system-prompt", HARNESS_PROMPT)
        return { args, input: prompt }
    }
    else if (harness === "codex") {
        /*  OpenAI Codex CLI (flags verified against 0.14x): skip the
            Git-repository requirement (the cwd is a bare temp directory),
            confine the sandbox to read-only, disable ANSI coloring, avoid
            persisting a session, ignore the user-level configuration and
            execpolicy rules (prevents the child from re-entering this
            very bridge through a user-scope MCP registration and keeps
            foreign MCP tools out of the query -- authentication still
            resolves from "$CODEX_HOME"), switch off the built-in tool
            surfaces via feature flags (shell execution, web search, image
            generation, multi-agent spawning, hosted apps MCP), root the
            agent in the temp directory, and capture just the final agent
            message in a dedicated output file rather than the noisy event
            transcript on stdout. The prompt is passed on stdin ("-"), the
            optional system prompt is prepended as a preamble (the CLI
            offers no separate system prompt channel)  */
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
        if (HARNESS_MODEL !== undefined)
            args.push("--model", HARNESS_MODEL)
        args.push("-")
        const input = HARNESS_PROMPT !== undefined ? `${HARNESS_PROMPT}\n\n${prompt}` : prompt
        return { args, input, output }
    }
    else {
        /*  GitHub Copilot CLI (flags verified against 1.0.x):
            non-interactive prompt mode with response-only output, no
            coloring, an empty available-tools list (strips all tools from
            the model), built-in MCP servers disabled, no custom
            instructions loaded, no interactive questions asked, no
            automatic self-update, no session export, and logging switched
            off. The CLI offers neither a stdin prompt channel nor a
            separate system prompt channel, so the prompt travels as an
            argument and the optional system prompt is prepended as a
            preamble  */
        const promptText = HARNESS_PROMPT !== undefined ? `${HARNESS_PROMPT}\n\n${prompt}` : prompt
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
        if (HARNESS_MODEL !== undefined)
            args.push("--model", HARNESS_MODEL)
        return { args, input: "" }
    }
}

/*  query the AI agent harness CLI in a strictly non-interactive fashion and
    return its final answer: the CLI is rooted in a throw-away temporary
    working directory, runs with a minimized environment assembled from an
    explicit allowlist, and is bounded by a hard timeout and the caller's
    cancellation signal  */
const queryHarness = async (prompt: string, signal?: AbortSignal): Promise<string> => {
    /*  create a throw-away working directory so the harness CLI cannot
        read or write anything relevant in the current project  */
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${pkg.name}-`))
    try {
        /*  assemble the harness-specific CLI invocation  */
        const invocation = assembleInvocation(HARNESS, prompt, dir)

        /*  build a minimized child environment from the explicit
            allowlist (never the inherited parent environment) and force
            headless mode so that -- when the child harness has session
            banner emitting hooks installed -- those hooks can suppress
            their banner instead of leaking it into the captured answer  */
        const env: Record<string, string> = { ASE_HEADLESS: "true" }
        for (const key of [ ...envAllowlistCommon, ...envAllowlistHarness[HARNESS] ])
            if (process.env[key] !== undefined)
                env[key] = process.env[key]

        /*  run the harness CLI with the minimized environment, the prompt
            piped on stdin (where supported), a hard timeout, and the
            caller's cancellation signal wired through, never throwing on
            a non-zero exit so we can surface a clean MCP error  */
        const result = await execa(HARNESS_COMMAND, invocation.args, {
            cwd:          dir,
            env,
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
        answer = answer.trim()
        if (answer === "")
            throw new Error("harness CLI returned an empty answer")
        return answer
    }
    finally {
        /*  best-effort cleanup of the throw-away working directory,
            surfacing (but not propagating) a removal failure on stderr  */
        await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            process.stderr.write(`${pkg.name}: WARNING: failed to remove temporary directory ${dir}: ${message}\n`)
        })
    }
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

/*  main entry point  */
async function main () {
    const transport = new StdioServerTransport()
    await server.connect(transport)
}
main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error)
    fatal(msg)
})

