/**
 * Claude Code agent adapter for pi-agent-mode.
 *
 * Loads agents from Claude Code directories and normalizes them for the main
 * extension. Keep Claude-specific parsing here; index.ts stays Pi-native.
 *
 * Sources:
 * - ~/.claude/agents/ (recursive .md)
 * - <cwd>/.claude/agents/ (recursive .md)
 *
 * Supported frontmatter: name, description, model, tools, disallowedTools.
 * Ignored Claude runtime fields: hooks, skills, memory, permissionMode, etc.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Shape expected by index.ts AgentDefinition (+ optional Claude fields). */
export interface ClaudeAgentDefinition {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	disallowedTools?: string[];
	body: string;
	source?: string;
}

const CLAUDE_MODEL_ALIASES = new Set([
	"inherit",
	"sonnet",
	"opus",
	"haiku",
	"fable",
]);

const CLAUDE_TOOL_MAP: Record<string, string> = {
	glob: "find",
	list: "ls",
	shell: "bash",
	search: "grep",
};

/** Claude aliases are not Pi provider/model-id refs. */
export function isClaudeModelAlias(ref: string): boolean {
	return CLAUDE_MODEL_ALIASES.has(ref.trim().toLowerCase());
}

/** True when index.ts should call setModel for this value. */
export function shouldApplyModelRef(ref: string | undefined): ref is string {
	if (!ref?.trim()) return false;
	if (isClaudeModelAlias(ref)) return false;
	return ref.includes("/");
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function mapToolName(name: string): string {
	const lower = name.trim().toLowerCase();
	return CLAUDE_TOOL_MAP[lower] ?? lower;
}

function parseToolList(value: string | string[]): string[] {
	const parts = Array.isArray(value)
		? value
		: value.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);

	const mapped = parts
		.map((part) => stripQuotes(part.replace(/^\s*-\s*/, "")))
		.map((part) => part.replace(/\(.*\)$/, "").trim())
		.map(mapToolName)
		.filter(Boolean);

	return [...new Set(mapped)];
}

function findMarkdownFiles(dir: string): string[] {
	const files: string[] = [];

	const walk = (current: string): void => {
		if (!existsSync(current)) return;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(full);
			}
		}
	};

	walk(dir);
	return files;
}

/**
 * Minimal YAML-ish frontmatter parser for Claude agent markdown.
 * Handles scalars, quotes, block scalars (|/>), dash lists, and [a, b] lists.
 */
function parseFrontmatter(
	content: string,
): { fields: Record<string, string | string[]>; body: string } | undefined {
	const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
	if (!match) return undefined;

	const fields: Record<string, string | string[]> = {};
	const lines = match[1].split(/\r?\n/);
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith("#")) {
			i++;
			continue;
		}

		const keyMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!keyMatch) {
			i++;
			continue;
		}

		const key = keyMatch[1];
		const trimmedValue = keyMatch[2].trim();

		if (/^[|>][-+]?$/.test(trimmedValue)) {
			const block: string[] = [];
			i++;
			while (i < lines.length) {
				const next = lines[i];
				if (next === "" || /^[ \t]/.test(next)) {
					block.push(next.replace(/^[ \t]/, ""));
					i++;
					continue;
				}
				break;
			}
			fields[key] = block.join("\n").trim();
			continue;
		}

		if (trimmedValue === "") {
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length && /^[ \t]*-[ \t]+/.test(lines[j])) {
				items.push(stripQuotes(lines[j].replace(/^[ \t]*-[ \t]+/, "")));
				j++;
			}
			if (items.length > 0) {
				fields[key] = items;
				i = j;
				continue;
			}
			fields[key] = "";
			i++;
			continue;
		}

		if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
			fields[key] = parseToolList(trimmedValue.slice(1, -1));
			i++;
			continue;
		}

		fields[key] = stripQuotes(trimmedValue);
		i++;
	}

	return { fields, body: match[2].trim() };
}

function parseClaudeAgentFile(filePath: string): ClaudeAgentDefinition | undefined {
	const parsed = parseFrontmatter(readFileSync(filePath, "utf-8"));
	if (!parsed) return undefined;

	const { fields, body } = parsed;
	const nameField = fields.name;
	const name =
		typeof nameField === "string" && nameField.trim()
			? stripQuotes(nameField).trim()
			: basename(filePath).replace(/\.md$/i, "");

	// Claude reserves ':' for plugin-scoped agent ids.
	if (!name || name.includes(":")) return undefined;

	const descriptionField = fields.description;
	const description =
		typeof descriptionField === "string"
			? descriptionField.trim() || undefined
			: Array.isArray(descriptionField)
				? descriptionField.join(" ").trim() || undefined
				: undefined;

	const modelField = fields.model;
	const model =
		typeof modelField === "string" ? stripQuotes(modelField).trim() || undefined : undefined;

	const tools =
		fields.tools !== undefined ? parseToolList(fields.tools) : undefined;
	const disallowedTools =
		fields.disallowedTools !== undefined ? parseToolList(fields.disallowedTools) : undefined;

	return {
		name,
		description,
		model,
		tools: tools?.length ? tools : undefined,
		disallowedTools: disallowedTools?.length ? disallowedTools : undefined,
		body,
		source: filePath,
	};
}

/** Load Claude Code agents. Project overrides global on the same name. */
export function loadClaudeAgents(cwd: string): Map<string, ClaudeAgentDefinition> {
	const dirs = [join(homedir(), ".claude", "agents"), join(cwd, ".claude", "agents")];
	const agents = new Map<string, ClaudeAgentDefinition>();

	for (const dir of dirs) {
		for (const file of findMarkdownFiles(dir)) {
			const agent = parseClaudeAgentFile(file);
			if (agent) agents.set(agent.name, agent);
		}
	}

	return agents;
}
