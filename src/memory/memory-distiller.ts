import { MemoryStore } from './memory-store.js';
import { SessionIndexer } from './session-indexer.js';

const OLLAMA_MODEL = 'gemma4-e2b-local:latest';
const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_TIMEOUT_MS = 30000;

export interface DistillResult {
  sessionsProcessed: number;
  memoryEntriesAdded: number;
  userEntriesAdded: number;
  errors: string[];
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system: string;
  stream: boolean;
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

async function callOllama(
  model: string,
  baseUrl: string,
  prompt: string,
  system: string
): Promise<string> {
  const url = `${baseUrl}/api/generate`;
  const body: OllamaGenerateRequest = {
    model,
    prompt,
    system,
    stream: false,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    return data.response ?? '';
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Ollama request timed out after 30s');
    }
    throw err;
  }
}

function extractJsonArray(text: string): string[] {
  // Find the first '[' and track depth to find the matching ']'
  const startIdx = text.indexOf('[');
  if (startIdx === -1) {
    return [];
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let endIdx = -1;

  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '[') {
        depth++;
      } else if (char === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  if (endIdx === -1) {
    return [];
  }

  const jsonStr = text.slice(startIdx, endIdx + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function formatConversation(messages: Array<{ role: string; content: string; timestamp: string }>): string {
  const formatted = messages.map(m => `[${m.role}]: ${m.content}`).join('\n\n');
  
  // Truncate to max 3000 chars
  if (formatted.length <= 3000) {
    return formatted;
  }
  
  // Try to truncate at a message boundary
  let cutoff = 3000;
  while (cutoff > 0 && formatted[cutoff] !== '\n') {
    cutoff--;
  }
  
  if (cutoff > 100) {
    return formatted.slice(0, cutoff) + '\n\n[...truncated...]';
  }
  
  // Fallback: hard truncate
  return formatted.slice(0, 3000) + '\n\n[...truncated...]';
}

export class MemoryDistiller {
  constructor(
    private store: MemoryStore,
    private indexer: SessionIndexer,
    private model: string = OLLAMA_MODEL,
    private baseUrl: string = OLLAMA_BASE_URL
  ) {}

  async distill(sinceDays: number = 7): Promise<DistillResult> {
    const result: DistillResult = {
      sessionsProcessed: 0,
      memoryEntriesAdded: 0,
      userEntriesAdded: 0,
      errors: [],
    };

    // First, ensure recent sessions are indexed
    try {
      await this.indexer.index(sinceDays);
    } catch (err) {
      result.errors.push(`Failed to index sessions: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    // Get sessions from the database
    const sessions = this.indexer.getSessions(sinceDays);

    for (const session of sessions) {
      try {
        const sessionResult = await this.distillSession(session.id);
        result.sessionsProcessed += sessionResult.sessionsProcessed;
        result.memoryEntriesAdded += sessionResult.memoryEntriesAdded;
        result.userEntriesAdded += sessionResult.userEntriesAdded;
        result.errors.push(...sessionResult.errors);
      } catch (err) {
        result.errors.push(`Failed to distill session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  async distillSession(sessionId: string): Promise<DistillResult> {
    const result: DistillResult = {
      sessionsProcessed: 0,
      memoryEntriesAdded: 0,
      userEntriesAdded: 0,
      errors: [],
    };

    // Get messages for this session
    const messages = this.indexer.getSession(sessionId);

    // Skip if fewer than 5 messages (not enough to distill)
    if (messages.length < 5) {
      return result;
    }

    result.sessionsProcessed = 1;

    // Format conversation excerpt
    const conversation = formatConversation(messages);

    // Call 1: Memory insights
    const memorySystem = 'You are a memory extraction agent. Extract factual insights worth remembering long-term.';
    const memoryPrompt = `Given this conversation, what facts about the environment, projects, tools, or conventions are worth adding to MEMORY.md? Return a JSON array of strings, max 3 items, each under 150 chars. Return [] if nothing notable. Format: ["fact1", "fact2"]`;

    try {
      const memoryResponse = await callOllama(this.model, this.baseUrl, `${memoryPrompt}\n\n${conversation}`, memorySystem);
      const memoryInsights = extractJsonArray(memoryResponse);

      for (const insight of memoryInsights) {
        const addResult = await this.store.add('memory', insight);
        if (addResult.success) {
          result.memoryEntriesAdded++;
        }
        // Skip if not successful (duplicate or over limit) - no error needed
      }
    } catch (err) {
      result.errors.push(`Memory extraction failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Call 2: User profile insights
    const userSystem = 'You are a user modeling agent. Extract insights about the user\'s preferences and style.';
    const userPrompt = `Given this conversation, what did you learn about this user's preferences, communication style, or work habits? Return a JSON array of strings, max 2 items, each under 120 chars. Return [] if nothing notable. Format: ["insight1"]`;

    try {
      const userResponse = await callOllama(this.model, this.baseUrl, `${userPrompt}\n\n${conversation}`, userSystem);
      const userInsights = extractJsonArray(userResponse);

      for (const insight of userInsights) {
        const addResult = await this.store.add('user', insight);
        if (addResult.success) {
          result.userEntriesAdded++;
        }
        // Skip if not successful (duplicate or over limit) - no error needed
      }
    } catch (err) {
      result.errors.push(`User extraction failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }
}
