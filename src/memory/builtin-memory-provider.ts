import { MemoryProvider, Message, ToolSchema, SessionOpts } from './memory-provider.js';
import { MemoryStore } from './memory-store.js';

/**
 * BuiltinMemoryProvider — wraps MEMORY.md / USER.md as a MemoryProvider.
 *
 * Always registered as the first provider. Cannot be disabled or removed.
 * This is the existing Hermes memory system exposed through the provider
 * interface for compatibility with the MemoryManager.
 *
 * The actual storage logic lives in MemoryStore (memory-store.ts).
 * This provider is a thin adapter that delegates to MemoryStore and
 * exposes the memory tool schema.
 */
export class BuiltinMemoryProvider extends MemoryProvider {
  private _store: MemoryStore | undefined;
  private _memoryEnabled: boolean;
  private _userProfileEnabled: boolean;

  constructor(
    store?: MemoryStore,
    memoryEnabled?: boolean,
    userProfileEnabled?: boolean
  ) {
    super();
    this._store = store;
    this._memoryEnabled = memoryEnabled ?? false;
    this._userProfileEnabled = userProfileEnabled ?? false;
  }

  /**
   * Short identifier for this provider.
   */
  get name(): string {
    return 'builtin';
  }

  /**
   * Built-in memory is always available.
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Load memory from disk if not already loaded.
   */
  async initialize(opts: SessionOpts): Promise<void> {
    if (this._store !== undefined) {
      await this._store.loadFromDisk();
    }
  }

  /**
   * Return MEMORY.md and USER.md content for the system prompt.
   *
   * Uses the frozen snapshot captured at load time. This ensures the
   * system prompt stays stable throughout a session (preserving the
   * prompt cache), even though the live entries may change via tool calls.
   */
  systemPromptBlock(): string {
    if (!this._store) {
      return '';
    }

    const parts: string[] = [];
    if (this._memoryEnabled) {
      const memBlock = this._store.formatForSystemPrompt('memory');
      if (memBlock) {
        parts.push(memBlock);
      }
    }
    if (this._userProfileEnabled) {
      const userBlock = this._store.formatForSystemPrompt('user');
      if (userBlock) {
        parts.push(userBlock);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Built-in memory doesn't do query-based recall — it's injected via systemPromptBlock.
   */
  async prefetch(query: string, sessionId?: string): Promise<string> {
    return '';
  }

  /**
   * Built-in memory doesn't auto-sync turns — writes happen via the memory tool.
   */
  async syncTurn(userContent: string, assistantContent: string, sessionId?: string): Promise<void> {
    // no-op
  }

  /**
   * Return empty list.
   *
   * The `memory` tool is an agent-level intercepted tool, handled
   * specially in run_agent.py before normal tool dispatch. It's not
   * part of the standard tool registry. We don't duplicate it here.
   */
  getToolSchemas(): ToolSchema[] {
    return [];
  }

  /**
   * Not used — the memory tool is intercepted in run_agent.py.
   */
  async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
    return JSON.stringify({ error: 'Built-in memory tool is handled by the agent loop' });
  }

  /**
   * No cleanup needed — files are saved on every write.
   */
  async shutdown(): Promise<void> {
    // no-op
  }

  // -- Property accessors for backward compatibility --------------------------

  /**
   * Access the underlying MemoryStore for legacy code paths.
   */
  get store(): MemoryStore | undefined {
    return this._store;
  }

  get memoryEnabled(): boolean {
    return this._memoryEnabled;
  }

  get userProfileEnabled(): boolean {
    return this._userProfileEnabled;
  }
}
