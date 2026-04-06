# openclaw-deep-memory

Persistent curated memory, cross-session full-text recall, and automatic session distillation for OpenClaw agents.

## What this plugin adds vs. what OpenClaw already does

OpenClaw **natively injects `MEMORY.md` and `USER.md`** into the system prompt via its workspace bootstrap on every session start. The plugin's built-in memory provider (which mirrors this same content into the system prompt) is therefore redundant for primary sessions — it was built before this native behaviour was fully understood.

The **real unique value** of this plugin is:

1. **`recall_memory` tool** — FTS5 full-text search across every past session's `.jsonl` file, so the agent can search conversation history going back as far as sessions exist.
2. **`memory` tool** — programmatic add / replace / remove / read on `MEMORY.md` and `USER.md` entries, with atomic writes, injection scanning, and character-budget enforcement.
3. **Auto-distillation** — on `session_end`, calls local Gemma (via Ollama) to automatically extract noteworthy facts from the just-completed session and append them to `MEMORY.md` / `USER.md`.

---

## Features

### `memory` tool
Programmatic read/write access to `MEMORY.md` and `USER.md` entries.

| Action   | Description                                                      |
|----------|------------------------------------------------------------------|
| `add`    | Append a new entry (rejects duplicates; enforces char budget)   |
| `replace`| Find entry by substring match, replace with new content          |
| `remove` | Find entry by substring match, delete it                         |
| `read`   | Return all current entries + usage stats                         |

**Injection scanning:** all content is scanned for prompt-injection and exfiltration patterns before being accepted. Entries containing invisible unicode, role-hijack phrases, or secret-exfiltrating `curl`/`wget` calls are rejected.

**Atomic writes:** every mutation uses a temp-file + `fsync` + atomic rename to prevent data loss on crash or concurrent writes.

**Char budgets:** `memory` target: ~2,200 chars; `user` target: ~1,375 chars. Budget usage is returned on every response.

### `recall_memory` tool
Full-text search across all indexed session history. Powered by SQLite FTS5 with Porter stemming and Unicode 61 tokenisation.

- Indexes `~/.openclaw/agents/main/sessions/*.jsonl` on startup and after each `session_end`.
- Returns ranked snippets with `<b>` highlighting.
- Only indexed sessions are searchable; sessions accumulate automatically.

### Auto-distillation
On every `session_end` hook:

1. Re-indexes the last day's sessions (picks up the session that just ended).
2. Loads the session's messages (requires ≥ 5 messages to bother).
3. Calls local **Gemma** (`gemma4-e2b-local:latest`) via Ollama (`localhost:11434`) twice:
   - **Memory extraction** — asks Gemma what environment/project/tool facts are worth remembering long-term. Up to 3 entries, each ≤ 150 chars.
   - **User profile extraction** — asks Gemma what was learned about the user's preferences, style, or habits. Up to 2 entries, each ≤ 120 chars.
4. Each extracted entry is passed through `memory add` (deduplication and char-budget checks apply).

---

## Installation

```bash
# From the plugin directory
cd /home/stormhierta/.openclaw/workspace/openclaw-deep-memory
npm install
npm run build

# Register with OpenClaw (one-time)
openclaw plugins add ./dist/index.js
openclaw gateway restart
```

Or reference the built dist directly in your OpenClaw plugins config:

```json
{
  "plugins": {
    "entries": [
      {
        "id": "deep-memory",
        "path": "/home/stormhierta/.openclaw/workspace/openclaw-deep-memory/dist/index.js"
      }
    ]
  }
}
```

---

## Configuration

The plugin respects the `plugins.entries[].config` field in your OpenClaw config. The only supported option is:

| Key      | Type    | Default | Description                         |
|----------|---------|---------|-------------------------------------|
| `enabled`| boolean | `true`  | Whether the plugin is active        |

```json
{
  "plugins": {
    "entries": [
      {
        "id": "deep-memory",
        "path": "/home/stormhierta/.openclaw/workspace/openclaw-deep-memory/dist/index.js",
        "config": {
          "enabled": true
        }
      }
    ]
  }
}
```

No other configuration is required. The plugin auto-discovers the sessions directory and Ollama endpoint.

---

## Tools

### `memory`

```json
{
  "name": "memory",
  "action": "add | replace | remove | read",
  "target": "memory | user",
  "content": "...",
  "old_text": "..."
}
```

**Add an entry:**
```
memory(action="add", target="memory", content="User prefers Swedish keyboard layout on Linux")
```

**Replace an entry (identify by unique substring):**
```
memory(action="replace", target="memory", old_text="old substring", content="updated content")
```

**Remove an entry:**
```
memory(action="remove", target="memory", old_text="entry to delete")
```

**Read current state:**
```
memory(action="read", target="memory")
```

### `recall_memory`

```json
{
  "name": "recall_memory",
  "query": "what was said about the database migration",
  "limit": 5
}
```

**Example:**
```
recall_memory(query="SSH tunnel setup", limit=10)
```

Returns:
```json
{
  "success": true,
  "results": [
    {
      "sessionId": "2026-04-05-abc123",
      "role": "assistant",
      "content": "Here's the SSH tunnel command we settled on...",
      "timestamp": "2026-04-05T14:22:31.000Z",
      "snippet": "...<b>SSH tunnel</b> command we settled on was <b>ssh</b> -L 5433..."
    }
  ],
  "count": 1
}
```

---

## Auto-distillation

**When does it fire?**
On every `session_end` event (CLI exit, `/reset`, gateway session expiry). The most recent session is re-indexed and distilled automatically — no manual trigger needed.

**What model does it use?**
`gemma4-e2b-local:latest` via a local Ollama daemon at `http://localhost:11434`. No API key or external service required.

**How much does it write?**
At most 3 memory entries + 2 user-profile entries per session (duplicates and budget-exceeding writes are silently skipped).

**Requirements:**
- Ollama running locally with `gemma4-e2b-local:latest` pulled
- Session must have ≥ 5 messages to qualify for distillation

If Ollama is unavailable or the model is not present, distillation fails silently (logged as a warning) and does not block session cleanup.

---

## Requirements

| Requirement | Details |
|-------------|---------|
| Node.js | ≥ 18 (plugin host) |
| TypeScript | ≥ 5.4 (build only) |
| Ollama | Running locally, port 11434 |
| Ollama model | `gemma4-e2b-local:latest` |
| OpenClaw | Any recent version with plugin system |

---

## File layout

```
openclaw-deep-memory/
├── src/
│   ├── index.ts                          # Plugin entry, hook wiring
│   ├── memory/
│   │   ├── memory-store.ts               # MEMORY.md/USER.md read/write/scan
│   │   ├── session-indexer.ts            # JSONL → SQLite FTS5 indexer
│   │   ├── memory-distiller.ts           # Ollama/Gemma session distillation
│   │   └── memory-provider.ts            # Abstract MemoryProvider base class
│   └── tools/
│       ├── memory-tool-schema.ts         # memory tool registration
│       └── recall-memory-schema.ts       # recall_memory tool registration
├── openclaw.plugin.json                  # Plugin manifest
└── package.json                          # Version 0.1.0
```

---

## Known limitations

- **`llm_output` hook only captures assistant text.** The `before_prompt_build` and `llm_output` hooks do not have access to the full message history at arbitrary points in the conversation; they are used primarily for distillation and pre-compression insight extraction.
- **FTS index is per-machine.** The SQLite index at `~/.openclaw/deep-memory/session-index.db` lives on the machine running OpenClaw. Sessions on other machines are not searched.
- **Distillation is best-effort.** If Ollama is slow or unavailable, distillation silently skips. There is no retry queue.
