/**
 * Abstract base class for pluggable memory providers.
 *
 * Memory providers give the agent persistent recall across sessions. One
 * external provider is active at a time alongside the always-on built-in
 * memory (MEMORY.md / USER.md). The MemoryManager enforces this limit.
 *
 * Built-in memory is always active as the first provider and cannot be removed.
 * External providers (Honcho, Hindsight, Mem0, etc.) are additive — they never
 * disable the built-in store. Only one external provider runs at a time to
 * prevent tool schema bloat and conflicting memory backends.
 *
 * Registration:
 *   1. Built-in: BuiltinMemoryProvider — always present, not removable.
 *   2. Plugins: Ship in plugins/memory/<name>/, activated by memory.provider config.
 *
 * Lifecycle (called by MemoryManager, wired in run_agent.py):
 *   initialize()          — connect, create resources, warm up
 *   system_prompt_block()  — static text for the system prompt
 *   prefetch(query)        — background recall before each turn
 *   sync_turn(user, asst)  — async write after each turn
 *   get_tool_schemas()     — tool schemas to expose to the model
 *   handle_tool_call()     — dispatch a tool call
 *   shutdown()             — clean exit
 *
 * Optional hooks (override to opt in):
 *   on_turn_start(turn, message, kwargs) — per-turn tick with runtime context
 *   on_session_end(messages)               — end-of-session extraction
 *   on_pre_compress(messages) -> str       — extract before context compression
 *   on_memory_write(action, target, content) — mirror built-in memory writes
 *   on_delegation(task, result, childSessionId)  — parent-side observation of subagent work
 */

export interface Message {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SessionOpts {
  sessionId: string;
  openclawHome?: string;
  platform?: string;
  agentContext?: 'primary' | 'subagent' | 'cron' | 'flush';
  agentIdentity?: string;
  agentWorkspace?: string;
  parentSessionId?: string;
  userId?: string;
}

/**
 * Config field definition for provider setup.
 *
 * Used by 'openclaw memory setup' to walk the user through configuration.
 */
export interface ConfigField {
  /** Config key name (e.g. 'api_key', 'mode') */
  key: string;
  /** Human-readable description */
  description: string;
  /** True if this should go to .env (default: false) */
  secret?: boolean;
  /** True if required (default: false) */
  required?: boolean;
  /** Default value (optional) */
  default?: unknown;
  /** List of valid values (optional) */
  choices?: unknown[];
  /** URL where user can get this credential (optional) */
  url?: string;
  /** Explicit env var name for secrets (default: auto-generated) */
  envVar?: string;
}

/**
 * Abstract base class for memory providers.
 */
export abstract class MemoryProvider {
  /**
   * Short identifier for this provider (e.g. 'builtin', 'honcho', 'hindsight').
   */
  abstract get name(): string;

  // -- Core lifecycle (implement these) ------------------------------------

  /**
   * Return true if this provider is configured, has credentials, and is ready.
   *
   * Called during agent init to decide whether to activate the provider.
   * Should not make network calls — just check config and installed deps.
   */
  abstract isAvailable(): boolean;

  /**
   * Initialize for a session.
   *
   * Called once at agent startup. May create resources (banks, tables),
   * establish connections, start background threads, etc.
   *
   * opts always include:
   *   - sessionId (string): The session identifier.
   *   - openclawHome (string): The active OPENCLAW_HOME directory path. Use this
   *     for profile-scoped storage instead of hardcoding `~/.openclaw`.
   *   - platform (string): "cli", "telegram", "discord", "cron", etc.
   *
   * opts may also include:
   *   - agentContext (string): "primary", "subagent", "cron", or "flush".
   *     Providers should skip writes for non-primary contexts (cron system
   *     prompts would corrupt user representations).
   *   - agentIdentity (string): Profile name (e.g. "coder"). Use for
   *     per-profile provider identity scoping.
   *   - agentWorkspace (string): Shared workspace name (e.g. "openclaw").
   *   - parentSessionId (string): For subagents, the parent's sessionId.
   *   - userId (string): Platform user identifier (gateway sessions).
   */
  abstract initialize(opts: SessionOpts): Promise<void>;

  /**
   * Return text to include in the system prompt.
   *
   * Called during system prompt assembly. Return empty string to skip.
   * This is for STATIC provider info (instructions, status). Prefetched
   * recall context is injected separately via prefetch().
   */
  systemPromptBlock(): string {
    return '';
  }

  /**
   * Recall relevant context for the upcoming turn.
   *
   * Called before each API call. Return formatted text to inject as
   * context, or empty string if nothing relevant. Implementations
   * should be fast — use background threads for the actual recall
   * and return cached results here.
   *
   * sessionId is provided for providers serving concurrent sessions
   * (gateway group chats, cached agents). Providers that don't need
   * per-session scoping can ignore it.
   */
  prefetch(query: string, sessionId?: string): Promise<string> {
    return Promise.resolve('');
  }

  /**
   * Queue a background recall for the NEXT turn.
   *
   * Called after each turn completes. The result will be consumed
   * by prefetch() on the next turn. Default is no-op — providers
   * that do background prefetching should override this.
   */
  queuePrefetch(query: string, sessionId?: string): void {
    // no-op
  }

  /**
   * Persist a completed turn to the backend.
   *
   * Called after each turn. Should be non-blocking — queue for
   * background processing if the backend has latency.
   */
  syncTurn(userContent: string, assistantContent: string, sessionId?: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Return tool schemas this provider exposes.
   *
   * Each schema follows the OpenAI function calling format:
   * {name: "...", description: "...", parameters: {...}}
   *
   * Return empty list if this provider has no tools (context-only).
   */
  abstract getToolSchemas(): ToolSchema[];

  /**
   * Handle a tool call for one of this provider's tools.
   *
   * Must return a string (the tool result).
   * Only called for tool names returned by getToolSchemas().
   */
  handleToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
    throw new Error(`Provider ${this.name} does not handle tool ${toolName}`);
  }

  /**
   * Clean shutdown — flush queues, close connections.
   */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  // -- Optional hooks (override to opt in) ---------------------------------

  /**
   * Called at the start of each turn with the user message.
   *
   * Use for turn-counting, scope management, periodic maintenance.
   *
   * kwargs may include: remainingTokens, model, platform, toolCount.
   * Providers use what they need; extras are ignored.
   */
  onTurnStart(turnNumber: number, message: string, kwargs?: Record<string, unknown>): void {
    // no-op
  }

  /**
   * Called when a session ends (explicit exit or timeout).
   *
   * Use for end-of-session fact extraction, summarization, etc.
   * messages is the full conversation history.
   *
   * NOT called after every turn — only at actual session boundaries
   * (CLI exit, /reset, gateway session expiry).
   */
  onSessionEnd(messages: Message[]): void {
    // no-op
  }

  /**
   * Called before context compression discards old messages.
   *
   * Use to extract insights from messages about to be compressed.
   * messages is the list that will be summarized/discarded.
   *
   * Return text to include in the compression summary prompt so the
   * compressor preserves provider-extracted insights. Return empty
   * string for no contribution (backwards-compatible default).
   */
  onPreCompress(messages: Message[]): string {
    return '';
  }

  /**
   * Called on the PARENT agent when a subagent completes.
   *
   * The parent's memory provider gets the task+result pair as an
   * observation of what was delegated and what came back. The subagent
   * itself has no provider session (skipMemory=true).
   *
   * task: the delegation prompt
   * result: the subagent's final response
   * childSessionId: the subagent's sessionId
   */
  onDelegation(task: string, result: string, childSessionId?: string): void {
    // no-op
  }

  /**
   * Return config fields this provider needs for setup.
   *
   * Used by 'openclaw memory setup' to walk the user through configuration.
   * Each field is a dict with:
   *   key:         config key name (e.g. 'api_key', 'mode')
   *   description: human-readable description
   *   secret:      true if this should go to .env (default: false)
   *   required:    true if required (default: false)
   *   default:     default value (optional)
   *   choices:     list of valid values (optional)
   *   url:         URL where user can get this credential (optional)
   *   envVar:      explicit env var name for secrets (default: auto-generated)
   *
   * Return empty list if no config needed (e.g. local-only providers).
   */
  getConfigSchema(): ConfigField[] {
    return [];
  }

  /**
   * Write non-secret config to the provider's native location.
   *
   * Called by 'openclaw memory setup' after collecting user inputs.
   * `values` contains only non-secret fields (secrets go to .env).
   * `openclawHome` is the active OPENCLAW_HOME directory path.
   *
   * Providers with native config files (JSON, YAML) should override
   * this to write to their expected location. Providers that use only
   * env vars can leave the default (no-op).
   *
   * All new memory provider plugins MUST implement either:
   * - saveConfig() for native config file formats, OR
   * - use only env vars (in which case getConfigSchema() fields
   *   should all have `envVar` set and this method stays no-op).
   */
  saveConfig(values: Record<string, unknown>, openclawHome: string): void {
    // no-op
  }

  /**
   * Called when the built-in memory tool writes an entry.
   *
   * action: 'add', 'replace', or 'remove'
   * target: 'memory' or 'user'
   * content: the entry content
   *
   * Use to mirror built-in memory writes to your backend.
   */
  onMemoryWrite(action: string, target: string, content: string): void {
    // no-op
  }
}
