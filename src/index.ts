/**
 * OpenClaw Deep Memory Plugin
 *
 * Provides persistent curated memory (MEMORY.md / USER.md) via the memory tool.
 * Source: matching bundled plugin firecrawl tool pattern
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { MemoryStore } from './memory/memory-store.js';
import { BuiltinMemoryProvider } from './memory/builtin-memory-provider.js';
import { SessionIndexer } from './memory/session-indexer.js';
import { initMemoryTool, memoryTool } from './tools/memory-tool-schema.js';
import { initRecallTool, recallMemoryTool } from './tools/recall-memory-schema.js';

export const VERSION = '0.1.0';

// Module-level store and provider instances
let memoryStore: MemoryStore | null = null;
let memoryProvider: BuiltinMemoryProvider | null = null;
let sessionIndexer: SessionIndexer | null = null;

/**
 * Get the memory store instance (for testing/internal use)
 */
export function getMemoryStore(): MemoryStore | null {
  return memoryStore;
}

/**
 * Get the memory provider instance (for testing/internal use)
 */
export function getMemoryProvider(): BuiltinMemoryProvider | null {
  return memoryProvider;
}

/**
 * Main plugin registration function
 */
async function register(api: OpenClawPluginApi): Promise<void> {
  const { logger } = api;

  logger.info(`[deep-memory] Initializing deep-memory plugin v${VERSION}`);

  // Initialize memory store
  memoryStore = new MemoryStore();

  // Initialize memory provider (memory enabled, user profile enabled)
  memoryProvider = new BuiltinMemoryProvider(memoryStore, true, true);
  await memoryProvider.initialize({ sessionId: 'startup' });

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

  // TODO: Expose system prompt block for prefetch injection
  // Check for api.addSystemPromptBlock() or similar in OpenClaw SDK
  // If available: api.addSystemPromptBlock(memoryProvider.systemPromptBlock());

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
