/**
 * Memory Tool Schema
 *
 * Tool registration for memory following OpenClaw plugin pattern.
 * Source: matching bundled plugin firecrawl tool pattern
 */

import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import { MemoryStore } from '../memory/memory-store.js';

// Module-level shared store instance — initialized once
let _store: MemoryStore | null = null;

export function initMemoryTool(store: MemoryStore): void {
  _store = store;
}

/**
 * Tool registration object for memory
 * Source: matching bundled plugin firecrawl tool pattern
 * Description copied from Hermes MEMORY_SCHEMA
 */
export const memoryTool = {
  name: 'memory',
  label: 'Memory',
  description: `Save durable information to persistent memory that survives across sessions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says 'remember this' / 'don't do that again'
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge. The most valuable memory prevents the user from having to repeat themselves.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory; use session_search to recall those from past transcripts.
If you've discovered a new way to do something, solved a problem that could be necessary later, save it as a skill with the skill tool.

TWO TARGETS:
- 'user': who the user is -- name, role, preferences, communication style, pet peeves
- 'memory': your notes -- environment facts, project conventions, tool quirks, lessons learned

ACTIONS: add (new entry), replace (update existing -- old_text identifies it), remove (delete -- old_text identifies it), read (view current entries).

SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.`,

  parameters: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string' as const,
        enum: ['add', 'replace', 'remove', 'read'],
        description: 'The action to perform.',
      },
      target: {
        type: 'string' as const,
        enum: ['memory', 'user'],
        description: "Which memory store: 'memory' for personal notes, 'user' for user profile.",
      },
      content: {
        type: 'string' as const,
        description: "The entry content. Required for 'add' and 'replace'.",
      },
      old_text: {
        type: 'string' as const,
        description: 'Short unique substring identifying the entry to replace or remove.',
      },
    },
    required: ['action', 'target'],
  },

  async execute(_toolCallId: string, params: Record<string, unknown>) {
    if (!_store) {
      return jsonResult({ success: false, error: 'Memory store not initialized.' });
    }

    const { action, target, content, old_text } = params as {
      action: string;
      target: string;
      content?: string;
      old_text?: string;
    };

    if (target !== 'memory' && target !== 'user') {
      return jsonResult({ success: false, error: `Invalid target '${target}'. Use 'memory' or 'user'.` });
    }

    let result: unknown;

    if (action === 'add') {
      if (!content) {
        return jsonResult({ success: false, error: "content is required for 'add'." });
      }
      result = await _store.add(target, content);
    } else if (action === 'replace') {
      if (!old_text) {
        return jsonResult({ success: false, error: "old_text is required for 'replace'." });
      }
      if (!content) {
        return jsonResult({ success: false, error: "content is required for 'replace'." });
      }
      result = await _store.replace(target, old_text, content);
    } else if (action === 'remove') {
      if (!old_text) {
        return jsonResult({ success: false, error: "old_text is required for 'remove'." });
      }
      result = await _store.remove(target, old_text);
    } else if (action === 'read') {
      result = _store.read(target);
    } else {
      result = { success: false, error: `Unknown action '${action}'. Use: add, replace, remove, read` };
    }

    return jsonResult(result);
  },
};
