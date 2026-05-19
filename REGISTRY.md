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
  "skills": [
    {
      "id": "vercel-labs/skills/find-skills",
      "skillId": "find-skills",
      "name": "find-skills",
      "installs": 1591220,
      "source": "vercel-labs/skills"
    }
  ]
}
```

**Fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Canonical identifier for the skill. Recommended format: `{source}/{name}` (e.g. `vercel-labs/skills/find-skills`). Used as the URL path for the detail page. |
| `skillId` | string | no | Short skill name slug (e.g. `find-skills`). When present, the CLI uses this as the URL slug in preference to `id`. Self-hosted registries may set this to a different value than `name` (e.g. a full path slug). |
| `name` | string | yes | Display name of the skill. |
| `installs` | number | yes | Install count. Use `0` if not tracked. |
| `source` | string | yes | Repository source in `{org}/{repo}` format. |

### `GET /{id}`

Returns detail for a single skill. The `id` value from a search result is used as the path.

**Response**: the full skill record. Shape is registry-defined; the CLI does not currently consume this endpoint directly but links to it in terminal output.

## Self-hosting

Point the CLI at your registry by setting `SKILLS_API_URL`:

```bash
SKILLS_API_URL=https://skills.example.com npx skills find <query>
```

Both the search API calls and rendered detail URLs in terminal output will use this base URL.
