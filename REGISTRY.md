# Skills Registry API Spec

This document defines the API contract for a skills registry compatible with the `skills` CLI. Implementing this spec allows any self-hosted registry to work as a drop-in replacement for skills.sh by setting `SKILLS_API_URL`.

## Endpoints

### `GET /api/search`

Search for skills by keyword.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query. If omitted or empty, returns all skills. |
| `limit` | number | Maximum results to return (optional). |

**Response**

```json
{
  "query": "find-skills",
  "searchType": "fuzzy",
  "skills": [
    {
      "id": "vercel-labs/skills/find-skills",
      "skillId": "find-skills",
      "name": "find-skills",
      "installs": 1591220,
      "source": "vercel-labs/skills"
    }
  ],
  "count": 1,
  "duration_ms": 42
}
```

**Envelope fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | no | The search query that produced these results. |
| `searchType` | string | no | Search strategy used (e.g. `"fuzzy"`, `"all"`). |
| `skills` | array | yes | Array of skill results. |
| `count` | number | no | Total number of results returned. |
| `duration_ms` | number | no | Time taken to execute the search in milliseconds. |

**Skill fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Canonical identifier for the skill. Recommended format: `{source}/{name}` (e.g. `vercel-labs/skills/find-skills`). Used as the URL path for the detail page. |
| `skillId` | string | no | Short skill name slug (e.g. `find-skills`). When present, the CLI uses this as the URL slug in preference to `id`. Self-hosted registries may set this to a different value than `name` (e.g. a full path slug). |
| `name` | string | yes | Display name of the skill. |
| `installs` | number | yes | Install count. Use `0` if not tracked. |
| `source` | string | yes | Repository source in `{org}/{repo}` format. |

### `GET /api/bundles/search`

Search for bundles (curated sets of skills defined by a `bundles/<name>/bundle.yaml`
manifest in a repository) by keyword. Uses semantic (vector) search when the
query can be embedded, falling back to fuzzy text search otherwise — the same
two-tier strategy as `GET /api/search`. Used by `skills bundle search`.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query. If omitted or empty, returns all bundles. |

**Response**

```json
{
  "query": "code review",
  "searchType": "semantic",
  "bundles": [
    {
      "name": "code-review-suite",
      "description": "Bundle of code review skills",
      "source": "playlist-tech/gen-ai-skills",
      "version": "0.1.0",
      "installs": 0,
      "skills": ["skills/golden/ios-review", "skills/golden/kotlin-review"],
      "tags": ["code-review", "quality"]
    }
  ],
  "count": 1,
  "duration_ms": 42
}
```

**Envelope fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | no | The search query that produced these results. |
| `searchType` | string | no | Search strategy used: `"semantic"`, `"fuzzy"`, or `"all"` (empty query). |
| `bundles` | array | yes | Array of bundle results. |
| `count` | number | no | Total number of results returned. |
| `duration_ms` | number | no | Time taken to execute the search in milliseconds. |

**Bundle fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Bundle name (the `@<name>` used in `bundle install`). |
| `description` | string | no | Human-readable description. |
| `source` | string | yes | Repository source in `{org}/{repo}` format. |
| `version` | string \| null | no | Bundle version from `bundle.yaml`, if any. |
| `installs` | number | yes | Install count. Use `0` if not tracked. |
| `skills` | array | no | Member skill paths declared by the bundle (repo-relative). |
| `tags` | array | no | Discovery keywords for the bundle, from the manifest's `tags`. Folded into semantic and fuzzy search matching. |

A registry that does not implement this endpoint should return `404`; the CLI treats that as "bundle search not available" and still supports installing a known bundle by name.

### `GET /api/plugins/search`

Search for **native agent plugins** — packages in an agent's own plugin format (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, …) bundling skills **plus** MCP servers, hooks, commands, and subagents. Catalog entries are pinned to a reviewed commit SHA. Used by `skills plugin search`.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query. If omitted or empty, returns all plugins. |

**Response**

```json
{
  "query": "incident",
  "searchType": "semantic",
  "plugins": [
    {
      "name": "incident-tools",
      "description": "Incident response skills plus a live incident-db MCP server.",
      "source": "playlist-tech/incident-forge",
      "path": "",
      "sha": "0123456789abcdef0123456789abcdef01234567",
      "version": "1.2.0",
      "components": { "skills": 3, "mcpServers": 1, "hooks": 2, "commands": 0, "agents": 0 },
      "mcpServerNames": ["incident-db"],
      "tags": ["incidents"],
      "installs": 0
    }
  ],
  "count": 1,
  "duration_ms": 42
}
```

`components` is the plugin's component inventory — the CLI renders it as badges so users see what a plugin wires up before installing. `sha` is the pinned commit every install step references (never a floating branch).

A registry that does not implement this endpoint should return `404`; the CLI treats that as "native plugin search not available".

### `GET /api/plugins/{name}/install?agent={agent}`

Returns the per-agent install recipe for a plugin: the exact placement/registration steps plus the agent's trust step. The CLI **shows** these steps (disclosing the component inventory first); activation always ends at the agent's own trust gate.

**Response**

```json
{
  "name": "incident-tools",
  "version": "1.2.0",
  "source": { "org": "playlist-tech", "repo": "incident-forge", "path": "", "sha": "0123456…" },
  "components": { "skills": 3, "mcpServers": 1, "hooks": 2, "commands": 0, "agents": 0 },
  "mcpServerNames": ["incident-db"],
  "agent": "claude",
  "disclosure": "Wires 3 skills, 1 MCP server (incident-db), 2 hooks from playlist-tech/incident-forge@0123456",
  "steps": [
    { "kind": "clone", "description": "Clone the plugin source at the pinned commit", "command": "git clone … && git checkout …" },
    { "kind": "place", "description": "Copy the plugin directory into Claude Code's skills dir", "dest": "~/.claude/skills/incident-tools/" }
  ],
  "trust": { "description": "Restart Claude Code and approve the workspace-trust prompt to activate the MCP server and hooks." }
}
```

Errors: `404` — plugin not in the catalog; `400` — missing/unsupported `agent` (the body should include `availableAgents`).

### GET Skill Details

Returns detail for a single skill. Two URL forms are supported:

- `GET /{id}` — look up by the `id` field from a search result (e.g. `vercel-labs/skills/find-skills` or a UUID for registries that use opaque identifiers)
- `GET /{skillId}` — look up by the `skillId` field (e.g. `find-skills`, or a full path slug like `{source}/{name}` for self-hosted registries)

**Response**: the full skill record. Shape is registry-defined; the CLI does not currently consume this endpoint directly but links to it in terminal output.

## Self-hosting

Point the CLI at your registry by setting `SKILLS_API_URL`:

```bash
SKILLS_API_URL=https://skills.example.com npx skills find <query>
```

Both the search API calls and rendered detail URLs in terminal output will use this base URL.
