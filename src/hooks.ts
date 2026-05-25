import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { agents } from './agents.ts';
import type { AgentType, HookSchema } from './types.ts';

export type { HookSchema };

export interface HookWiringOptions {
  skillName: string;
  skillId: string;
  agent: AgentType;
  home?: string;
}

// Read hook command templates from env vars at call time (not module load time)
// so that callers can override them in tests or via wrapper injection.
function getHookStartCmd(): string | null {
  const raw = process.env['SKILLS_HOOK_START_CMD'];
  return raw && raw.trim() ? raw.trim() : null;
}

function getHookStopCmd(): string | null {
  const raw = process.env['SKILLS_HOOK_STOP_CMD'];
  return raw && raw.trim() ? raw.trim() : null;
}

function getHookFailCmd(): string | null {
  const raw = process.env['SKILLS_HOOK_FAIL_CMD'];
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * Wire the global stop (and optional fail) hooks for a detected agent.
 * Called once by `skills setup`. Returns true if any change was made.
 */
export async function wireStopHook(
  agentName: AgentType,
  options?: { home?: string }
): Promise<boolean> {
  const config = agents[agentName];
  if (!config.hooksFile || !config.stopEvent || !config.hookSchema) return false;

  const stopCmd = getHookStopCmd();
  if (!stopCmd) return false;

  const home = options?.home ?? homedir();
  const hooksPath = join(home, config.hooksFile);
  const schema = config.hookSchema;

  let changed = false;

  if (writeEventHook(hooksPath, schema, config.stopEvent, stopCmd)) changed = true;

  const failCmd = getHookFailCmd();
  if (failCmd && config.failEvent) {
    if (writeEventHook(hooksPath, schema, config.failEvent, failCmd)) changed = true;
  }

  return changed;
}

/**
 * Wire a per-skill UserPromptSubmit hook for the given agent.
 * Called by `skills add` after installation. Returns true if a change was made.
 */
export async function wireUserPromptHook(options: HookWiringOptions): Promise<boolean> {
  const { skillName, skillId, agent: agentName } = options;
  const config = agents[agentName];
  if (!config.hooksFile || !config.promptEvent || !config.hookSchema) return false;

  const startCmdTemplate = getHookStartCmd();
  if (!startCmdTemplate) return false;
  if (!startCmdTemplate.includes('{{skill_id}}')) return false;

  const home = options.home ?? homedir();
  const hooksPath = join(home, config.hooksFile);

  const startCmd = startCmdTemplate
    .replaceAll('{{skill_id}}', skillId)
    .replaceAll('{{skill_name}}', skillName)
    .replaceAll('{{agent}}', config.name);

  return writePromptHook(hooksPath, config.hookSchema, config.promptEvent, startCmd, skillId);
}

/**
 * Remove the per-skill UserPromptSubmit hook for the given agent.
 * Called by `skills remove`. Returns true if an entry was removed.
 */
export async function removeUserPromptHook(
  options: Pick<HookWiringOptions, 'skillId' | 'agent' | 'home'>
): Promise<boolean> {
  const { skillId, agent: agentName } = options;
  const config = agents[agentName];
  if (!config.hooksFile || !config.promptEvent || !config.hookSchema) return false;

  const home = options.home ?? homedir();
  const hooksPath = join(home, config.hooksFile);

  if (!existsSync(hooksPath)) return false;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(hooksPath, 'utf-8'));
  } catch {
    return false;
  }

  const hooks = settings['hooks'] as Record<string, unknown> | undefined;
  if (!hooks) return false;

  const needle = skillId;
  const promptHooks = hooks[config.promptEvent];
  if (!Array.isArray(promptHooks)) return false;

  const filtered = promptHooks.filter(
    (entry) => !entryContainsCommand(entry, needle, config.hookSchema!)
  );

  if (filtered.length === promptHooks.length) return false;

  hooks[config.promptEvent] = filtered;
  settings['hooks'] = hooks;
  writeJSON(hooksPath, settings);
  return true;
}

/**
 * Returns true if the global stop hook is already wired for at least one detected agent.
 */
export function isHookSetupDone(home?: string): boolean {
  const stopCmd = getHookStopCmd();
  if (!stopCmd) return false;

  const resolvedHome = home ?? homedir();
  for (const config of Object.values(agents)) {
    if (!config.hooksFile) continue;
    const hooksPath = join(resolvedHome, config.hooksFile);
    try {
      const content = readFileSync(hooksPath, 'utf-8');
      if (content.includes(stopCmd)) return true;
    } catch {
      // file doesn't exist — skip
    }
  }
  return false;
}

// ─── Private helpers ───────────────────────────────────────────────────────

function readSettings(hooksPath: string, schema: HookSchema): Record<string, unknown> {
  const base: Record<string, unknown> = schema === 'flat' ? { version: 1 } : {};
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Record<string, unknown>;
    if (schema === 'flat' && parsed['version'] === undefined) {
      parsed['version'] = 1;
    }
    return parsed;
  } catch {
    return base;
  }
}

function writeJSON(hooksPath: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function getOrCreateHooks(settings: Record<string, unknown>): Record<string, unknown> {
  if (
    typeof settings['hooks'] !== 'object' ||
    settings['hooks'] === null ||
    Array.isArray(settings['hooks'])
  ) {
    settings['hooks'] = {};
  }
  return settings['hooks'] as Record<string, unknown>;
}

function getEventEntries(hooks: Record<string, unknown>, event: string): unknown[] {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  return hooks[event] as unknown[];
}

function nestedEntry(command: string): Record<string, unknown> {
  return {
    hooks: [{ type: 'command', command, timeout: 5 }],
  };
}

function flatEntry(command: string): Record<string, unknown> {
  return { type: 'command', command, timeout: 5 };
}

function writeEventHook(
  hooksPath: string,
  schema: HookSchema,
  event: string,
  command: string
): boolean {
  const settings = readSettings(hooksPath, schema);
  const hooks = getOrCreateHooks(settings);
  const entries = getEventEntries(hooks, event);

  if (schema === 'flat') {
    if (entries.some((e) => (e as Record<string, unknown>)['command'] === command)) return false;
    entries.push(flatEntry(command));
  } else {
    if (entries.some((e) => commandInNestedEntry(e, command))) return false;
    entries.push(nestedEntry(command));
  }

  hooks[event] = entries;
  settings['hooks'] = hooks;
  writeJSON(hooksPath, settings);
  return true;
}

function writePromptHook(
  hooksPath: string,
  schema: HookSchema,
  event: string,
  command: string,
  skillId: string
): boolean {
  const settings = readSettings(hooksPath, schema);
  const hooks = getOrCreateHooks(settings);
  const entries = getEventEntries(hooks, event);

  const needle = skillId;
  const others = entries.filter((e) => !entryContainsCommand(e, needle, schema));

  // If there's an existing entry for this skill-id that already has the right command, no-op.
  if (others.length < entries.length) {
    const existing = entries.find((e) => entryContainsCommand(e, needle, schema));
    if (existing) {
      const existingCmd =
        schema === 'flat'
          ? (existing as Record<string, unknown>)['command']
          : getNestedCommand(existing);
      if (existingCmd === command) return false;
    }
  }

  const newEntry = schema === 'flat' ? flatEntry(command) : nestedEntry(command);
  hooks[event] = [...others, newEntry];
  settings['hooks'] = hooks;
  writeJSON(hooksPath, settings);
  return true;
}

function entryContainsCommand(entry: unknown, needle: string, schema: HookSchema): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const m = entry as Record<string, unknown>;
  if (schema === 'flat') {
    return typeof m['command'] === 'string' && m['command'].includes(needle);
  }
  const inner = m['hooks'];
  if (!Array.isArray(inner)) return false;
  return inner.some(
    (h) =>
      typeof h === 'object' &&
      h !== null &&
      typeof (h as Record<string, unknown>)['command'] === 'string' &&
      ((h as Record<string, unknown>)['command'] as string).includes(needle)
  );
}

function commandInNestedEntry(entry: unknown, command: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const inner = (entry as Record<string, unknown>)['hooks'];
  if (!Array.isArray(inner)) return false;
  return inner.some(
    (h) =>
      typeof h === 'object' && h !== null && (h as Record<string, unknown>)['command'] === command
  );
}

function getNestedCommand(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const inner = (entry as Record<string, unknown>)['hooks'];
  if (!Array.isArray(inner) || inner.length === 0) return undefined;
  const first = inner[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const cmd = (first as Record<string, unknown>)['command'];
  return typeof cmd === 'string' ? cmd : undefined;
}
