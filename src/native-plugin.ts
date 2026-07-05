/**
 * `plugin` command group — real native agent plugins.
 *
 * A native plugin is a superset of a bundle: skills PLUS MCP servers, hooks,
 * commands, and subagents, packaged in the format the agents themselves define
 * (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, …). The hub
 * crawls curated repos for these manifests, pins each to a commit SHA, and
 * serves a searchable catalog plus per-agent install recipes.
 *
 *   plugin search [query]        → GET /api/plugins/search (component badges)
 *   plugin install <name> --agent <a>
 *                                → GET /api/plugins/{name}/install?agent=<a>
 *
 * v1 deliberately does NOT execute the install: it discloses the component
 * inventory ("wires MCP server X + 2 hooks from repo@sha") and prints the
 * exact per-agent steps, ending at the agent's own trust gate. No agent
 * activates third-party MCP servers or hooks without that gate, by design —
 * this command never tries to bypass it. All brittle per-agent knowledge
 * lives in hub recipe data, patchable without an npm release.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { envConfig } from './env-config.ts';
import { detectAgent, getAgentType, isRunningInAgent } from './detect-agent.ts';
import { interactiveSearch } from './search-prompt.ts';

const FETCH_TIMEOUT = 10_000;

/** Component inventory counts reported by the catalog. */
export interface PluginComponents {
  skills?: number;
  mcpServers?: number;
  hooks?: number;
  commands?: number;
  agents?: number;
}

interface NativePluginHit {
  name: string;
  description?: string;
  source?: string;
  path?: string;
  sha?: string;
  version?: string;
  components?: PluginComponents;
  mcpServerNames?: string[];
  tags?: string[];
}

interface RecipeStep {
  kind: string;
  description: string;
  command?: string;
  dest?: string;
}

interface InstallRecipe {
  name: string;
  version?: string;
  source: { org: string; repo: string; path?: string; sha: string };
  components?: PluginComponents;
  mcpServerNames?: string[];
  agent: string;
  disclosure?: string;
  steps: RecipeStep[];
  trust?: { description?: string };
}

/**
 * Map a skills-cli AgentType to the hub recipe key. Recipes exist per target
 * agent (claude + codex first); unsupported agents get a clear error from the
 * API listing what's available.
 */
const AGENT_TYPE_TO_RECIPE: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor',
  'github-copilot': 'copilot',
};

/** Compact component badge, e.g. "3 skills · 1 MCP · 2 hooks". */
export function componentBadges(components?: PluginComponents): string {
  if (!components) return '';
  const parts: string[] = [];
  const add = (count: number | undefined, singular: string, plural = `${singular}s`) => {
    if (count && count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`);
  };
  add(components.skills, 'skill');
  add(components.mcpServers, 'MCP', 'MCP');
  add(components.hooks, 'hook');
  add(components.commands, 'command');
  add(components.agents, 'agent');
  return parts.join(' · ');
}

// Query the native plugin catalog. Returns [] on any failure so the
// interactive prompt degrades to "no results" rather than throwing mid-render.
async function searchPluginsAPI(query: string): Promise<NativePluginHit[]> {
  const url = `${envConfig.apiBase}/api/plugins/search${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return [];
    const data = (await res.json()) as { plugins?: NativePluginHit[] };
    return data.plugins ?? [];
  } catch {
    return [];
  }
}

function renderPluginRow(plugin: NativePluginHit, selected: boolean): string {
  const name = selected ? pc.bold(plugin.name) : pc.cyan(plugin.name);
  const badges = componentBadges(plugin.components);
  const badgeStr = badges ? ` ${pc.yellow(`[${badges}]`)}` : '';
  const source = plugin.source ? ` ${pc.dim(plugin.source)}` : '';
  const desc = plugin.description ? ` ${pc.dim(`— ${plugin.description}`)}` : '';
  return `${name}${badgeStr}${source}${desc}`;
}

async function runPluginSearchPrompt(): Promise<NativePluginHit | null> {
  return interactiveSearch<NativePluginHit>({
    label: 'Search plugins:',
    minChars: 2,
    emptyMessage: 'No plugins found',
    search: (q) => searchPluginsAPI(q),
    renderRow: renderPluginRow,
  });
}

function printPluginHit(plugin: NativePluginHit): void {
  console.log(pc.bold(plugin.name) + (plugin.version ? pc.dim(` v${plugin.version}`) : ''));
  const badges = componentBadges(plugin.components);
  if (badges) console.log(`  ${pc.yellow(badges)}`);
  if (plugin.description) console.log(`  ${pc.dim(plugin.description)}`);
  if (plugin.source) {
    const pin = plugin.sha ? pc.dim(` @ ${plugin.sha.slice(0, 7)}`) : '';
    console.log(`  ${pc.dim(plugin.source)}${pin}`);
  }
  console.log(`  ${pc.dim(`${envConfig.cliName} plugin install ${plugin.name} --agent <agent>`)}`);
}

async function runPluginSearch(args: string[]): Promise<void> {
  const query = args.filter((a) => !a.startsWith('-')).join(' ');

  // With no query and a real terminal, search interactively (like `find`).
  if (!query && process.stdin.isTTY && !(await isRunningInAgent())) {
    const selected = await runPluginSearchPrompt();
    if (!selected) {
      console.log(pc.dim('Search cancelled.'));
      return;
    }
    console.log();
    // Native install always ends at the agent's trust gate, so selecting a
    // result shows the install plan rather than performing anything.
    await runPluginInstall([selected.name]);
    return;
  }

  const url = `${envConfig.apiBase}/api/plugins/search${query ? `?q=${encodeURIComponent(query)}` : ''}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  } catch {
    console.error(pc.red('Could not reach the plugins API.'));
    return;
  }

  if (res.status === 404) {
    console.log(pc.yellow('Native plugin search is not available yet on this hub.'));
    return;
  }
  if (!res.ok) {
    console.error(pc.red(`Plugin search failed (${res.status}).`));
    return;
  }

  const data = (await res.json()) as { plugins?: NativePluginHit[] };
  const plugins = data.plugins ?? [];
  if (plugins.length === 0) {
    console.log('No plugins found.');
    return;
  }
  for (const plugin of plugins) {
    printPluginHit(plugin);
  }
}

/** Resolve the target recipe agent: --agent flag first, then the detected agent. */
async function resolveRecipeAgent(flagValue: string | undefined): Promise<string | null> {
  if (flagValue) return flagValue.toLowerCase();
  const result = await detectAgent();
  if (!result.isAgent) return null;
  const agentType = getAgentType(result.agent.name);
  if (!agentType) return null;
  return AGENT_TYPE_TO_RECIPE[agentType] ?? null;
}

/**
 * Ask the catalog which agents have an install recipe for this plugin. Reuses
 * the install endpoint's agent-less 400 response (`availableAgents`) so the
 * picker stays data-driven — the CLI hardcodes no agent list. Returns null
 * when the API is unreachable or the plugin/agents are unknown.
 */
async function fetchAvailableAgents(name: string): Promise<string[] | null> {
  const url = `${envConfig.apiBase}/api/plugins/${encodeURIComponent(name)}/install`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (res.status !== 400) return null;
    const body = (await res.json()) as { availableAgents?: string[] };
    return body.availableAgents?.length ? body.availableAgents : null;
  } catch {
    return null;
  }
}

/** Interactive agent picker. Returns the chosen agent, or null if cancelled/unavailable. */
async function promptForAgent(name: string): Promise<string | null> {
  const available = await fetchAvailableAgents(name);
  if (!available) return null;

  const selected = await p.select({
    message: `Install ${name} for which agent?`,
    options: available.map((agent) => ({ value: agent, label: agent })),
  });
  if (p.isCancel(selected)) {
    console.log(pc.dim('Install cancelled.'));
    process.exit(0);
  }
  return selected as string;
}

function parseInstallArgs(args: string[]): { name?: string; agent?: string } {
  let name: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--agent' || arg === '-a') {
      agent = args[i + 1];
      i++;
    } else if (!arg.startsWith('-') && !name) {
      name = arg;
    }
  }
  return { name, agent };
}

async function runPluginInstall(args: string[]): Promise<void> {
  const { name, agent: agentFlag } = parseInstallArgs(args);

  if (!name) {
    console.error(pc.red('Missing plugin name.'));
    console.error(pc.dim(`Usage: ${envConfig.cliName} plugin install <name> --agent <agent>`));
    process.exit(1);
  }

  let agent = await resolveRecipeAgent(agentFlag);

  // No flag and no detected agent: in a real terminal, offer a picker fed by
  // the catalog's recipe list instead of erroring.
  if (!agent && process.stdin.isTTY && !(await isRunningInAgent())) {
    agent = await promptForAgent(name);
  }

  if (!agent) {
    console.error(pc.red('Could not determine the target agent.'));
    console.error(
      pc.dim(
        `Pass one explicitly: ${envConfig.cliName} plugin install ${name} --agent <claude|codex>`
      )
    );
    process.exit(1);
  }

  const url = `${envConfig.apiBase}/api/plugins/${encodeURIComponent(name)}/install?agent=${encodeURIComponent(agent)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  } catch {
    console.error(pc.red('Could not reach the plugins API.'));
    process.exit(1);
  }

  if (res.status === 404) {
    console.error(pc.red(`Plugin '${name}' was not found in the catalog.`));
    console.error(pc.dim(`Search for it first: ${envConfig.cliName} plugin search ${name}`));
    process.exit(1);
  }
  if (res.status === 400) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; availableAgents?: string[] };
      if (body.availableAgents?.length) {
        detail = ` Available agents: ${body.availableAgents.join(', ')}.`;
      } else if (body.error) {
        detail = ` ${body.error}`;
      }
    } catch {
      // Body unreadable; the status alone is enough to act on.
    }
    console.error(pc.red(`No install recipe for agent '${agent}'.${detail}`));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(pc.red(`Fetching the install recipe failed (${res.status}).`));
    process.exit(1);
  }

  const recipe = (await res.json()) as InstallRecipe;
  printInstallPlan(recipe);
}

function printInstallPlan(recipe: InstallRecipe): void {
  const shortSha = recipe.source.sha.slice(0, 7);
  console.log();
  console.log(
    pc.bold(recipe.name) +
      (recipe.version ? pc.dim(` v${recipe.version}`) : '') +
      pc.dim(` — ${recipe.source.org}/${recipe.source.repo}@${shortSha} → ${recipe.agent}`)
  );

  // Security model: disclose the component inventory BEFORE any install step.
  if (recipe.disclosure) {
    console.log(pc.yellow(`  ${recipe.disclosure}`));
  }
  console.log();

  let stepNumber = 0;
  for (const step of recipe.steps) {
    stepNumber++;
    console.log(`${pc.bold(String(stepNumber) + '.')} ${step.description}`);
    if (step.command) console.log(`   ${pc.cyan(step.command)}`);
    if (step.dest) console.log(`   ${pc.dim(`→ ${step.dest}`)}`);
  }

  if (recipe.trust?.description) {
    console.log();
    console.log(pc.yellow(pc.bold('Trust gate: ')) + pc.yellow(recipe.trust.description));
  }

  console.log();
  console.log(
    pc.dim(
      'These steps are shown, not run — review them, run them yourself, and complete the trust step in the agent.'
    )
  );
}

function showPluginHelp(): void {
  const cli = envConfig.cliName;
  console.log(`
Usage: ${cli} plugin <subcommand> [options]

Discover and install native agent plugins — skills plus MCP servers,
hooks, and commands, packaged in the agent's own plugin format.

Subcommands:
  search [query]                Search the plugin catalog (interactive when no query given)
  install <name> --agent <a>    Show the exact install steps for an agent (claude, codex)

Install shows what the plugin wires up (MCP servers, hooks) and the exact
per-agent steps. Activation always ends at the agent's own trust gate.

For curated sets of skills (no MCP/hooks), see: ${cli} bundle --help

Examples:
  ${cli} plugin search incident
  ${cli} plugin install incident-tools --agent claude
`);
}

/**
 * Entry point for the `plugin` command group. `args` is everything after
 * `plugin` on the command line (subcommand + its args).
 */
export async function runPlugin(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case 'search':
    case 'find':
      await runPluginSearch(rest);
      break;
    case 'install':
    case 'add':
    case 'i':
      await runPluginInstall(rest);
      break;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      showPluginHelp();
      break;
    default:
      console.error(pc.red(`Unknown plugin subcommand: ${subcommand}`));
      showPluginHelp();
      process.exit(1);
  }
}
