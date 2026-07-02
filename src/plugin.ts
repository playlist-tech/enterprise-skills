/**
 * `plugin` command group.
 *
 * A plugin is a curated bundle of hub skills, described by a `plugin.yaml` that
 * lives at `plugins/<name>/plugin.yaml` in a skills repo. Plugin operations are
 * a thin composition layer on top of the existing skill install pipeline:
 *
 *   plugin install <org>/<repo>@<name>
 *     → read plugins/<name>/plugin.yaml
 *     → resolve its member skills
 *     → delegate to runAdd() with the skills tagged as `pluginName`
 *
 * Everything downstream (cloning, discovery, agent selection, symlinking,
 * lockfile writing, and list/remove grouping) is reused unchanged — the only
 * new state is the `pluginName` tag on each lock entry (global SkillLockEntry
 * and project-scoped LocalSkillLockEntry), which list/remove/update group on.
 */

import { basename } from 'path';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import pc from 'picocolors';

import { runAdd, parseAddOptions } from './add.ts';
import { parseSource, getOwnerRepo } from './source-parser.ts';
import { getGitHubToken } from './skill-lock.ts';
import { getAllLockedSkills } from './skill-lock.ts';
import { readLocalLock } from './local-lock.ts';
import { removeCommand, parseRemoveOptions } from './remove.ts';
import { cloneRepo, cleanupTempDir } from './git.ts';
import { envConfig } from './env-config.ts';
import { isRunningInAgent } from './detect-agent.ts';
import { interactiveSearch } from './search-prompt.ts';

const FETCH_TIMEOUT = 10_000;

/** Parsed `plugin.yaml` descriptor. */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Repo-root-relative paths to skill directories. */
  skills: string[];
  mcp?: { config?: string };
}

/**
 * Validate and normalize a parsed plugin.yaml object.
 * Throws with a clear message when required fields are missing or mistyped.
 */
export function normalizePluginManifest(raw: unknown, ref: string): PluginManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${ref}: plugin.yaml must be a YAML mapping.`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error(`${ref}: plugin.yaml is missing a string 'name'.`);
  }
  if (
    !Array.isArray(obj.skills) ||
    obj.skills.length === 0 ||
    !obj.skills.every((s) => typeof s === 'string')
  ) {
    throw new Error(`${ref}: plugin.yaml 'skills' must be a non-empty list of paths.`);
  }
  return {
    name: obj.name,
    version: typeof obj.version === 'string' ? obj.version : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    skills: obj.skills as string[],
    mcp:
      typeof obj.mcp === 'object' && obj.mcp !== null
        ? { config: (obj.mcp as Record<string, unknown>).config as string | undefined }
        : undefined,
  };
}

/**
 * Fetch plugin.yaml text from a GitHub repo without a full clone, using the
 * Contents API (works for private repos with a token). Returns null if the
 * file can't be fetched this way (caller falls back to cloning).
 */
async function fetchPluginYamlViaApi(
  ownerRepo: string,
  pluginName: string,
  ref: string | undefined
): Promise<string | null> {
  const path = `plugins/${pluginName}/plugin.yaml`;
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `https://api.github.com/repos/${ownerRepo}/contents/${path}${refQuery}`;

  const attempt = async (token: string | null): Promise<string | null> => {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'skills-cli',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (res.ok) return await res.text();
      return null;
    } catch {
      return null;
    }
  };

  // Unauthenticated first (public repos); fall back to a token for private/rate-limited.
  const unauth = await attempt(null);
  if (unauth !== null) return unauth;
  const token = getGitHubToken();
  if (!token) return null;
  return attempt(token);
}

/**
 * Load a plugin manifest for `<ownerRepo>@<pluginName>`.
 * Tries the GitHub Contents API first, then falls back to a shallow clone.
 */
export async function loadPluginManifest(
  ownerRepo: string,
  pluginName: string,
  cloneUrl: string,
  ref?: string
): Promise<PluginManifest> {
  const displayRef = `${ownerRepo}@${pluginName}`;

  const viaApi = await fetchPluginYamlViaApi(ownerRepo, pluginName, ref);
  if (viaApi !== null) {
    return normalizePluginManifest(parseYaml(viaApi), displayRef);
  }

  // Fallback: clone and read from disk (handles non-GitHub hosts and private
  // repos where only git credentials — not an API token — are available).
  let tempDir: string | null = null;
  try {
    tempDir = await cloneRepo(cloneUrl, ref);
    const manifestPath = join(tempDir, 'plugins', pluginName, 'plugin.yaml');
    let text: string;
    try {
      text = await readFile(manifestPath, 'utf-8');
    } catch {
      throw new Error(
        `Plugin '${pluginName}' not found in ${ownerRepo} (expected plugins/${pluginName}/plugin.yaml).`
      );
    }
    return normalizePluginManifest(parseYaml(text), displayRef);
  } finally {
    if (tempDir) await cleanupTempDir(tempDir);
  }
}

/** Member skill names (directory basenames) declared by a manifest. */
export function manifestSkillNames(manifest: PluginManifest): string[] {
  return manifest.skills.map((p) => basename(p.replace(/\/+$/, '')));
}

// --------------------------------------------------------------------------- #
// Subcommands
// --------------------------------------------------------------------------- #

async function runPluginInstall(args: string[]): Promise<void> {
  const { source, options } = parseAddOptions(args);
  const rawSource = source[0];

  if (!rawSource) {
    console.error(pc.red('Missing plugin source.'));
    console.error(pc.dim(`Usage: ${envConfig.cliName} plugin install <org>/<repo>@<plugin-name>`));
    process.exit(1);
  }

  const parsed = parseSource(rawSource);
  const pluginName = parsed.skillFilter;
  if (!pluginName) {
    console.error(pc.red('Specify the plugin name: <org>/<repo>@<plugin-name>'));
    process.exit(1);
  }

  const ownerRepo = getOwnerRepo(parsed);
  if (
    !ownerRepo ||
    (parsed.type !== 'github' && parsed.type !== 'git' && parsed.type !== 'gitlab')
  ) {
    console.error(pc.red('plugin install requires a Git repository source (e.g. org/repo).'));
    process.exit(1);
  }

  let manifest: PluginManifest;
  try {
    manifest = await loadPluginManifest(ownerRepo, pluginName, parsed.url, parsed.ref);
  } catch (err) {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const skillNames = manifestSkillNames(manifest);
  console.log(
    pc.dim(
      `Plugin ${pc.cyan(manifest.name)}${manifest.version ? ` v${manifest.version}` : ''} → ` +
        `${skillNames.length} skill${skillNames.length !== 1 ? 's' : ''}: ${skillNames.join(', ')}`
    )
  );

  // Rebuild a clean source string (drop the @plugin fragment, preserve ref) and
  // delegate to the standard add pipeline, tagging every skill with the plugin.
  const cleanSource = parsed.ref ? `${ownerRepo}#${parsed.ref}` : ownerRepo;
  await runAdd([cleanSource], {
    ...options,
    skill: skillNames,
    pluginName: manifest.name,
  });

  if (manifest.mcp?.config) {
    console.log(
      pc.yellow(
        `Note: plugin '${manifest.name}' declares an MCP config (${manifest.mcp.config}); ` +
          `automatic MCP wiring is not yet supported — configure it manually if needed.`
      )
    );
  }
}

interface InstalledPlugin {
  skills: string[];
  /** Scope the plugin's skills live in. A globally-installed member pins the plugin to global for management. */
  global: boolean;
}

/**
 * Group installed skills by the plugin that installed them, across BOTH the
 * global and project-scoped locks. Plugins install to whichever scope the user
 * chose, so both must be consulted or `list`/`remove`/`update` would miss them.
 */
async function installedByPlugin(): Promise<Map<string, InstalledPlugin>> {
  const byPlugin = new Map<string, InstalledPlugin>();

  const record = (pluginName: string, skillName: string, global: boolean) => {
    const existing = byPlugin.get(pluginName);
    if (existing) {
      existing.skills.push(skillName);
      existing.global = existing.global || global;
    } else {
      byPlugin.set(pluginName, { skills: [skillName], global });
    }
  };

  const globalLocked = await getAllLockedSkills();
  for (const [skillName, entry] of Object.entries(globalLocked)) {
    if (entry.pluginName) record(entry.pluginName, skillName, true);
  }

  const localLock = await readLocalLock();
  for (const [skillName, entry] of Object.entries(localLock.skills)) {
    if (entry.pluginName) record(entry.pluginName, skillName, false);
  }

  return byPlugin;
}

async function runPluginList(): Promise<void> {
  const byPlugin = await installedByPlugin();
  if (byPlugin.size === 0) {
    console.log('No plugins installed.');
    console.log(
      pc.dim(`Install one with: ${envConfig.cliName} plugin install <org>/<repo>@<plugin-name>`)
    );
    return;
  }
  for (const pluginName of [...byPlugin.keys()].sort()) {
    const entry = byPlugin.get(pluginName)!;
    console.log(pc.bold(pluginName) + (entry.global ? pc.dim(' (global)') : ''));
    for (const skillName of [...entry.skills].sort()) {
      console.log(`  ${pc.cyan(skillName)}`);
    }
  }
}

async function runPluginRemove(args: string[]): Promise<void> {
  const { skills: positional, options } = parseRemoveOptions(args);
  const pluginName = positional[0];
  if (!pluginName) {
    console.error(pc.red(`Usage: ${envConfig.cliName} plugin remove <plugin-name>`));
    process.exit(1);
  }

  const byPlugin = await installedByPlugin();
  const installed = byPlugin.get(pluginName);
  if (!installed || installed.skills.length === 0) {
    console.error(pc.red(`Plugin '${pluginName}' is not installed.`));
    process.exit(1);
  }

  console.log(pc.dim(`Removing plugin ${pc.cyan(pluginName)} (${installed.skills.length} skills)`));
  // Delegate file/lock/hook removal to the existing remove flow, targeting the
  // scope the plugin was installed into (the user need not repeat -g).
  await removeCommand(installed.skills, { ...options, global: installed.global });
}

async function runPluginUpdate(args: string[]): Promise<void> {
  const { source, options } = parseAddOptions(args);
  const rawSource = source[0];
  if (!rawSource) {
    console.error(pc.red(`Usage: ${envConfig.cliName} plugin update <org>/<repo>@<plugin-name>`));
    process.exit(1);
  }

  const parsed = parseSource(rawSource);
  const pluginName = parsed.skillFilter;
  const ownerRepo = getOwnerRepo(parsed);
  if (!pluginName || !ownerRepo) {
    console.error(pc.red('Specify the plugin as <org>/<repo>@<plugin-name>.'));
    process.exit(1);
  }

  const byPlugin = await installedByPlugin();
  const installed = byPlugin.get(pluginName);
  if (!installed || installed.skills.length === 0) {
    console.error(pc.red(`Plugin '${pluginName}' is not installed. Use 'plugin install' instead.`));
    process.exit(1);
  }
  const current = new Set(installed.skills);

  let manifest: PluginManifest;
  try {
    manifest = await loadPluginManifest(ownerRepo, pluginName, parsed.url, parsed.ref);
  } catch (err) {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const desired = new Set(manifestSkillNames(manifest));
  const toAdd = [...desired].filter((s) => !current.has(s));
  const toRemove = [...current].filter((s) => !desired.has(s));

  // Re-install the full desired set so version bumps to retained skills also
  // land, pinned to the scope the plugin already lives in.
  const cleanSource = parsed.ref ? `${ownerRepo}#${parsed.ref}` : ownerRepo;
  await runAdd([cleanSource], {
    ...options,
    yes: true,
    global: installed.global,
    skill: [...desired],
    pluginName: manifest.name,
  });

  if (toRemove.length > 0) {
    console.log(pc.dim(`Removing dropped skills: ${toRemove.join(', ')}`));
    await removeCommand(toRemove, { yes: true, global: installed.global });
  }

  console.log(
    pc.green(
      `Updated ${manifest.name}: ${toAdd.length} added, ${toRemove.length} removed, ` +
        `${desired.size - toAdd.length} retained.`
    )
  );
}

interface PluginSearchHit {
  name: string;
  description?: string;
  source?: string;
}

// Query the plugin search API. Returns [] on any failure so the interactive
// prompt degrades to "no results" rather than throwing mid-render.
async function searchPluginsAPI(query: string): Promise<PluginSearchHit[]> {
  const url = `${envConfig.apiBase}/api/plugins/search${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return [];
    const data = (await res.json()) as { plugins?: PluginSearchHit[] };
    return data.plugins ?? [];
  } catch {
    return [];
  }
}

// Interactive plugin browse: show the full list immediately and filter as you
// type (there are few plugins, so browse-all is the natural default).
async function runPluginSearchPrompt(): Promise<PluginSearchHit | null> {
  return interactiveSearch<PluginSearchHit>({
    label: 'Search plugins:',
    minChars: 0,
    emptyMessage: 'No plugins found',
    search: (q) => searchPluginsAPI(q),
    renderRow: (plugin, selected) => {
      const name = selected ? pc.bold(plugin.name) : pc.cyan(plugin.name);
      const source = plugin.source ? ` ${pc.dim(plugin.source)}` : '';
      const desc = plugin.description ? ` ${pc.dim(`— ${plugin.description}`)}` : '';
      return `${name}${source}${desc}`;
    },
  });
}

async function runPluginSearch(args: string[]): Promise<void> {
  const query = args.filter((a) => !a.startsWith('-')).join(' ');

  // With no query and a real terminal, browse interactively (like `find`).
  if (!query && process.stdin.isTTY && !(await isRunningInAgent())) {
    const selected = await runPluginSearchPrompt();
    if (!selected) {
      console.log(pc.dim('Search cancelled.'));
      return;
    }
    if (!selected.source) {
      console.error(pc.red(`Cannot install '${selected.name}': the registry returned no source.`));
      return;
    }
    console.log();
    console.log(pc.dim(`Installing plugin ${pc.cyan(selected.name)} from ${selected.source}...`));
    console.log();
    await runPluginInstall([`${selected.source}@${selected.name}`]);
    return;
  }

  // Query given, or non-interactive: print results.
  const url = `${envConfig.apiBase}/api/plugins/search${query ? `?q=${encodeURIComponent(query)}` : ''}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  } catch {
    console.error(pc.red('Could not reach the plugins API.'));
    return;
  }

  if (res.status === 404) {
    console.log(pc.yellow('Plugin search is not available yet on this hub.'));
    console.log(
      pc.dim(
        `You can still install a known plugin: ${envConfig.cliName} plugin install <org>/<repo>@<name>`
      )
    );
    return;
  }
  if (!res.ok) {
    console.error(pc.red(`Plugin search failed (${res.status}).`));
    return;
  }

  const data = (await res.json()) as {
    plugins?: Array<{ name: string; description?: string; source?: string }>;
  };
  const plugins = data.plugins ?? [];
  if (plugins.length === 0) {
    console.log('No plugins found.');
    return;
  }
  for (const plugin of plugins) {
    console.log(pc.bold(plugin.name));
    if (plugin.description) console.log(`  ${pc.dim(plugin.description)}`);
    const target = plugin.source
      ? `${plugin.source}@${plugin.name}`
      : `<org>/<repo>@${plugin.name}`;
    console.log(`  ${pc.dim(`${envConfig.cliName} plugin install ${target}`)}`);
  }
}

function showPluginHelp(): void {
  const cli = envConfig.cliName;
  console.log(`
Usage: ${cli} plugin <subcommand> [options]

Bundle and install curated groups of hub skills.

Subcommands:
  install <org>/<repo>@<name>   Install a plugin's skills
  list                          List installed plugins and their skills
  update <org>/<repo>@<name>    Re-sync a plugin to its current manifest
  remove <name>                 Remove an installed plugin's skills
  search [query]                Search plugins, or browse interactively (no query)

Options are forwarded to the underlying install/remove flow
(e.g. -g/--global, -a/--agent, -y/--yes, --copy).

Examples:
  ${cli} plugin install playlist-tech/gen-ai-skills@poc-platform-tools
  ${cli} plugin list
  ${cli} plugin remove poc-platform-tools
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
    case 'install':
    case 'add':
    case 'i':
      await runPluginInstall(rest);
      break;
    case 'list':
    case 'ls':
      await runPluginList();
      break;
    case 'remove':
    case 'rm':
      await runPluginRemove(rest);
      break;
    case 'update':
    case 'upgrade':
      await runPluginUpdate(rest);
      break;
    case 'search':
    case 'find':
      await runPluginSearch(rest);
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
