import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  wireStopHook,
  wireUserPromptHook,
  removeUserPromptHook,
  isHookSetupDone,
} from './hooks.ts';

// @vercel/detect-agent is mocked so tests don't depend on actual env vars
vi.mock('@vercel/detect-agent', () => ({
  determineAgent: vi.fn(() => ({ isAgent: true, agent: { name: 'claude-code' } })),
}));

// ─── helpers ───────────────────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function makeHome(): string {
  const dir = join(tmpdir(), `hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── wireStopHook ──────────────────────────────────────────────────────────

describe('wireStopHook', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    process.env['SKILLS_HOOK_STOP_CMD'] = 'playlist-skills track stop';
    process.env['SKILLS_HOOK_FAIL_CMD'] = 'playlist-skills track stop --succeeded=false';
    delete process.env['SKILLS_HOOK_START_CMD'];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env['SKILLS_HOOK_STOP_CMD'];
    delete process.env['SKILLS_HOOK_FAIL_CMD'];
  });

  it('returns false when SKILLS_HOOK_STOP_CMD is unset', async () => {
    delete process.env['SKILLS_HOOK_STOP_CMD'];
    const changed = await wireStopHook('claude-code', { home });
    expect(changed).toBe(false);
  });

  it('writes nested stop hook for claude-code', async () => {
    const changed = await wireStopHook('claude-code', { home });
    expect(changed).toBe(true);

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const stopHooks = (settings['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(stopHooks).toHaveLength(1);
    const inner = (stopHooks[0] as Record<string, unknown>)['hooks'] as unknown[];
    expect((inner[0] as Record<string, unknown>)['command']).toBe('playlist-skills track stop');
  });

  it('writes flat stop hook for cursor', async () => {
    const changed = await wireStopHook('cursor', { home });
    expect(changed).toBe(true);

    const settings = readJson(join(home, '.cursor', 'hooks.json'));
    expect((settings as Record<string, unknown>)['version']).toBe(1);
    const stopHooks = (settings['hooks'] as Record<string, unknown>)['stop'] as unknown[];
    expect((stopHooks[0] as Record<string, unknown>)['command']).toBe('playlist-skills track stop');
  });

  it('writes flat stop + fail hooks for github-copilot', async () => {
    const changed = await wireStopHook('github-copilot', { home });
    expect(changed).toBe(true);

    const settings = readJson(join(home, '.copilot', 'hooks', 'skills.json'));
    const hooks = settings['hooks'] as Record<string, unknown>;
    expect(hooks['agentStop'] as unknown[]).toHaveLength(1);
    expect(((hooks['agentStop'] as unknown[])[0] as Record<string, unknown>)['command']).toBe(
      'playlist-skills track stop'
    );
    expect(hooks['errorOccurred'] as unknown[]).toHaveLength(1);
    expect(((hooks['errorOccurred'] as unknown[])[0] as Record<string, unknown>)['command']).toBe(
      'playlist-skills track stop --succeeded=false'
    );
  });

  it('writes nested stop + StopFailure hooks for claude-code', async () => {
    const changed = await wireStopHook('claude-code', { home });
    expect(changed).toBe(true);

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const hooks = settings['hooks'] as Record<string, unknown>;
    expect(hooks['Stop'] as unknown[]).toHaveLength(1);
    expect(((hooks['Stop'] as unknown[])[0] as Record<string, unknown>)['hooks']).toBeDefined();
    expect(hooks['StopFailure'] as unknown[]).toHaveLength(1);
    const failInner = ((hooks['StopFailure'] as unknown[])[0] as Record<string, unknown>)[
      'hooks'
    ] as unknown[];
    expect((failInner[0] as Record<string, unknown>)['command']).toBe(
      'playlist-skills track stop --succeeded=false'
    );
  });

  it('is idempotent — second call returns false and does not duplicate entries', async () => {
    await wireStopHook('claude-code', { home });
    const changed = await wireStopHook('claude-code', { home });
    expect(changed).toBe(false);

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const stopHooks = (settings['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(stopHooks).toHaveLength(1);
  });

  it('merges into an existing settings file without clobbering other keys', async () => {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-5', hooks: { PreToolUse: [] } })
    );

    await wireStopHook('claude-code', { home });

    const settings = readJson(join(claudeDir, 'settings.json'));
    expect(settings['model']).toBe('claude-opus-4-5');
    expect((settings['hooks'] as Record<string, unknown>)['PreToolUse']).toEqual([]);
    expect((settings['hooks'] as Record<string, unknown>)['Stop']).toHaveLength(1);
  });

  it('returns false for an agent without hook support (windsurf)', async () => {
    const changed = await wireStopHook('windsurf' as never, { home });
    expect(changed).toBe(false);
  });
});

// ─── wireUserPromptHook ────────────────────────────────────────────────────

describe('wireUserPromptHook', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    process.env['SKILLS_HOOK_START_CMD'] =
      'playlist-skills track start --skill-id {{skill_id}} --agent {{agent}} --match-prompt /{{skill_name}}';
    delete process.env['SKILLS_HOOK_STOP_CMD'];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env['SKILLS_HOOK_START_CMD'];
  });

  it('returns false when SKILLS_HOOK_START_CMD is unset', async () => {
    delete process.env['SKILLS_HOOK_START_CMD'];
    const changed = await wireUserPromptHook({
      skillName: 'my-skill',
      skillId: 'abc-123',
      agent: 'claude-code',
      home,
    });
    expect(changed).toBe(false);
  });

  it('substitutes {{skill_id}}, {{skill_name}}, {{agent}} tokens', async () => {
    await wireUserPromptHook({
      skillName: 'pr-review',
      skillId: 'skill-uuid-001',
      agent: 'claude-code',
      home,
    });

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const promptHooks = (settings['hooks'] as Record<string, unknown>)[
      'UserPromptSubmit'
    ] as unknown[];
    const inner = (promptHooks[0] as Record<string, unknown>)['hooks'] as unknown[];
    const cmd = (inner[0] as Record<string, unknown>)['command'] as string;

    expect(cmd).toContain('--skill-id skill-uuid-001');
    expect(cmd).toContain('--agent claude-code');
    expect(cmd).toContain('--match-prompt /pr-review');
  });

  it('uses flat schema for cursor', async () => {
    await wireUserPromptHook({
      skillName: 'pr-review',
      skillId: 'skill-uuid-002',
      agent: 'cursor',
      home,
    });

    const settings = readJson(join(home, '.cursor', 'hooks.json'));
    const promptHooks = (settings['hooks'] as Record<string, unknown>)[
      'beforeSubmitPrompt'
    ] as unknown[];
    expect(promptHooks).toHaveLength(1);
    expect((promptHooks[0] as Record<string, unknown>)['command']).toContain(
      '--skill-id skill-uuid-002'
    );
  });

  it('replaces existing entry for same skill-id on reinstall', async () => {
    const opts = {
      skillName: 'pr-review',
      skillId: 'skill-uuid-003',
      agent: 'claude-code' as const,
      home,
    };

    process.env['SKILLS_HOOK_START_CMD'] =
      'playlist-skills track start --skill-id {{skill_id}} --agent {{agent}} --match-prompt /{{skill_name}}';
    await wireUserPromptHook(opts);

    process.env['SKILLS_HOOK_START_CMD'] =
      'playlist-skills track start --skill-id {{skill_id}} --agent {{agent}} --match-prompt /{{skill_name}} --extra-flag';
    await wireUserPromptHook(opts);

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const promptHooks = (settings['hooks'] as Record<string, unknown>)[
      'UserPromptSubmit'
    ] as unknown[];
    expect(promptHooks).toHaveLength(1);
    const inner = (promptHooks[0] as Record<string, unknown>)['hooks'] as unknown[];
    expect((inner[0] as Record<string, unknown>)['command']).toContain('--extra-flag');
  });

  it('keeps entries for different skill-ids when adding a second skill', async () => {
    process.env['SKILLS_HOOK_START_CMD'] =
      'playlist-skills track start --skill-id {{skill_id}} --agent {{agent}} --match-prompt /{{skill_name}}';

    await wireUserPromptHook({
      skillName: 'skill-a',
      skillId: 'id-aaa',
      agent: 'claude-code',
      home,
    });
    await wireUserPromptHook({
      skillName: 'skill-b',
      skillId: 'id-bbb',
      agent: 'claude-code',
      home,
    });

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const promptHooks = (settings['hooks'] as Record<string, unknown>)[
      'UserPromptSubmit'
    ] as unknown[];
    expect(promptHooks).toHaveLength(2);
  });
});

// ─── removeUserPromptHook ──────────────────────────────────────────────────

describe('removeUserPromptHook', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    process.env['SKILLS_HOOK_START_CMD'] =
      'playlist-skills track start --skill-id {{skill_id}} --agent {{agent}} --match-prompt /{{skill_name}}';
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env['SKILLS_HOOK_START_CMD'];
  });

  it('removes the correct entry and leaves others intact', async () => {
    await wireUserPromptHook({
      skillName: 'skill-a',
      skillId: 'id-aaa',
      agent: 'claude-code',
      home,
    });
    await wireUserPromptHook({
      skillName: 'skill-b',
      skillId: 'id-bbb',
      agent: 'claude-code',
      home,
    });

    const removed = await removeUserPromptHook({ skillId: 'id-aaa', agent: 'claude-code', home });
    expect(removed).toBe(true);

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const promptHooks = (settings['hooks'] as Record<string, unknown>)[
      'UserPromptSubmit'
    ] as unknown[];
    expect(promptHooks).toHaveLength(1);
    const inner = (promptHooks[0] as Record<string, unknown>)['hooks'] as unknown[];
    expect((inner[0] as Record<string, unknown>)['command']).toContain('--skill-id id-bbb');
  });

  it('returns false when skill-id is not present', async () => {
    await wireUserPromptHook({
      skillName: 'skill-a',
      skillId: 'id-aaa',
      agent: 'claude-code',
      home,
    });

    const removed = await removeUserPromptHook({
      skillId: 'nonexistent-id',
      agent: 'claude-code',
      home,
    });
    expect(removed).toBe(false);
  });

  it('returns false when hooks file does not exist', async () => {
    const removed = await removeUserPromptHook({ skillId: 'any-id', agent: 'claude-code', home });
    expect(removed).toBe(false);
  });

  it('removes flat-schema entry for cursor', async () => {
    await wireUserPromptHook({
      skillName: 'my-skill',
      skillId: 'flat-id-001',
      agent: 'cursor',
      home,
    });
    const removed = await removeUserPromptHook({ skillId: 'flat-id-001', agent: 'cursor', home });
    expect(removed).toBe(true);

    const settings = readJson(join(home, '.cursor', 'hooks.json'));
    const promptHooks = (settings['hooks'] as Record<string, unknown>)[
      'beforeSubmitPrompt'
    ] as unknown[];
    expect(promptHooks).toHaveLength(0);
  });
});

// ─── isHookSetupDone ───────────────────────────────────────────────────────

describe('isHookSetupDone', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    process.env['SKILLS_HOOK_STOP_CMD'] = 'playlist-skills track stop';
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env['SKILLS_HOOK_STOP_CMD'];
  });

  it('returns false when no hooks files exist', () => {
    expect(isHookSetupDone(home)).toBe(false);
  });

  it('returns true after wireStopHook has been called', async () => {
    await wireStopHook('claude-code', { home });
    expect(isHookSetupDone(home)).toBe(true);
  });

  it('returns false when SKILLS_HOOK_STOP_CMD is unset', async () => {
    await wireStopHook('claude-code', { home });
    delete process.env['SKILLS_HOOK_STOP_CMD'];
    expect(isHookSetupDone(home)).toBe(false);
  });
});
