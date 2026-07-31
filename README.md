
MCP-to-Harness
==============

**Bridge an MCP chat tool to an AI agent harness CLI**

<p/>
<img src="https://nodei.co/npm/mcp-to-harness.png?downloads=true&stars=true" alt=""/>

<p/>

[![github (author stars)](https://img.shields.io/github/stars/rse?logo=github&label=author%20stars&color=%233377aa)](https://github.com/rse)
[![github (author followers)](https://img.shields.io/github/followers/rse?label=author%20followers&logo=github&color=%234477aa)](https://github.com/rse)

Abstract
--------

This is a small Command-Line Interface (CLI) for conveniently bridging
an MCP chat tool to a locally installed AI agent harness CLI, either
Anthropic Claude Code CLI (`claude`), OpenAI Codex CLI (`codex`), or
GitHub Copilot CLI (`copilot`). This allows accessing foreign LLMs from
within MCP host applications, like *Claude Code*, without any additional
API keys: the harness authenticates via its own configured credentials
(typically an existing AI service subscription).

The **MCP-to-Harness** program runs as an MCP `stdio` transport based
server and, once per incoming request, executes the harness CLI in
a strictly one-shot, non-interactive, tool-less query mode as a
chat-completion substitute.

Alternatively, when using the option `--harness-pool` with a value
greater than 0, the harness CLI is kept running as a pool of persistent
worker processes instead, which saves the process startup time on every
request while still keeping the requests strictly isolated from each
other:

-   Claude Code runs in its streaming JSON mode with a conversation reset
    (`/clear`) before every request
-   Codex runs as its own MCP server (`codex mcp-server`) with a fresh
    session per tool call
-   Copilot runs as an Agent Client Protocol (ACP) server (`copilot
    --acp`) with a fresh session per request and a relocated, throw-away
    session store.

Workers are spawned lazily on demand, reused when idle, retired after an
idle period (see option `--harness-pool-idle`), recycled after at most
100 served requests, and killed on a request timeout or cancellation (a
poisoned conversation never leaks into the next request).

> [!NOTE]
> The agent harness CLI is contained as far as its command-line options
> allow (temporary working directory, minimized environment, disabled
> tools, disabled MCP servers, ignored user configurations, relocated
> session stores), but this is defense in depth, not a sealed box. Treat
> this bridge exactly like a locally launched harness CLI.

Installation
------------

```
$ npm install -g mcp-to-harness
```

Usage
-----

```
Usage: mcp-to-harness [options]

Bridge an MCP chat tool to an AI agent harness CLI

Options:
  -V, --version                    show program version information
  -s, --service <service>          name of AI service (env: SERVICE)
  -t, --mcp-tool <tool>            MCP tool name (env: MCP_TOOL)
  -a, --harness <type>             AI agent harness type (choices: "claude",
                                   "codex", "copilot", env: HARNESS)
  -c, --harness-command <command>  AI agent harness CLI command (env:
                                   HARNESS_COMMAND)
  -m, --harness-model <model>      AI agent harness model identifier (env:
                                   HARNESS_MODEL)
  -p, --harness-prompt <prompt>    AI agent harness system prompt (env:
                                   HARNESS_PROMPT)
  -T, --harness-timeout <ms>       AI agent harness execution timeout (default:
                                   "300000", env: HARNESS_TIMEOUT)
  -P, --harness-pool <n>           AI agent harness worker pool size (0 for
                                   one-shot execution) (default: "0", env:
                                   HARNESS_POOL)
  -I, --harness-pool-idle <ms>     AI agent harness worker pool idle timeout
                                   (default: "120000", env: HARNESS_POOL_IDLE)
  -h, --help                       show this usage help

Example:
  $ claude mcp add \
    --scope user \
    --transport stdio \
    -- \
    chat-openai-codex \
    mcp-to-harness \
      --service       "OpenAI Codex" \
      --mcp-tool      chat-openai-codex \
      --harness       codex \
      --harness-model gpt-5
```

License
-------

Copyright &copy; 2026 Dr. Ralf S. Engelschall (http://engelschall.com/)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

