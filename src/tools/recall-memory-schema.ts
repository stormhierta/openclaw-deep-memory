/**
 * Recall Memory Tool Schema
 *
 * Tool registration for recalling past session history via the session indexer.
 * Source: matching bundled plugin firecrawl tool pattern
 */

import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import { SessionIndexer } from '../memory/session-indexer.js';

let _indexer: SessionIndexer | null = null;

export function initRecallTool(indexer: SessionIndexer): void {
  _indexer = indexer;
}

/**
 * Tool registration object for recall_memory
 * Source: matching bundled plugin firecrawl tool pattern
 */
export const recallMemoryTool = {
  name: 'recall_memory',
  label: 'Recall Memory',
  description: `Search past session history for relevant context. Use when you need to recall what happened in previous sessions, what was discussed before, or find specific past information.

Returns snippets from indexed past sessions matching your query. Results include the conversation context and timestamps.

Use this proactively when: a user references something from a previous session, you need context about a past project or discussion, or you want to avoid repeating work already done.`,

  parameters: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'What to search for in past sessions.',
      },
      limit: {
        type: 'number' as const,
        description: 'Max results to return (default 5, max 20).',
      },
    },
    required: ['query'],
  },

  async execute(_toolCallId: string, params: Record<string, unknown>) {
    if (!_indexer) {
      return jsonResult({ success: false, error: 'Session indexer not initialized.' });
    }

    const query = params.query as string;
    const limit = Math.min(20, (params.limit as number) || 5);

    if (!query?.trim()) {
      return jsonResult({ success: false, error: 'query is required.' });
    }

    try {
      const results = _indexer.search(query, limit);
      if (results.length === 0) {
        const sessionCount = _indexer.getSessionCount();
        if (sessionCount === 0) {
          return jsonResult({
            success: true,
            results: [],
            message: 'No sessions indexed yet. Sessions are indexed automatically on startup and after each session ends. If this is a first run, sessions will be available after the next session completes.'
          });
        }
        return jsonResult({ success: true, results: [], message: 'No matching sessions found.' });
      }
      return jsonResult({ success: true, results, count: results.length });
    } catch (err) {
      return jsonResult({ success: false, error: String(err) });
    }
  },
};
