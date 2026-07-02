import { runAdd, parseAddOptions } from './add.ts';
import { sanitizeMetadata } from './sanitize.ts';
import { track } from './telemetry.ts';
import { getRepoVisibility } from './source-parser.ts';
import { isRunningInAgent } from './detect-agent.ts';
import { envConfig, installCmd, findCmd } from './env-config.ts';
import { interactiveSearch } from './search-prompt.ts';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[38;5;102m';
const TEXT = '\x1b[38;5;145m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const YELLOW = '\x1b[33m';

function formatInstalls(count: number): string {
  if (!count || count <= 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`;
  return `${count} install${count === 1 ? '' : 's'}`;
}

export interface SearchSkill {
  name: string;
  slug: string;
  source: string;
  installs: number;
}

// Search via API
export async function searchSkillsAPI(query: string): Promise<SearchSkill[]> {
  try {
    const url = `${envConfig.apiBase}/api/search?q=${encodeURIComponent(query)}&limit=10`;
    const res = await fetch(url);

    if (!res.ok) return [];

    const data = (await res.json()) as {
      skills: Array<{
        id: string;
        skillId?: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    return data.skills
      .map((skill) => ({
        name: sanitizeMetadata(skill.name),
        slug: sanitizeMetadata(skill.skillId || skill.id),
        source: sanitizeMetadata(skill.source || ''),
        installs: skill.installs,
      }))
      .sort((a, b) => (b.installs || 0) - (a.installs || 0));
  } catch {
    return [];
  }
}

// Interactive skill search, backed by the shared fzf-style prompt.
async function runSearchPrompt(): Promise<SearchSkill | null> {
  return interactiveSearch<SearchSkill>({
    label: 'Search skills:',
    minChars: 2,
    emptyMessage: 'No skills found',
    search: (q) => searchSkillsAPI(q),
    renderRow: (skill, selected) => {
      const name = selected ? `${BOLD}${skill.name}${RESET}` : `${TEXT}${skill.name}${RESET}`;
      const source = skill.source ? ` ${DIM}${skill.source}${RESET}` : '';
      const installs = formatInstalls(skill.installs);
      const installsBadge = installs ? ` ${CYAN}${installs}${RESET}` : '';
      return `${name}${source}${installsBadge}`;
    },
  });
}

// Parse owner/repo from a package string (for the find command)
function getOwnerRepoFromString(pkg: string): { owner: string; repo: string } | null {
  // Handle owner/repo or owner/repo@skill
  const atIndex = pkg.lastIndexOf('@');
  const repoPath = atIndex > 0 ? pkg.slice(0, atIndex) : pkg;
  const match = repoPath.match(/^([^/]+)\/([^/]+)$/);
  if (match) {
    return { owner: match[1]!, repo: match[2]! };
  }
  return null;
}

async function isRepoPublic(owner: string, repo: string): Promise<boolean> {
  return (await getRepoVisibility(owner, repo)) === 'public';
}

export async function runFind(args: string[]): Promise<void> {
  const query = args.join(' ');
  const isNonInteractive = !process.stdin.isTTY;
  const cmd = installCmd();
  const find = findCmd();
  const agentTip = `${DIM}Tip: if running in a coding agent, follow these steps:${RESET}
${DIM}  1) ${find} [query]${RESET}
${DIM}  2) ${cmd} <owner/repo@skill>${RESET}`;

  // Non-interactive mode: just print results and exit
  if (query) {
    const results = await searchSkillsAPI(query);

    // Track telemetry for non-interactive search
    track({
      event: 'find',
      query,
      resultCount: String(results.length),
    });

    if (results.length === 0) {
      console.log(`${DIM}No skills found for "${query}"${RESET}`);
      return;
    }

    console.log(`${DIM}Install with${RESET} ${cmd} <owner/repo@skill>`);
    console.log();

    for (const skill of results.slice(0, 6)) {
      const pkg = skill.source || skill.slug;
      const installs = formatInstalls(skill.installs);
      console.log(
        `${TEXT}${pkg}@${skill.name}${RESET}${installs ? ` ${CYAN}${installs}${RESET}` : ''}`
      );
      console.log(`${DIM}└ ${envConfig.apiBase}/${skill.slug}${RESET}`);
      console.log();
    }
    return;
  }

  // Skip interactive search when running inside an AI agent or non-TTY
  if (isNonInteractive || (await isRunningInAgent())) {
    console.log(agentTip);
    console.log();
    console.log(`${DIM}Usage: ${find} <query>${RESET}`);
    return;
  }

  const selected = await runSearchPrompt();

  // Track telemetry for interactive search
  track({
    event: 'find',
    query: '',
    resultCount: selected ? '1' : '0',
    interactive: '1',
  });

  if (!selected) {
    console.log(`${DIM}Search cancelled${RESET}`);
    console.log();
    return;
  }

  // Use source (owner/repo) and skill name for installation
  const pkg = selected.source || selected.slug;
  const skillName = selected.name;

  console.log();
  console.log(`${TEXT}Installing ${BOLD}${skillName}${RESET} from ${DIM}${pkg}${RESET}...`);
  console.log();

  // Run add directly since we're in the same CLI
  const { source, options } = parseAddOptions([pkg, '--skill', skillName]);
  await runAdd(source, options);

  console.log();

  const info = getOwnerRepoFromString(pkg);
  if (info && (await isRepoPublic(info.owner, info.repo))) {
    console.log(
      `${DIM}View the skill at${RESET} ${TEXT}${envConfig.apiBase}/${selected.slug}${RESET}`
    );
  } else {
    console.log(`${DIM}Discover more skills at${RESET} ${TEXT}${envConfig.apiBase}${RESET}`);
  }

  console.log();
}
