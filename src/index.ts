/**
 * OpenClaw Deep Memory Plugin
 *
 * Provides persistent curated memory (MEMORY.md / USER.md) via the memory tool.
 * Source: matching bundled plugin firecrawl tool pattern
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { MemoryStore } from './memory/memory-store.js';
import { SessionIndexer } from './memory/session-indexer.js';
import { initMemoryTool, memoryTool } from './tools/memory-tool-schema.js';
import { initRecallTool, recallMemoryTool } from './tools/recall-memory-schema.js';
import { MemoryDistiller } from './memory/memory-distiller.js';

export const VERSION = '0.1.0';

// Module-level store and provider instances
let memoryStore: MemoryStore | null = null;
let sessionIndexer: SessionIndexer | null = null;
let memoryDistiller: MemoryDistiller | null = null;

/**
 * Get the memory store instance (for testing/internal use)
 */
export function getMemoryStore(): MemoryStore | null {
  return memoryStore;
}

/**
 * Main plugin registration function
 */
async function register(api: OpenClawPluginApi): Promise<void> {
  const { logger } = api;

  logger.info(`[deep-memory] Initializing deep-memory plugin v${VERSION}`);

  // Initialize memory store
  memoryStore = new MemoryStore();

  // Initialize the memory tool with the store
  initMemoryTool(memoryStore);

  // Register the memory tool
  logger.info('[deep-memory] Registering memory tool');
  api.registerTool(memoryTool);

  // Initialize session indexer for recall_memory tool
  logger.info('[deep-memory] Initializing session indexer');
  sessionIndexer = new SessionIndexer();
  sessionIndexer.initialize();

  // Index last 7 days on startup (non-blocking)
  sessionIndexer.index(7).catch((err) => {
    logger.warn(`[deep-memory] Background indexing error: ${err}`);
  });

  // Initialize and register the recall memory tool
  initRecallTool(sessionIndexer);
  logger.info('[deep-memory] Registering recall_memory tool');
  api.registerTool(recallMemoryTool);

  // Initialize memory distiller and wire to session_end hook
  memoryDistiller = new MemoryDistiller(memoryStore, sessionIndexer);

  api.on('session_end', async (_event, _ctx) => {
    if (!memoryDistiller || !sessionIndexer) return;
    try {
      // Re-index to pick up the session that just ended, then distill
      await sessionIndexer.index(1); // last 1 day
      const sessions = sessionIndexer.getSessions(1);
      if (sessions.length > 0) {
        // Distill the most recent session
        const latest = sessions[sessions.length - 1];
        await memoryDistiller.distillSession(latest.id);
      }
    } catch (err) {
      logger.warn(`[deep-memory] session_end distillation failed: ${err}`);
    }
  });

  logger.info('[deep-memory] Plugin registration complete');
}

/**
 * Plugin export
 */
export default definePluginEntry({
  id: 'deep-memory',
  name: 'Deep Memory',
  description: 'Persistent curated memory (MEMORY.md / USER.md) for OpenClaw agents',
  register,
});
