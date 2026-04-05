import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { open, close as closeFd, rename } from 'node:fs';

const ENTRY_DELIMITER = '\n§\n';
const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;

const MEMORY_PATH = join(homedir(), 'inherit', 'MEMORY.md');
const USER_PATH = join(homedir(), 'inherit', 'USER.md');

// ---------------------------------------------------------------------------
// Memory content scanning — lightweight check for injection/exfiltration
// in content that gets injected into the system prompt.
// ---------------------------------------------------------------------------

const _MEMORY_THREAT_PATTERNS: Array<[RegExp, string]> = [
  // Prompt injection
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  // Exfiltration via curl/wget with secrets
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  // Persistence via shell rc
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|\~\/\.ssh/i, "ssh_access"],
  [/\$HOME\/\.openclaw\/\.env|\~\/\.openclaw\/\.env/i, "openclaw_env"],
];

// Subset of invisible chars for injection detection
const _INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

function _scan_memory_content(content: string): string | null {
  /** Scan memory content for injection/exfil patterns. Returns error string if blocked. */
  // Check invisible unicode
  for (const char of _INVISIBLE_CHARS) {
    if (content.includes(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} (possible injection).`;
    }
  }

  // Check threat patterns
  for (const [pattern, pid] of _MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${pid}'. Memory entries are injected into the system prompt and must not contain injection or exfiltration payloads.`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

interface MemoryResponse {
  success: boolean;
  error?: string;
  message?: string;
  target?: string;
  entries?: string[];
  usage?: string;
  entry_count?: number;
  matches?: string[];
}

// ---------------------------------------------------------------------------
// MemoryStore class
// ---------------------------------------------------------------------------

export class MemoryStore {
  private memory_entries: string[] = [];
  private user_entries: string[] = [];
  private memory_char_limit: number;
  private user_char_limit: number;
  // Frozen snapshot for system prompt -- set once at load_from_disk()
  private _system_prompt_snapshot: { memory: string; user: string } = { memory: '', user: '' };
  
  // Simple in-process async lock per file path
  private _fileLocks: Map<string, Promise<void>> = new Map();

  constructor(memory_char_limit: number = MEMORY_CHAR_LIMIT, user_char_limit: number = USER_CHAR_LIMIT) {
    this.memory_char_limit = memory_char_limit;
    this.user_char_limit = user_char_limit;
  }

  async loadFromDisk(): Promise<void> {
    /** Load entries from MEMORY.md and USER.md, capture system prompt snapshot. */
    // Ensure parent directories exist
    await mkdir(join(homedir(), 'inherit'), { recursive: true });

    this.memory_entries = await this._readFile(MEMORY_PATH);
    this.user_entries = await this._readFile(USER_PATH);

    // Deduplicate entries (preserves order, keeps first occurrence)
    this.memory_entries = [...new Set(this.memory_entries)];
    this.user_entries = [...new Set(this.user_entries)];

    // Capture frozen snapshot for system prompt injection
    this._system_prompt_snapshot = {
      memory: this._renderBlock('memory', this.memory_entries),
      user: this._renderBlock('user', this.user_entries),
    };
  }

  private async _acquireLock(path: string): Promise<() => void> {
    /** Acquire an async lock for the given file path. Returns release function. */
    const previousLock = this._fileLocks.get(path);
    
    // Create a new lock promise that waits for the previous one
    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = () => {
        this._fileLocks.delete(path);
        resolve();
      };
    });
    
    // Store the new lock
    this._fileLocks.set(path, newLock);
    
    // Wait for previous lock to release
    if (previousLock) {
      await previousLock;
    }
    
    return releaseLock!;
  }

  private _pathFor(target: string): string {
    if (target === 'user') {
      return USER_PATH;
    }
    return MEMORY_PATH;
  }

  private async _reloadTarget(target: string): Promise<void> {
    /** Re-read entries from disk into in-memory state. Called under lock. */
    const fresh = await this._readFile(this._pathFor(target));
    this._setEntries(target, [...new Set(fresh)]); // deduplicate
  }

  private async _saveToDisk(target: string): Promise<void> {
    /** Persist entries to the appropriate file. Called after every mutation. */
    await mkdir(join(homedir(), 'inherit'), { recursive: true });
    await this._writeFile(this._pathFor(target), this._entriesFor(target));
  }

  private _entriesFor(target: string): string[] {
    if (target === 'user') {
      return this.user_entries;
    }
    return this.memory_entries;
  }

  private _setEntries(target: string, entries: string[]): void {
    if (target === 'user') {
      this.user_entries = entries;
    } else {
      this.memory_entries = entries;
    }
  }

  private _charCount(target: string): number {
    const entries = this._entriesFor(target);
    if (!entries.length) {
      return 0;
    }
    return ENTRY_DELIMITER.length * (entries.length - 1) + entries.reduce((sum, e) => sum + e.length, 0);
  }

  private _charLimit(target: string): number {
    if (target === 'user') {
      return this.user_char_limit;
    }
    return this.memory_char_limit;
  }

  async add(target: string, content: string): Promise<MemoryResponse> {
    /** Append a new entry. Returns error if it would exceed the char limit. */
    content = content.trim();
    if (!content) {
      return { success: false, error: "Content cannot be empty." };
    }

    // Scan for injection/exfiltration before accepting
    const scan_error = _scan_memory_content(content);
    if (scan_error) {
      return { success: false, error: scan_error };
    }

    const release = await this._acquireLock(this._pathFor(target));
    try {
      // Re-read from disk under lock to pick up writes from other sessions
      await this._reloadTarget(target);

      const entries = this._entriesFor(target);
      const limit = this._charLimit(target);

      // Reject exact duplicates
      if (entries.includes(content)) {
        return this._successResponse(target, "Entry already exists (no duplicate added).");
      }

      // Calculate what the new total would be
      const new_entries = [...entries, content];
      const new_total = new_entries.length > 1 
        ? new_entries.reduce((sum, e) => sum + e.length, 0) + ENTRY_DELIMITER.length * (new_entries.length - 1)
        : new_entries[0]?.length || 0;

      if (new_total > limit) {
        const current = this._charCount(target);
        return {
          success: false,
          error: (
            `Memory at ${current.toLocaleString()}/${limit.toLocaleString()} chars. ` +
            `Adding this entry (${content.length} chars) would exceed the limit. ` +
            `Replace or remove existing entries first.`
          ),
          entries,
          usage: `${current.toLocaleString()}/${limit.toLocaleString()}`,
        };
      }

      entries.push(content);
      this._setEntries(target, entries);
      await this._saveToDisk(target);

      return this._successResponse(target, "Entry added.");
    } finally {
      release();
    }
  }

  async replace(target: string, old_text: string, new_content: string): Promise<MemoryResponse> {
    /** Find entry containing old_text substring, replace it with new_content. */
    old_text = old_text.trim();
    new_content = new_content.trim();
    if (!old_text) {
      return { success: false, error: "old_text cannot be empty." };
    }
    if (!new_content) {
      return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };
    }

    // Scan replacement content for injection/exfiltration
    const scan_error = _scan_memory_content(new_content);
    if (scan_error) {
      return { success: false, error: scan_error };
    }

    const release = await this._acquireLock(this._pathFor(target));
    try {
      await this._reloadTarget(target);

      const entries = this._entriesFor(target);
      const matches: Array<[number, string]> = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].includes(old_text)) {
          matches.push([i, entries[i]]);
        }
      }

      if (matches.length === 0) {
        return { success: false, error: `No entry matched '${old_text}'.` };
      }

      if (matches.length > 1) {
        // If all matches are identical (exact duplicates), operate on the first one
        const unique_texts = new Set(matches.map(([, e]) => e));
        if (unique_texts.size > 1) {
          const previews = matches.map(([, e]) => e.length > 80 ? e.slice(0, 80) + "..." : e);
          return {
            success: false,
            error: `Multiple entries matched '${old_text}'. Be more specific.`,
            matches: previews,
          };
        }
        // All identical -- safe to replace just the first
      }

      const idx = matches[0][0];
      const limit = this._charLimit(target);

      // Check that replacement doesn't blow the budget
      const test_entries = [...entries];
      test_entries[idx] = new_content;
      const new_total = test_entries.length > 1
        ? test_entries.reduce((sum, e) => sum + e.length, 0) + ENTRY_DELIMITER.length * (test_entries.length - 1)
        : test_entries[0]?.length || 0;

      if (new_total > limit) {
        return {
          success: false,
          error: (
            `Replacement would put memory at ${new_total.toLocaleString()}/${limit.toLocaleString()} chars. ` +
            `Shorten the new content or remove other entries first.`
          ),
        };
      }

      entries[idx] = new_content;
      this._setEntries(target, entries);
      await this._saveToDisk(target);

      return this._successResponse(target, "Entry replaced.");
    } finally {
      release();
    }
  }

  async remove(target: string, old_text: string): Promise<MemoryResponse> {
    /** Remove the entry containing old_text substring. */
    old_text = old_text.trim();
    if (!old_text) {
      return { success: false, error: "old_text cannot be empty." };
    }

    const release = await this._acquireLock(this._pathFor(target));
    try {
      await this._reloadTarget(target);

      const entries = this._entriesFor(target);
      const matches: Array<[number, string]> = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].includes(old_text)) {
          matches.push([i, entries[i]]);
        }
      }

      if (matches.length === 0) {
        return { success: false, error: `No entry matched '${old_text}'.` };
      }

      if (matches.length > 1) {
        // If all matches are identical (exact duplicates), remove the first one
        const unique_texts = new Set(matches.map(([, e]) => e));
        if (unique_texts.size > 1) {
          const previews = matches.map(([, e]) => e.length > 80 ? e.slice(0, 80) + "..." : e);
          return {
            success: false,
            error: `Multiple entries matched '${old_text}'. Be more specific.`,
            matches: previews,
          };
        }
        // All identical -- safe to remove just the first
      }

      const idx = matches[0][0];
      entries.splice(idx, 1);
      this._setEntries(target, entries);
      await this._saveToDisk(target);

      return this._successResponse(target, "Entry removed.");
    } finally {
      release();
    }
  }

  formatForSystemPrompt(target: string): string | null {
    /**
     * Return the frozen snapshot for system prompt injection.
     * 
     * This returns the state captured at load_from_disk() time, NOT the live
     * state. Mid-session writes do not affect this. This keeps the system
     * prompt stable across all turns, preserving the prefix cache.
     * 
     * Returns null if the snapshot is empty (no entries at load time).
     */
    const block = this._system_prompt_snapshot[target as keyof typeof this._system_prompt_snapshot] || '';
    return block || null;
  }

  read(target: string): MemoryResponse {
    /** Returns LIVE entries + usage stats (not snapshot) */
    return this._successResponse(target);
  }

  // -- Internal helpers --

  private _successResponse(target: string, message?: string): MemoryResponse {
    const entries = this._entriesFor(target);
    const current = this._charCount(target);
    const limit = this._charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;

    const resp: MemoryResponse = {
      success: true,
      target,
      entries,
      usage: `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`,
      entry_count: entries.length,
    };
    if (message) {
      resp.message = message;
    }
    return resp;
  }

  private _renderBlock(target: string, entries: string[]): string {
    /** Render a system prompt block with header and usage indicator. */
    if (!entries.length) {
      return '';
    }

    const limit = this._charLimit(target);
    const content = entries.join(ENTRY_DELIMITER);
    const current = content.length;
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;

    let header: string;
    if (target === 'user') {
      header = `USER PROFILE (who the user is) [${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars]`;
    } else {
      header = `MEMORY (your personal notes) [${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars]`;
    }

    const separator = '═'.repeat(46);
    return `${separator}\n${header}\n${separator}\n${content}`;
  }

  private async _readFile(path: string): Promise<string[]> {
    /** Read a memory file and split into entries. */
    try {
      await access(path);
    } catch {
      return [];
    }

    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return [];
    }

    if (!raw.trim()) {
      return [];
    }

    // Use ENTRY_DELIMITER for consistency with _write_file
    const entries = raw.split(ENTRY_DELIMITER).map(e => e.trim());
    return entries.filter(e => e);
  }

  private async _writeFile(path: string, entries: string[]): Promise<void> {
    /** Write entries to a memory file using atomic temp-file + rename. */
    const content = entries.length ? entries.join(ENTRY_DELIMITER) : '';
    const dir = join(homedir(), 'inherit');
    const tmpPath = join(dir, `.mem_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);

    let fd: number | null = null;
    try {
      // Open temp file for writing
      fd = await new Promise<number>((resolve, reject) => {
        open(tmpPath, 'w', (err, fd) => {
          if (err) reject(err);
          else resolve(fd);
        });
      });

      // Write content
      await new Promise<void>((resolve, reject) => {
        import('node:fs').then(fs => {
          fs.write(fd!, content, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      // Sync to disk
      await new Promise<void>((resolve, reject) => {
        import('node:fs').then(fs => {
          fs.fsync(fd!, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      // Close file descriptor
      await new Promise<void>((resolve, reject) => {
        closeFd(fd!, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      fd = null;

      // Atomic rename
      await new Promise<void>((resolve, reject) => {
        rename(tmpPath, path, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      // Clean up temp file on any failure
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(`Failed to write memory file ${path}: ${err}`);
    } finally {
      if (fd !== null) {
        try {
          await new Promise<void>((resolve, reject) => closeFd(fd!, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          }));
        } catch {
          // Ignore close errors
        }
      }
    }
  }
}
