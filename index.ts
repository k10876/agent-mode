/**
 * Agent Mode Extension
 *
 * OpenCode-style default agent system for PI. Define agents as markdown files
 * with YAML frontmatter, select a default agent, and have all prompts processed
 * through that agent with full real-time visibility.
 *
 * Agent definitions (merged, project overrides global):
 * - ~/.pi/agent/agents/*.md (global)
 * - <cwd>/.pi/agents/*.md (project-local)
 *
 * Example agent file (e.g., ~/.pi/agent/agents/planner.md):
 * ```markdown
 * ---
 * name: planner
 * description: Planning specialist
 * model: anthropic/claude-sonnet-4-5
 * tools: read, bash, grep, find, ls
 * ---
 * You are a planning specialist. Create detailed plans before implementation.
 * Focus on understanding requirements fully before proposing solutions.
 * ```
 *
 * Usage:
 * - `/agent` — Show selector to switch agents
 * - `/agent <name>` — Switch to agent directly
 * - `/agent-search <query>` — Search agents by name, description, or body
 * - `pi --agent <name>` — Start with an agent selected
 * - Set default in `.pi/settings.json`: `{ "defaultAgent": "planner" }`
 * - Agent runs inline (same process) with full streaming visibility
 *
 * Keyboard shortcuts are intentionally not registered. Agent selection is only
 * via `pi --agent` at startup or the `/agent` family of commands.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentDefinition {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	body: string;
}

interface Settings {
	defaultAgent?: string;
}

interface OriginalState {
	model: Model<Api> | undefined;
	// Note: we deliberately do NOT snapshot active tools here. Tools registered
	// asynchronously by other extensions (e.g. MCP servers) only show up in
	// pi.getAllTools() after their connection settles, which usually happens
	// AFTER session_start. Snapshotting at apply-time would lock those out.
	// Instead, applyAgentTools() recomputes the active set from
	// pi.getAllTools() each time, treating agent.tools as a whitelist for
	// builtin tools only.
}

interface SearchResult {
	name: string;
	agent: AgentDefinition;
	score: number;
	snippets: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadSettings(cwd: string): Settings {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");

	let settings: Settings = {};

	for (const path of [globalPath, projectPath]) {
		if (existsSync(path)) {
			try {
				const content = readFileSync(path, "utf-8");
				const parsed = JSON.parse(content) as Settings;
				settings = { ...settings, ...parsed };
			} catch {
				/* ignore invalid json */
			}
		}
	}

	return settings;
}

function findAgentFiles(...dirs: string[]): string[] {
	const files: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(join(dir, entry.name));
			}
		}
	}
	return files;
}

function parseAgentFile(filePath: string): AgentDefinition | undefined {
	const content = readFileSync(filePath, "utf-8");

	// Simple frontmatter parser
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return undefined;

	const frontmatter = match[1];
	const body = match[2].trim();

	const agent: Partial<AgentDefinition> = { body };

	for (const line of frontmatter.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();

		switch (key) {
			case "name":
				agent.name = value;
				break;
			case "description":
				agent.description = value;
				break;
			case "model":
				agent.model = value;
				break;
			case "tools":
				agent.tools = value.split(",").map((t: string) => t.trim()).filter(Boolean);
				break;
		}
	}

	if (!agent.name) {
		// Fallback to filename without extension
		agent.name = filePath.split(/[\/]/).pop()?.replace(/\.md$/, "") ?? "unknown";
	}

	return agent as AgentDefinition;
}

function loadAgents(cwd: string): Map<string, AgentDefinition> {
	const globalDir = join(getAgentDir(), "agents");
	const projectDir = join(cwd, ".pi", "agents");

	// Project agents override global agents with the same name
	const agents = new Map<string, AgentDefinition>();

	for (const file of findAgentFiles(globalDir)) {
		const agent = parseAgentFile(file);
		if (agent) agents.set(agent.name, agent);
	}

	for (const file of findAgentFiles(projectDir)) {
		const agent = parseAgentFile(file);
		if (agent) agents.set(agent.name, agent);
	}

	return agents;
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slashIdx = ref.indexOf("/");
	if (slashIdx === -1) return undefined;
	return {
		provider: ref.slice(0, slashIdx),
		modelId: ref.slice(slashIdx + 1),
	};
}

// ─── Search Helpers ──────────────────────────────────────────────────────────

/**
 * Calculate search relevance score for an agent.
 * Higher score = better match.
 */
function scoreAgent(agent: AgentDefinition, query: string): number {
	const q = query.toLowerCase();
	let score = 0;

	// Exact name match (highest priority)
	if (agent.name.toLowerCase() === q) score += 100;
	// Name contains query
	else if (agent.name.toLowerCase().includes(q)) score += 50;

	// Description match
	if (agent.description?.toLowerCase().includes(q)) score += 30;

	// Model match
	if (agent.model?.toLowerCase().includes(q)) score += 20;

	// Tools match
	if (agent.tools?.some((t) => t.toLowerCase().includes(q))) score += 15;

	// Body content match
	const bodyLower = agent.body.toLowerCase();
	const bodyMatches = (bodyLower.match(new RegExp(q, "g")) || []).length;
	score += Math.min(bodyMatches * 5, 25); // Cap body score

	return score;
}

/**
 * Extract context snippets around query matches in text.
 */
function extractSnippets(text: string, query: string, maxSnippets = 2, snippetLength = 40): string[] {
	const q = query.toLowerCase();
	const lower = text.toLowerCase();
	const snippets: string[] = [];
	let pos = 0;

	while (pos < lower.length && snippets.length < maxSnippets) {
		const idx = lower.indexOf(q, pos);
		if (idx === -1) break;

		const start = Math.max(0, idx - snippetLength);
		const end = Math.min(text.length, idx + q.length + snippetLength);
		let snippet = text.slice(start, end);

		// Add ellipsis
		if (start > 0) snippet = "…" + snippet;
		if (end < text.length) snippet = snippet + "…";

		// Highlight match
		const matchStart = start > 0 ? 1 : 0;
		snippet = snippet.slice(0, matchStart + idx - start) +
			"**" + snippet.slice(matchStart + idx - start, matchStart + idx - start + q.length) + "**" +
			snippet.slice(matchStart + idx - start + q.length);

		snippets.push(snippet.replace(/\n/g, " "));
		pos = idx + q.length;
	}

	return snippets;
}

/**
 * Search agents and return ranked results.
 */
function searchAgents(
	agents: Map<string, AgentDefinition>,
	query: string,
	minScore = 1,
): SearchResult[] {
	if (!query.trim()) return [];

	const results: SearchResult[] = [];
	for (const [name, agent] of agents) {
		const score = scoreAgent(agent, query);
		if (score >= minScore) {
			const snippets: string[] = [];
			if (agent.description) {
				snippets.push(...extractSnippets(agent.description, query, 1, 30));
			}
			snippets.push(...extractSnippets(agent.body, query, 2, 35));
			results.push({ name, agent, score, snippets });
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function agentModeExtension(pi: ExtensionAPI) {
	let agents = new Map<string, AgentDefinition>();
	let activeAgentName: string | undefined;
	let activeAgent: AgentDefinition | undefined;
	let originalState: OriginalState | undefined;

	// Register --agent CLI flag
	pi.registerFlag("agent", {
		description: "Default agent to use at startup",
		type: "string",
	});

	/**
	 * Compute and apply the active tool set for the current agent.
	 *
	 * Semantics: agent.tools acts as a WHITELIST FOR BUILTIN TOOLS ONLY.
	 * Tools registered by other extensions (sdk, MCP servers, subagents, etc.)
	 * always remain active so the agent can reach them — the field's purpose is
	 * to let an agent like "researcher" turn off `write`/`edit` (built-ins),
	 * not to lock the LLM out of MCP-provided capabilities that connect
	 * asynchronously.
	 *
	 * Called from applyAgent and from before_agent_start, so tools registered
	 * after the agent was applied (e.g. an MCP server that takes a few seconds
	 * to connect) get folded into the active set on the next turn.
	 */
	function applyAgentTools(): void {
		if (!activeAgent?.tools?.length) return;

		// Normalize the whitelist for case-insensitive comparison.
		const whitelist = new Set(activeAgent.tools.map((t) => t.toLowerCase()));

		const all = pi.getAllTools();
		const merged = all
			.filter((t) => {
				const src = t.sourceInfo?.source;
				// Pass through anything not flagged as builtin (sdk, extension, MCP).
				if (src !== "builtin") return true;
				return whitelist.has(t.name.toLowerCase());
			})
			.map((t) => t.name);

		pi.setActiveTools(merged);
	}

	/**
	 * Apply an agent configuration.
	 */
	async function applyAgent(name: string, agent: AgentDefinition, ctx: ExtensionContext): Promise<boolean> {
		// Snapshot only the model on first apply, so /agent clear can restore it.
		// We deliberately don't snapshot tools — see comment on OriginalState.
		if (activeAgentName === undefined) {
			originalState = {
				model: ctx.model,
			};
		}

		// Apply model if specified (format: provider/model-id)
		if (agent.model) {
			const ref = parseModelRef(agent.model);
			if (ref) {
				const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
				if (model) {
					const success = await pi.setModel(model);
					if (!success) {
						ctx.ui.notify(`Agent "${name}": No API key for ${ref.provider}/${ref.modelId}`, "warning");
					}
				} else {
					ctx.ui.notify(`Agent "${name}": Model ${ref.provider}/${ref.modelId} not found`, "warning");
				}
			} else {
				ctx.ui.notify(`Agent "${name}": Invalid model format "${agent.model}" (expected provider/model-id)`, "warning");
			}
		}

		// Store active agent BEFORE applying tools so applyAgentTools can read it.
		activeAgentName = name;
		activeAgent = agent;

		applyAgentTools();

		return true;
	}

	/**
	 * Restore the default tool set: enable everything that's currently registered.
	 * Called when the active agent is cleared.
	 */
	function restoreAllTools(): void {
		pi.setActiveTools(pi.getAllTools().map((t) => t.name));
	}

	/**
	 * Build description string for an agent.
	 */
	function buildAgentDescription(agent: AgentDefinition): string {
		const parts: string[] = [];

		if (agent.model) {
			parts.push(agent.model);
		}
		if (agent.tools) {
			parts.push(`tools:${agent.tools.join(",")}`);
		}
		if (agent.description) {
			parts.push(agent.description);
		}

		return parts.join(" | ") || "No configuration";
	}

	/**
	 * Render a generic agent selector UI with the given items and header.
	 */
	async function showAgentPicker(
		ctx: ExtensionContext,
		items: SelectItem[],
		headerText: string,
		maxVisible: number,
	): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			// Header
			container.addChild(new Text(theme.fg("accent", theme.bold(headerText))));

			// SelectList with themed styling
			const selectList = new SelectList(items, Math.min(items.length, maxVisible), {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);

			// Footer hint
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));

			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	/**
	 * Handle the result of an agent selection.
	 */
	async function handleAgentSelection(ctx: ExtensionContext, result: string | null): Promise<void> {
		if (!result) return;

		if (result === "(none)") {
			activeAgentName = undefined;
			activeAgent = undefined;
			if (originalState?.model) {
				await pi.setModel(originalState.model);
			}
			restoreAllTools();
			ctx.ui.notify("Agent cleared, defaults restored", "info");
			updateStatus(ctx);
			return;
		}

		const agent = agents.get(result);
		if (agent) {
			await applyAgent(result, agent, ctx);
			/* agent activated silently */
			updateStatus(ctx);
		}
	}

	/**
	 * Show agent selector UI.
	 */
	async function showAgentSelector(ctx: ExtensionContext): Promise<void> {
		const agentNames = Array.from(agents.keys()).sort();

		if (agentNames.length === 0) {
			ctx.ui.notify(
				"No agents found. Create agent files in ~/.pi/agent/agents/ or .pi/agents/",
				"warning",
			);
			return;
		}

		// Build select items with descriptions
		const items: SelectItem[] = agentNames.map((name) => {
			const agent = agents.get(name)!;
			const isActive = name === activeAgentName;
			return {
				value: name,
				label: isActive ? `${name} (active)` : name,
				description: buildAgentDescription(agent),
			};
		});

		// Add "None" option to clear agent
		items.push({
			value: "(none)",
			label: "(none)",
			description: "Clear active agent, restore defaults",
		});

		const result = await showAgentPicker(ctx, items, "Select Agent", 10);
		await handleAgentSelection(ctx, result);
	}

	/**
	 * Show search results UI with selectable agents.
	 */
	async function showSearchResults(ctx: ExtensionContext, query: string): Promise<void> {
		const results = searchAgents(agents, query);

		if (results.length === 0) {
			ctx.ui.notify(`No agents found matching "${query}"`, "warning");
			return;
		}

		// Build select items from search results
		const items: SelectItem[] = results.map((result) => {
			const isActive = result.name === activeAgentName;
			const snippetText = result.snippets.length > 0
				? result.snippets[0].slice(0, 80)
				: buildAgentDescription(result.agent);
			return {
				value: result.name,
				label: isActive ? `${result.name} (active) [score: ${result.score}]` : `${result.name} [score: ${result.score}]`,
				description: snippetText,
			};
		});

		const result = await showAgentPicker(ctx, items, `Search Results: "${query}" (${results.length} found)`, 8);
		await handleAgentSelection(ctx, result);
	}

	/**
	 * Update status indicator and widget.
	 */
	function updateStatus(ctx: ExtensionContext) {
		if (activeAgentName && activeAgent) {
			// Prominent widget above editor
			const description = activeAgent.description
				? ctx.ui.theme.fg("muted", ` — ${activeAgent.description}`)
				: "";
			const modelInfo = activeAgent.model
				? ctx.ui.theme.fg("dim", ` [${activeAgent.model}]`)
				: "";
			const toolsInfo = activeAgent.tools
				? ctx.ui.theme.fg("dim", ` {${activeAgent.tools.join(", ")}}`)
				: "";

			const banner =
				ctx.ui.theme.fg("accent", "▸ ") +
				ctx.ui.theme.bold(ctx.ui.theme.fg("accent", activeAgentName)) +
				description +
				modelInfo +
				toolsInfo;

			ctx.ui.setWidget("agent-mode-banner", [banner]);
		} else {
			// Show "ready" indicator when agents are available but none selected
			const agentNames = Array.from(agents.keys()).sort();
			if (agentNames.length > 0) {
				const hint = ctx.ui.theme.fg("dim", "[No agent selected — /agent or pi --agent <name>]");
				ctx.ui.setWidget("agent-mode-banner", [hint]);
			} else {
				ctx.ui.setWidget("agent-mode-banner", undefined);
			}
		}
	}

	// ─── Commands ─────────────────────────────────────────────────────────────────

	// Register /agent command
	pi.registerCommand("agent", {
		description: "Switch active agent",
		handler: async (args, ctx) => {
			// If agent name provided, apply directly
			if (args?.trim()) {
				const name = args.trim();

				if (name === "(none)" || name === "none" || name === "clear") {
					activeAgentName = undefined;
					activeAgent = undefined;
					if (originalState?.model) {
						await pi.setModel(originalState.model);
					}
					restoreAllTools();
					ctx.ui.notify("Agent cleared, defaults restored", "info");
					updateStatus(ctx);
					return;
				}

				const agent = agents.get(name);

				if (!agent) {
					const available = Array.from(agents.keys()).join(", ") || "(none defined)";
					ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
					return;
				}

				await applyAgent(name, agent, ctx);
				/* agent activated silently */
				updateStatus(ctx);
				return;
			}

			// Otherwise show selector
			await showAgentSelector(ctx);
		},
	});

	// Register /agents command to list available agents
	pi.registerCommand("agents", {
		description: "List available agents",
		handler: async (_args, ctx) => {
			const agentNames = Array.from(agents.keys()).sort();
			if (agentNames.length === 0) {
				ctx.ui.notify(
					"No agents found. Create agent files in ~/.pi/agent/agents/ or .pi/agents/",
					"warning",
				);
				return;
			}

			const lines = agentNames.map((name) => {
				const agent = agents.get(name)!;
				const marker = name === activeAgentName ? "● " : "○ ";
				const desc = agent.description ? ` - ${agent.description}` : "";
				return `${marker}${name}${desc}`;
			});

			ctx.ui.notify(`Available agents:\n${lines.join("\n")}`, "info");
		},
	});

	// Register /agent-search command to search agents
	pi.registerCommand("agent-search", {
		description: "Search agents by name, description, or body content",
		handler: async (args, ctx) => {
			// If query provided, search directly
			if (args?.trim()) {
				await showSearchResults(ctx, args.trim());
				return;
			}

			// Otherwise prompt for search query
			const query = await ctx.ui.input("Search agents:", "name, description, or content");
			if (query?.trim()) {
				await showSearchResults(ctx, query.trim());
			}
		},
	});

	// ─── Tool Registration ──────────────────────────────────────────────────────

	// Register set_agent tool for autonomous switching
	pi.registerTool({
		name: "set_agent",
		label: "Set Agent",
		description: "Switch to a different agent mode programmatically. Use this when the current task requires a different set of tools or specialized behavior.",
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent to switch to" }),
			reason: Type.Optional(Type.String({ description: "Reason for switching agents" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent: name, reason } = params;
			const agent = agents.get(name);

			if (!agent) {
				const available = Array.from(agents.keys()).join(", ") || "(none defined)";
				throw new Error(`Unknown agent "${name}". Available: ${available}`);
			}

			await applyAgent(name, agent, ctx);

			const msg = reason
				? `Switched to agent "${name}". Reason: ${reason}`
				: `Switched to agent "${name}"`;

			ctx.ui.notify(msg, "info");
			updateStatus(ctx);

			return {
				content: [{ type: "text", text: msg }],
				details: { agent: name, reason },
			};
		},
	});

	// Register search_agents tool for programmatic search
	pi.registerTool({
		name: "search_agents",
		label: "Search Agents",
		description: "Search available agents by name, description, or body content. Returns ranked results with relevance scores and matching snippets.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query to match against agent name, description, or body content" }),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query, limit = 5 } = params;
			const results = searchAgents(agents, query);
			const topResults = results.slice(0, limit);

			if (topResults.length === 0) {
				return {
					content: [{ type: "text", text: `No agents found matching "${query}".` }],
					details: { query, results: [] },
				};
			}

			const lines = topResults.map((r, i) => {
				const isActive = r.name === activeAgentName ? " [ACTIVE]" : "";
				let line = `${i + 1}. ${r.name}${isActive} (score: ${r.score})`;
				if (r.agent.description) line += `\n   Description: ${r.agent.description}`;
				if (r.agent.model) line += `\n   Model: ${r.agent.model}`;
				if (r.agent.tools) line += `\n   Tools: ${r.agent.tools.join(", ")}`;
				if (r.snippets.length > 0) {
					line += `\n   Matches: ${r.snippets.slice(0, 2).join(" | ")}`;
				}
				return line;
			});

			const text = `Found ${results.length} agent(s) matching "${query}" (showing top ${topResults.length}):\n\n${lines.join("\n\n")}`;

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					totalResults: results.length,
					results: topResults.map((r) => ({
						name: r.name,
						score: r.score,
						description: r.agent.description,
						model: r.agent.model,
						tools: r.agent.tools,
						snippets: r.snippets,
					})),
				},
			};
		},
	});

	// ─── Event Handlers ─────────────────────────────────────────────────────────

	// Inject agent instructions into system prompt and refresh tool whitelist.
	pi.on("before_agent_start", async (event) => {
		if (!activeAgent) return;

		// Re-evaluate the active tool set against the *current* registry. Tools
		// registered by other extensions after the agent was applied (e.g. MCP
		// servers that connect asynchronously) only become visible here — doing
		// this once at apply-time would miss them and lock the LLM out of MCP.
		applyAgentTools();

		if (activeAgent.body) {
			// Prepend agent body to system prompt (similar to OpenCode's agent instructions)
			return {
				systemPrompt: `${activeAgent.body}\n\n${event.systemPrompt}`,
			};
		}
	});

	// Initialize on session start
	pi.on("session_start", async (event, ctx) => {
		// Load agents from disk
		agents = loadAgents(ctx.cwd);

		// Silent startup — widget shows status

		// Check for --agent flag first (highest priority)
		const agentFlag = pi.getFlag("agent");
		if (typeof agentFlag === "string" && agentFlag) {
			const agent = agents.get(agentFlag);
			if (agent) {
				await applyAgent(agentFlag, agent, ctx);
				/* agent activated silently */
			}
			/* unknown --agent value silently ignored */
			updateStatus(ctx);
			return;
		}

		// Try to restore from session state (if resuming)
		if (event.reason === "resume" || event.reason === "fork") {
			const entries = ctx.sessionManager.getEntries();
			const agentEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-state")
				.pop() as { data?: { name: string } } | undefined;

			if (agentEntry?.data?.name) {
				const agent = agents.get(agentEntry.data.name);
				if (agent) {
					activeAgentName = agentEntry.data.name;
					activeAgent = agent;
					// Re-apply tool whitelist on resume so the same restrictions take
					// effect as a fresh apply. Model is intentionally not re-applied
					// to preserve any explicit user override across the resume.
					applyAgentTools();
					updateStatus(ctx);
					return;
				}
			}
		}

		// Try to load from settings (defaultAgent)
		const settings = loadSettings(ctx.cwd);
		if (settings.defaultAgent) {
			const agent = agents.get(settings.defaultAgent);
			if (agent) {
				await applyAgent(settings.defaultAgent, agent, ctx);
				/* agent activated silently */
			} else {
				/* silently ignore missing default agent */
			}
		}

		// Show "no agent selected" indicator
		updateStatus(ctx);
	});

	// Persist agent state on turn start — only when it actually changed since
	// the last persisted entry. The previous unconditional append produced one
	// session entry per turn even when the agent was unchanged for hours.
	let lastPersistedAgentName: string | undefined;
	pi.on("turn_start", async () => {
		if (activeAgentName && activeAgentName !== lastPersistedAgentName) {
			pi.appendEntry("agent-state", { name: activeAgentName });
			lastPersistedAgentName = activeAgentName;
		}
	});
}
