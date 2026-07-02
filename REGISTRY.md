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

### `GET /api/plugins/search`

Search for plugins (curated bundles of skills) by keyword. Uses semantic (vector)
search when the query can be embedded, falling back to fuzzy text search
otherwise — the same two-tier strategy as `GET /api/search`.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query. If omitted or empty, returns all plugins. |

**Response**

```json
{
  "query": "code review",
  "searchType": "semantic",
  "plugins": [
    {
      "name": "code-review-suite",
      "description": "Bundle of code review skills",
      "source": "playlist-tech/gen-ai-skills",
      "version": "0.1.0",
      "installs": 0,
      "skills": ["ios-review", "kotlin-review"]
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
| `plugins` | array | yes | Array of plugin results. |
| `count` | number | no | Total number of results returned. |
| `duration_ms` | number | no | Time taken to execute the search in milliseconds. |

**Plugin fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Plugin name (the `@<name>` used in `plugin install`). |
| `description` | string | no | Human-readable description. |
| `source` | string | yes | Repository source in `{org}/{repo}` format. |
| `version` | string \| null | no | Plugin version from `plugin.yaml`, if any. |
| `installs` | number | yes | Install count. Use `0` if not tracked. |
| `skills` | array | no | Member skill names bundled by the plugin. |

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
