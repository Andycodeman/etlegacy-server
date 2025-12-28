import { stat, open, FileHandle } from 'fs/promises';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';

export interface PlayerMessage {
  timestamp: string;
  slot: number;
  name: string;
  message: string;
  isReply?: boolean;
  raw: string;
}

class PanelMessageTailService extends EventEmitter {
  private logPath: string;
  private lastPosition: number = 0;
  private buffer: PlayerMessage[] = [];
  private maxBufferSize = 100;
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    // Message log written by Lua: ~/.etlegacy/legacy/etpanel_messages.log
    const homeDir = os.homedir();
    this.logPath = path.join(homeDir, '.etlegacy', 'legacy', 'etpanel_messages.log');
  }

  private parseLogLine(raw: string): PlayerMessage | null {
    // Format: [timestamp] event_type: json_data
    // Example: [1702958400] player_dm: {"slot":0,"name":"Player","message":"hello"}
    const match = raw.match(/^\[(\d+)\]\s*(\w+):\s*(.+)$/);
    if (!match) return null;

    const [, timestampStr, eventType, jsonStr] = match;

    if (eventType !== 'player_dm') return null;

    try {
      const data = JSON.parse(jsonStr);
      return {
        timestamp: new Date(parseInt(timestampStr) * 1000).toISOString(),
        slot: data.slot || 0,
        name: data.name || 'Unknown',
        message: data.message || '',
        isReply: data.isReply || false,
        raw,
      };
    } catch {
      return null;
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Check if file exists, get initial position
      const stats = await stat(this.logPath).catch(() => null);
      if (stats) {
        this.lastPosition = stats.size; // Start from end of file
      }

      // Start polling for changes
      this.pollInterval = setInterval(() => this.checkForChanges(), 500);

      console.log(`[PanelMessageTail] Started watching: ${this.logPath}`);
    } catch (err) {
      console.error(`[PanelMessageTail] Failed to start:`, err);
      this.isRunning = false;
    }
  }

  private async checkForChanges() {
    try {
      const stats = await stat(this.logPath).catch(() => null);
      if (!stats) return;

      // File was truncated
      if (stats.size < this.lastPosition) {
        this.lastPosition = 0;
      }

      // New content available
      if (stats.size > this.lastPosition) {
        await this.readNewContent(stats.size);
      }
    } catch {
      // File might be temporarily unavailable
    }
  }

  private async readNewContent(currentSize: number) {
    try {
      const handle = await open(this.logPath, 'r');
      const bytesToRead = currentSize - this.lastPosition;
      const buffer = Buffer.alloc(bytesToRead);

      await handle.read(buffer, 0, bytesToRead, this.lastPosition);
      await handle.close();

      this.lastPosition = currentSize;

      const content = buffer.toString('utf8');
      const lines = content.split('\n').filter((line) => line.trim());

      for (const raw of lines) {
        const parsed = this.parseLogLine(raw);
        if (parsed) {
          this.buffer.push(parsed);
          // Emit for real-time subscribers
          this.emit('message', parsed);
        }
      }

      // Trim buffer to max size
      while (this.buffer.length > this.maxBufferSize) {
        this.buffer.shift();
      }
    } catch (err) {
      console.error(`[PanelMessageTail] Error reading content:`, err);
    }
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('[PanelMessageTail] Stopped');
  }

  getRecentMessages(count: number = 50): PlayerMessage[] {
    return this.buffer.slice(-count);
  }

  getLogPath(): string {
    return this.logPath;
  }
}

// Singleton instance
export const panelMessageTail = new PanelMessageTailService();
