import { watch, FSWatcher } from 'fs';
import { open, FileHandle, stat } from 'fs/promises';
import { EventEmitter } from 'events';
import { config } from '../config.js';
import path from 'path';
import os from 'os';

export interface ConsoleLine {
  timestamp: string;
  raw: string;
  type: 'say' | 'sayteam' | 'kill' | 'connect' | 'disconnect' | 'system' | 'unknown';
  player?: string;
  message?: string;
}

class ConsoleTailService extends EventEmitter {
  private logPath: string;
  private watcher: FSWatcher | null = null;
  private fileHandle: FileHandle | null = null;
  private lastPosition: number = 0;
  private buffer: ConsoleLine[] = [];
  private maxBufferSize = 200;
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    // ET:Legacy log path: ~/.etlegacy/legacy/server.log on the VPS
    // When running on VPS, the panel is on the same machine as the server
    const homeDir = os.homedir();
    this.logPath = path.join(homeDir, '.etlegacy', 'legacy', 'server.log');
  }

  private parseLine(raw: string): ConsoleLine {
    const timestamp = new Date().toISOString();
    const line: ConsoleLine = { timestamp, raw, type: 'unknown' };

    // Parse say: player: message
    const sayMatch = raw.match(/^say:\s*(.+?):\s*(.*)$/i);
    if (sayMatch) {
      line.type = 'say';
      line.player = sayMatch[1].trim();
      line.message = sayMatch[2].trim();
      return line;
    }

    // Parse sayteam: player: message
    const sayTeamMatch = raw.match(/^sayteam:\s*(.+?):\s*(.*)$/i);
    if (sayTeamMatch) {
      line.type = 'sayteam';
      line.player = sayTeamMatch[1].trim();
      line.message = sayTeamMatch[2].trim();
      return line;
    }

    // Parse kill/death events (Obituary)
    if (raw.includes(' killed ') || raw.includes(' died')) {
      line.type = 'kill';
      return line;
    }

    // Parse connect events
    if (raw.includes('ClientConnect:') || raw.includes('entered the game')) {
      line.type = 'connect';
      const enterMatch = raw.match(/(.+?) entered the game/);
      if (enterMatch) {
        line.player = enterMatch[1].trim();
      }
      return line;
    }

    // Parse disconnect events
    if (raw.includes('ClientDisconnect:') || raw.includes('disconnected')) {
      line.type = 'disconnect';
      return line;
    }

    // System messages (broadcasts, etc.)
    if (raw.includes('broadcast:') || raw.includes('print:') || raw.startsWith('[')) {
      line.type = 'system';
      return line;
    }

    return line;
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

      // Start polling for changes (more reliable than fs.watch for remote/mounted filesystems)
      this.pollInterval = setInterval(() => this.checkForChanges(), 500);

      console.log(`[ConsoleTail] Started watching: ${this.logPath}`);
    } catch (err) {
      console.error(`[ConsoleTail] Failed to start:`, err);
      this.isRunning = false;
    }
  }

  private async checkForChanges() {
    try {
      const stats = await stat(this.logPath).catch(() => null);
      if (!stats) return;

      // File was truncated (log rotation)
      if (stats.size < this.lastPosition) {
        this.lastPosition = 0;
      }

      // New content available
      if (stats.size > this.lastPosition) {
        await this.readNewContent(stats.size);
      }
    } catch (err) {
      // File might be temporarily unavailable, just skip this cycle
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
        const parsed = this.parseLine(raw);
        this.buffer.push(parsed);

        // Emit for real-time subscribers
        this.emit('line', parsed);
      }

      // Trim buffer to max size
      while (this.buffer.length > this.maxBufferSize) {
        this.buffer.shift();
      }
    } catch (err) {
      console.error(`[ConsoleTail] Error reading content:`, err);
    }
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    console.log('[ConsoleTail] Stopped');
  }

  getRecentLines(count: number = 50): ConsoleLine[] {
    return this.buffer.slice(-count);
  }

  getLogPath(): string {
    return this.logPath;
  }
}

// Singleton instance
export const consoleTail = new ConsoleTailService();
