/**
 * Enterprise customization via environment variables:
 *
 * SKILLS_LOGO          — newline-separated ASCII art replacing the default logo;
 *                        lines may contain pre-colored ANSI escape codes (colors
 *                        are passed through as-is rather than wrapped in grays)
 * SKILLS_CLI_NAME      — CLI executable name shown in usage hints (default: "npx skills")
 * SKILLS_INSTALL_VERB  — install sub-command name (default: "add")
 * SKILLS_FIND_VERB     — find/search sub-command name (default: "find")
 * SKILLS_URL_BASE      — base URL for skill source links (default: "https://skills.sh")
 *                        When set to a GitHub URL, links are constructed as:
 *                          {SKILLS_URL_BASE}/{owner}/{repo}/blob/{branch}/{path}
 * SKILLS_URL_BRANCH    — branch name used when building GitHub-style URLs (default: "main")
 */

export interface EnvConfig {
  logoLines: string[] | null;
  cliName: string;
  installVerb: string;
  findVerb: string;
  urlBase: string;
  urlBranch: string;
}

function parseLogoLines(): string[] | null {
  const raw = process.env.SKILLS_LOGO;
  if (!raw) return null;
  const lines = raw.split('\n');
  return lines.length > 0 ? lines : null;
}

export const envConfig: EnvConfig = {
  logoLines: parseLogoLines(),
  cliName: process.env.SKILLS_CLI_NAME || 'npx skills',
  installVerb: process.env.SKILLS_INSTALL_VERB || 'add',
  findVerb: process.env.SKILLS_FIND_VERB || 'find',
  urlBase: (process.env.SKILLS_URL_BASE || 'https://skills.sh').replace(/\/$/, ''),
  urlBranch: process.env.SKILLS_URL_BRANCH || 'main',
};

/**
 * Build a URL pointing to a skill's source file.
 *
 * When urlBase is the default skills.sh, the slug from the search API is used
 * as-is: https://skills.sh/{slug}
 *
 * When urlBase is a GitHub-style host, the slug (owner/repo/...path/SKILL.md)
 * is decomposed into a blob URL:
 *   {base}/{owner}/{repo}/blob/{branch}/{...path/SKILL.md}
 */
export function buildSkillUrl(slug: string): string {
  const { urlBase, urlBranch } = envConfig;
  if (urlBase === 'https://skills.sh') {
    return `${urlBase}/${slug}`;
  }
  // Decompose slug: first segment = owner, second = repo, rest = file path
  const parts = slug.split('/');
  if (parts.length >= 3) {
    const owner = parts[0];
    const repo = parts[1];
    const filePath = parts.slice(2).join('/');
    return `${urlBase}/${owner}/${repo}/blob/${urlBranch}/${filePath}`;
  }
  // Fallback: just append slug
  return `${urlBase}/${slug}`;
}

/** Full install command, e.g. "npx skills add" or "playlist-skills install" */
export function installCmd(): string {
  return `${envConfig.cliName} ${envConfig.installVerb}`;
}

/** Full find command, e.g. "npx skills find" or "playlist-skills search" */
export function findCmd(): string {
  return `${envConfig.cliName} ${envConfig.findVerb}`;
}
