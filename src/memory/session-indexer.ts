import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_SESSIONS_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
const DB_PATH = join(homedir(), '.openclaw', 'deep-memory', 'session-index.db');

export interface SearchResult {
  sessionId: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
}

interface MessageEntry {
  role: string;
  content: string;
  timestamp: string;
}

interface IndexState {
  session_file: string;
  indexed_at: string;
  message_count: number;
}

export class SessionIndexer {
  private db: Database.Database;
  private sessionsDir: string;

  constructor(dbPath?: string, sessionsDir?: string) {
    const targetPath = dbPath ?? DB_PATH;
    this.sessionsDir = sessionsDir ?? DEFAULT_SESSIONS_DIR;
    // Ensure parent directory exists
    const dbDir = join(targetPath, '..');
    if (!existsSync(dbDir)) {
      // Directory will be created by better-sqlite3 on open
    }
    this.db = new Database(targetPath);
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
  }

  initialize(): void {
    // Sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        message_count INTEGER DEFAULT 0,
        summary TEXT
      )
    `);

    // FTS5 virtual table for messages
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        role,
        content,
        timestamp,
        tokenize='porter unicode61'
      )
    `);

    // Index state tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_state (
        session_file TEXT PRIMARY KEY,
        indexed_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0
      )
    `);
  }

  async index(sinceDays?: number): Promise<{ indexed: number; skipped: number; errors: number }> {
    const indexed: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // Ensure sessions directory exists
    if (!existsSync(this.sessionsDir)) {
      return { indexed: 0, skipped: 0, errors: 0 };
    }

    // List all jsonl files
    const files = await readdir(this.sessionsDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.endsWith('.lock'));

    // Get already indexed files
    const indexedFiles = new Set<string>();
    const stateRows = this.db.prepare('SELECT session_file FROM index_state').all() as Array<{ session_file: string }>;
    for (const row of stateRows) {
      indexedFiles.add(row.session_file);
    }

    // Calculate cutoff date if sinceDays provided
    const cutoffTime = sinceDays !== undefined 
      ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 
      : undefined;

    for (const filename of jsonlFiles) {
      const filepath = join(this.sessionsDir, filename);

      try {
        // Check if already indexed
        if (indexedFiles.has(filename)) {
          skipped.push(filename);
          continue;
        }

        // Check modification time if sinceDays filter active
        if (cutoffTime !== undefined) {
          const stats = await stat(filepath);
          if (stats.mtimeMs < cutoffTime) {
            skipped.push(filename);
            continue;
          }
        }

        // Read and parse file
        const content = await readFile(filepath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        
        const sessionId = filename.replace(/\.jsonl$/, '');
        const messages: MessageEntry[] = [];
        let agent = 'main';
        let startedAt: string | undefined;
        let endedAt: string | undefined;

        for (const line of lines) {
          try {
            const record = JSON.parse(line);

            // Track session metadata from session_start records
            if (record.type === 'session_start') {
              if (record.agent) agent = record.agent;
              if (record.timestamp) startedAt = record.timestamp;
              continue;
            }

            // Track session end
            if (record.type === 'session_end') {
              if (record.timestamp) endedAt = record.timestamp;
              continue;
            }

            // Extract messages
            if (record.type === 'message' && record.message) {
              const msg = record.message;
              if (!msg.role || !msg.content) continue;

              // Skip tool calls and system messages we don't want
              if (msg.role === 'tool') continue;

              // Extract content text
              const textContent = this.extractContentText(msg.content);
              if (!textContent || textContent.trim().length === 0) continue;

              messages.push({
                role: msg.role,
                content: textContent,
                timestamp: msg.timestamp ?? record.timestamp ?? new Date().toISOString()
              });
            }
          } catch {
            // Skip malformed lines
            continue;
          }
        }

        // Insert session record
        const insertSession = this.db.prepare(`
          INSERT OR REPLACE INTO sessions (id, agent, started_at, ended_at, message_count, summary)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        insertSession.run(
          sessionId,
          agent,
          startedAt ?? new Date().toISOString(),
          endedAt ?? null,
          messages.length,
          null
        );

        // Insert messages into FTS
        const insertMessage = this.db.prepare(`
          INSERT INTO messages_fts (session_id, role, content, timestamp)
          VALUES (?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((msgs: MessageEntry[]) => {
          for (const msg of msgs) {
            insertMessage.run(sessionId, msg.role, msg.content, msg.timestamp);
          }
        });

        if (messages.length > 0) {
          insertMany(messages);
        }

        // Record index state
        const recordState = this.db.prepare(`
          INSERT OR REPLACE INTO index_state (session_file, indexed_at, message_count)
          VALUES (?, ?, ?)
        `);
        recordState.run(filename, new Date().toISOString(), messages.length);

        indexed.push(filename);
      } catch (err) {
        errors.push(filename);
      }
    }

    return {
      indexed: indexed.length,
      skipped: skipped.length,
      errors: errors.length
    };
  }

  search(query: string, limit = 10): SearchResult[] {
    const stmt = this.db.prepare(`
      SELECT session_id, role, content, timestamp, 
             snippet(messages_fts, 2, '<b>', '</b>', '...', 20) as snippet
      FROM messages_fts 
      WHERE messages_fts MATCH ? 
      ORDER BY rank 
      LIMIT ?
    `);

    const rows = stmt.all(query, limit) as Array<{
      session_id: string;
      role: string;
      content: string;
      timestamp: string;
      snippet: string;
    }>;

    return rows.map(row => ({
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      snippet: row.snippet
    }));
  }

  getSession(sessionId: string): Array<{ role: string; content: string; timestamp: string }> {
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM messages_fts
      WHERE session_id = ?
      ORDER BY timestamp
    `);

    return stmt.all(sessionId) as Array<{ role: string; content: string; timestamp: string }>;
  }

  getSessions(sinceDays?: number): Array<{ id: string; agent: string; startedAt: string }> {
    let stmt: Database.Statement;
    let rows: Array<{ id: string; agent: string; started_at: string }>;

    if (sinceDays !== undefined && sinceDays > 0) {
      const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
      const cutoffIso = new Date(cutoffMs).toISOString();
      stmt = this.db.prepare(`
        SELECT id, agent, started_at
        FROM sessions
        WHERE started_at >= ?
        ORDER BY started_at DESC
      `);
      rows = stmt.all(cutoffIso) as Array<{ id: string; agent: string; started_at: string }>;
    } else {
      stmt = this.db.prepare(`
        SELECT id, agent, started_at
        FROM sessions
        ORDER BY started_at DESC
      `);
      rows = stmt.all() as Array<{ id: string; agent: string; started_at: string }>;
    }

    return rows.map(row => ({
      id: row.id,
      agent: row.agent,
      startedAt: row.started_at
    }));
  }

  getSessionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private extractContentText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const item of content) {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          if (obj.type === 'text' && typeof obj.text === 'string') {
            texts.push(obj.text);
          }
        }
      }
      return texts.join(' ');
    }

    return '';
  }
}
