# pi-agent-mode

OpenCode-style default agent system for [PI](https://pi.dev) coding agent.

Define agents as markdown files with YAML frontmatter, select a default agent, and have **all prompts processed through that agent inline** — with full real-time streaming visibility. No subprocess subagents.

This fork keeps agent selection on explicit entry points only:

- `pi --agent <name>` at startup
- `/agent` commands during a session

Keyboard shortcuts are not registered.

## Features

- **Markdown agent definitions** — Simple YAML frontmatter + body
- **Default agent at startup** — Set in `.pi/settings.json` or pass `--agent`
- **Command-driven selection** — `/agent`, `/agents`, `/agent-search`
- **Visual indicator** — Widget banner above editor shows active agent
- **Model & tool restriction** — Per-agent model and tool sets
- **Agent search** — `/agent-search <query>` to find agents by name, description, or body content
- **Autonomous switching** — `set_agent` tool for LLM-driven switches
- **Session persistence** — Active agent survives session resume

## Install

```bash
pi install https://github.com/k10876/agent-mode
```

Or for project-local:

```bash
pi install https://github.com/k10876/agent-mode -l
```

Upstream npm package (includes keyboard shortcuts):

```bash
pi install npm:pi-agent-mode
```

## Agent Definition Format

Create `.md` files in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project-local):

```markdown
---
name: planner
description: Planning specialist - create detailed plans before implementation
model: anthropic/claude-sonnet-4
tools: read, bash, grep, find, ls
---
You are a PLANNING SPECIALIST. Your job is to deeply understand the problem and create a detailed implementation plan.

Rules:
- DO NOT make any changes. You cannot edit or write files.
- Read files IN FULL (no offset/limit) to get complete context.
- Explore thoroughly: grep for related code, find similar patterns.
- Ask clarifying questions if requirements are ambiguous.

Output:
- Create a structured plan with numbered steps.
- For each step: what to change, why, and potential risks.
- List files that will be modified.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent identifier (used with `/agent name`) |
| `description` | No | Shown in selector and widget |
| `model` | No | `provider/model-id` format (e.g. `anthropic/claude-sonnet-4`) |
| `tools` | No | Comma-separated tool names to restrict to |

The markdown body after frontmatter becomes the agent's system prompt instructions.

## Usage

### Commands

- `/agent` — Show selector to pick an agent
- `/agent <name>` — Switch directly to an agent
- `/agent clear` — Clear active agent, restore defaults
- `/agents` — List all available agents
- `/agent-search <query>` — Search agents by name, description, or body content

### CLI

```bash
pi --agent planner
```

### Settings

Set default agent in `.pi/settings.json`:

```json
{
  "defaultAgent": "planner"
}
```

### Autonomous Switching

The LLM can call the `set_agent` tool to switch agents programmatically:

```json
{
  "agent": "implementer",
  "reason": "Planning complete, switching to implementation"
}
```

### Searching Agents

The LLM can search for agents by content using the `search_agents` tool:

```json
{
  "query": "planning",
  "limit": 5
}
```

This searches agent names, descriptions, models, tools, and body content, returning ranked results with relevance scores.

## How It Works vs Subagents

| Feature | pi-agent-mode | Subagents |
|---------|---------------|-----------|
| Process | Inline (same process) | Separate subprocess |
| Visibility | Full streaming | Results after completion |
| Invocation | Default for all prompts | Explicit tool call |
| Switching | `/agent` or `pi --agent` | Must specify agent each time |

## License

MIT
