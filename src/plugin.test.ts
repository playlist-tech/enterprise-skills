import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { runCli } from './test-utils.ts';
import { normalizePluginManifest, manifestSkillNames, runPlugin } from './plugin.ts';
import { runAdd } from './add.ts';

// Stub only runAdd so the install flow can be driven in-process; keep the rest
// of add.ts (parseAddOptions etc.) real.
vi.mock('./add.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./add.ts')>();
  return { ...actual, runAdd: vi.fn(async () => {}) };
});

// The subprocess CLI tests shell out to `node cli.ts`; ensure TypeScript is
// stripped regardless of the local Node version.
const STRIP = { NODE_OPTIONS: '--experimental-strip-types --no-warnings' };

describe('normalizePluginManifest', () => {
  it('parses a valid manifest', () => {
    const manifest = normalizePluginManifest(
      {
        name: 'poc-platform-tools',
        version: '0.1.0',
        description: 'desc',
        skills: ['skills/golden/skill-finder', 'skills/community/git-for-non-engineers'],
      },
      'ref'
    );
    expect(manifest.name).toBe('poc-platform-tools');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.skills).toHaveLength(2);
  });

  it('throws when name is missing', () => {
    expect(() => normalizePluginManifest({ skills: ['a/b'] }, 'ref')).toThrow(/name/);
  });

  it('throws when skills is empty or not a string list', () => {
    expect(() => normalizePluginManifest({ name: 'p', skills: [] }, 'ref')).toThrow(/skills/);
    expect(() => normalizePluginManifest({ name: 'p', skills: [1, 2] }, 'ref')).toThrow(/skills/);
    expect(() => normalizePluginManifest({ name: 'p' }, 'ref')).toThrow(/skills/);
  });

  it('throws when the top level is not a mapping', () => {
    expect(() => normalizePluginManifest('nope', 'ref')).toThrow(/mapping/);
  });
});

describe('manifestSkillNames', () => {
  it('derives directory basenames from skill paths', () => {
    const names = manifestSkillNames({
      name: 'p',
      skills: ['skills/community/ci-watch', 'skills/golden/skill-finder/'],
    });
    expect(names).toEqual(['ci-watch', 'skill-finder']);
  });
});

describe('plugin install wiring', () => {
  const yamlBody = [
    'name: poc-platform-tools',
    'version: 0.1.0',
    'description: A test plugin',
    'skills:',
    '  - skills/golden/skill-finder',
    '  - skills/community/git-for-non-engineers',
  ].join('\n');

  beforeEach(() => {
    vi.mocked(runAdd).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => yamlBody }) as Response)
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves plugin.yaml members and delegates to runAdd with a pluginName tag', async () => {
    await runPlugin(['install', 'playlist-tech/gen-ai-skills@poc-platform-tools']);

    expect(runAdd).toHaveBeenCalledTimes(1);
    const [sourceArg, optionsArg] = vi.mocked(runAdd).mock.calls[0]!;
    expect(sourceArg).toEqual(['playlist-tech/gen-ai-skills']);
    expect(optionsArg).toMatchObject({
      skill: ['skill-finder', 'git-for-non-engineers'],
      pluginName: 'poc-platform-tools',
    });
  });
});

describe('plugin command dispatch', () => {
  it('shows help with no subcommand', () => {
    const result = runCli(['plugin'], undefined, STRIP);
    expect(result.stdout).toContain('plugin <subcommand>');
    expect(result.stdout).toContain('install');
  });

  it('errors on an unknown subcommand', () => {
    const result = runCli(['plugin', 'frobnicate'], undefined, STRIP);
    expect(result.stderr + result.stdout).toContain('Unknown plugin subcommand');
    expect(result.exitCode).toBe(1);
  });

  it('errors when install is given no source', () => {
    const result = runCli(['plugin', 'install'], undefined, STRIP);
    expect(result.stderr + result.stdout).toContain('Missing plugin source');
    expect(result.exitCode).toBe(1);
  });

  it('errors when install source has no @plugin-name', () => {
    const result = runCli(['plugin', 'install', 'org/repo'], undefined, STRIP);
    expect(result.stderr + result.stdout).toContain('plugin name');
    expect(result.exitCode).toBe(1);
  });

  it('reports no plugins installed in an empty project', () => {
    const dir = join(tmpdir(), `skills-plugin-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const result = runCli(['plugin', 'list'], dir, STRIP);
      expect(result.stdout).toContain('No plugins installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: a plugin installed at project scope records its pluginName in
  // the local skills-lock.json, and `plugin list` must find it there — not only
  // in the global lock.
  it('lists a project-scoped plugin from the local lock', () => {
    const dir = join(tmpdir(), `skills-plugin-local-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const localLock = {
        version: 1,
        skills: {
          'skill-finder': {
            source: 'playlist-tech/gen-ai-skills',
            sourceType: 'github',
            computedHash: 'abc123',
            pluginName: 'poc-platform-tools',
          },
        },
      };
      writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify(localLock, null, 2));
      const result = runCli(['plugin', 'list'], dir, STRIP);
      expect(result.stdout).toContain('poc-platform-tools');
      expect(result.stdout).toContain('skill-finder');
      expect(result.stdout).not.toContain('No plugins installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
