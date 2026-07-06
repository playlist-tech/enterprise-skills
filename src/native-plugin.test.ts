import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCli } from './test-utils.ts';
import { componentBadges, runPlugin } from './native-plugin.ts';

// The subprocess CLI tests shell out to `node cli.ts`; ensure TypeScript is
// stripped regardless of the local Node version.
const STRIP = { NODE_OPTIONS: '--experimental-strip-types --no-warnings' };

describe('componentBadges', () => {
  it('renders present components with counts and pluralization', () => {
    expect(componentBadges({ skills: 3, mcpServers: 1, hooks: 2, commands: 0, agents: 0 })).toBe(
      '3 skills · 1 MCP · 2 hooks'
    );
    expect(componentBadges({ skills: 1 })).toBe('1 skill');
  });

  it('returns empty for missing or empty inventories', () => {
    expect(componentBadges(undefined)).toBe('');
    expect(componentBadges({})).toBe('');
  });
});

describe('plugin search output', () => {
  const hit = {
    name: 'incident-tools',
    description: 'Incident response toolkit.',
    source: 'playlist-tech/incident-forge',
    sha: '0123456789abcdef0123456789abcdef01234567',
    version: '1.2.0',
    components: { skills: 3, mcpServers: 1, hooks: 2 },
    mcpServerNames: ['incident-db'],
    tier: 'curated',
  };

  const communityHit = {
    name: 'rogue-tools',
    description: 'Auto-discovered toolkit.',
    source: 'playlist-tech/some-service',
    sha: 'abcdef0123456789abcdef0123456789abcdef01',
    version: '0.1.0',
    components: { skills: 1 },
    tier: 'community',
  };

  let logged: string[];

  function stubSearch(...plugins: unknown[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ plugins }) }) as Response)
    );
  }

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    stubSearch(hit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('queries /api/plugins/search and prints component badges + pinned source', async () => {
    await runPlugin(['search', 'incident']);

    const fetchMock = vi.mocked(fetch);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/plugins/search?q=incident');

    const output = logged.join('\n');
    expect(output).toContain('incident-tools');
    expect(output).toContain('3 skills · 1 MCP · 2 hooks');
    expect(output).toContain('playlist-tech/incident-forge');
    expect(output).toContain('0123456'); // short pinned SHA
    expect(output).toContain('plugin install incident-tools --agent');
  });

  it('does not mark a curated plugin as community', async () => {
    await runPlugin(['search', 'incident']);
    expect(logged.join('\n')).not.toContain('(community)');
  });

  it('marks a community plugin with a visible tier marker', async () => {
    stubSearch(communityHit);
    await runPlugin(['search', 'rogue']);
    expect(logged.join('\n')).toContain('(community)');
  });
});

describe('plugin install (v1 shows steps, never executes)', () => {
  const recipe = {
    name: 'incident-tools',
    version: '1.2.0',
    source: {
      org: 'playlist-tech',
      repo: 'incident-forge',
      path: '',
      sha: '0123456789abcdef0123456789abcdef01234567',
    },
    components: { skills: 3, mcpServers: 1, hooks: 2 },
    mcpServerNames: ['incident-db'],
    agent: 'claude',
    tier: 'curated',
    disclosure:
      'Wires 3 skills, 1 MCP server (incident-db), 2 hooks from playlist-tech/incident-forge@0123456',
    steps: [
      {
        kind: 'clone',
        description: 'Clone the plugin source at the pinned commit',
        command:
          'git clone https://github.com/playlist-tech/incident-forge.git /tmp/plugin-incident-tools',
      },
      {
        kind: 'place',
        description: "Copy the plugin directory into Claude Code's skills dir",
        dest: '~/.claude/skills/incident-tools/',
      },
    ],
    trust: {
      description:
        'Restart Claude Code and approve the workspace-trust prompt to activate the MCP server and hooks.',
    },
  };

  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => recipe }) as Response)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches the per-agent recipe and prints disclosure, steps, and trust gate', async () => {
    await runPlugin(['install', 'incident-tools', '--agent', 'claude']);

    const fetchMock = vi.mocked(fetch);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      '/api/plugins/incident-tools/install?agent=claude'
    );

    const output = logged.join('\n');
    // Disclosure comes before any step.
    expect(output.indexOf('Wires 3 skills')).toBeGreaterThan(-1);
    expect(output.indexOf('Wires 3 skills')).toBeLessThan(output.indexOf('Clone the plugin'));
    expect(output).toContain('git clone https://github.com/playlist-tech/incident-forge.git');
    expect(output).toContain('~/.claude/skills/incident-tools/');
    expect(output).toContain('Trust gate:');
    expect(output).toContain('workspace-trust');
    // v1 contract: shown, not run.
    expect(output).toContain('shown, not run');
  });

  it('does not print the community warning for a curated recipe', async () => {
    await runPlugin(['install', 'incident-tools', '--agent', 'claude']);
    expect(logged.join('\n')).not.toContain('Community plugin');
  });

  it('prints a community warning before the steps for a community recipe', async () => {
    const communityRecipe = { ...recipe, tier: 'community' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => communityRecipe }) as Response)
    );

    await runPlugin(['install', 'incident-tools', '--agent', 'claude']);

    const output = logged.join('\n');
    expect(output).toContain(
      'Community plugin — auto-discovered, not curated by Developer Experience'
    );
    // The warning lands before the first install step.
    expect(output.indexOf('Community plugin')).toBeLessThan(output.indexOf('Clone the plugin'));
  });
});

describe('plugin command dispatch', () => {
  it('shows help with no subcommand', () => {
    const result = runCli(['plugin'], undefined, STRIP);
    expect(result.stdout).toContain('plugin <subcommand>');
    expect(result.stdout).toContain('MCP');
    expect(result.stdout).toContain('trust gate');
  });

  it('errors on an unknown subcommand', () => {
    const result = runCli(['plugin', 'frobnicate'], undefined, STRIP);
    expect(result.stderr + result.stdout).toContain('Unknown plugin subcommand');
    expect(result.exitCode).toBe(1);
  });

  it('errors when install is given no name', () => {
    const result = runCli(['plugin', 'install'], undefined, STRIP);
    expect(result.stderr + result.stdout).toContain('Missing plugin name');
    expect(result.exitCode).toBe(1);
  });
});
