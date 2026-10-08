/**
 * The `skills` field of package.json: skills a package wants installed
 * without shipping their files. Grammar: https://github.com/antfu/skills-npm/blob/main/SPEC.md
 */
type SkillsFieldEntry = string | { source: string; skills?: string[]; ref?: string };

/** `npm:<package>`: the skills shipped by an installed package. */
interface NpmSkillsRequest {
  package: string;
  /** Folder or sanitized skill names to keep; empty means all. */
  skills: string[];
}

interface ParsedSkillsField {
  npm: NpmSkillsRequest[];
  errors: string[];
}

const NPM_PREFIX = 'npm:';

function isSkillsFieldEntry(value: unknown): value is SkillsFieldEntry {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || !('source' in value)) return false;
  if (typeof value.source !== 'string') return false;
  const skills = 'skills' in value ? value.skills : undefined;
  const ref = 'ref' in value ? value.ref : undefined;
  return (
    (skills === undefined ||
      (Array.isArray(skills) && skills.every((s) => typeof s === 'string'))) &&
    (ref === undefined || typeof ref === 'string')
  );
}

/** Parse the entries of `declarer`'s `skills` field. Problems are returned, not thrown. */
export function parseSkillsField(entries: unknown[], declarer: string): ParsedSkillsField {
  const parsed: ParsedSkillsField = { npm: [], errors: [] };

  for (const raw of entries) {
    if (!isSkillsFieldEntry(raw)) {
      parsed.errors.push(`${declarer}: invalid "skills" entry ${JSON.stringify(raw)}`);
      continue;
    }
    const { source, skills = [], ref } = typeof raw === 'string' ? { source: raw } : raw;
    // remote (git) entries are not synced yet
    if (!source.startsWith(NPM_PREFIX)) continue;

    if (ref !== undefined) {
      parsed.errors.push(`${declarer}: "ref" cannot be used with "${source}"`);
    } else {
      parsed.npm.push({ package: source.slice(NPM_PREFIX.length), skills });
    }
  }

  return parsed;
}
