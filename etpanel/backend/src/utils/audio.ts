import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { SOUNDS_TEMP_DIR, TEMP_FILE_TTL_HOURS, MAX_CLIP_DURATION_SECONDS } from '../config.js';

const execAsync = promisify(exec);

/**
 * Get accurate audio duration using ffprobe
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error('Could not parse duration');
    }
    return duration;
  } catch (error) {
    console.error('Error getting audio duration:', error);
    throw new Error('Failed to get audio duration');
  }
}

/**
 * Generate waveform peak data for visualization
 * Returns an array of peak values (0-1) for the audio file
 */
export async function generateWaveformPeaks(filePath: string, numPeaks: number = 200): Promise<number[]> {
  try {
    // Use ffmpeg to extract audio data and compute peaks
    // This outputs raw audio samples that we can process
    const { stdout } = await execAsync(
      `ffmpeg -i "${filePath}" -ac 1 -filter:a "aresample=8000" -f s16le -acodec pcm_s16le - 2>/dev/null | od -An -td2 -w2`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer for large files
    );

    // Parse the sample values
    const samples = stdout
      .trim()
      .split('\n')
      .map(line => {
        const val = parseInt(line.trim(), 10);
        return isNaN(val) ? 0 : val;
      })
      .filter(v => v !== 0 || Math.random() < 0.1); // Keep some zeros to maintain shape

    if (samples.length === 0) {
      // Return flat line if no samples
      return new Array(numPeaks).fill(0.1);
    }

    // Divide samples into chunks and get peak for each chunk
    const chunkSize = Math.max(1, Math.floor(samples.length / numPeaks));
    const peaks: number[] = [];

    for (let i = 0; i < numPeaks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, samples.length);
      const chunk = samples.slice(start, end);

      if (chunk.length === 0) {
        peaks.push(0);
      } else {
        // Get the maximum absolute value in this chunk
        const maxAbs = Math.max(...chunk.map(Math.abs));
        // Normalize to 0-1 (16-bit audio max is 32768)
        peaks.push(Math.min(1, maxAbs / 32768));
      }
    }

    return peaks;
  } catch (error) {
    console.error('Error generating waveform:', error);
    // Return a flat line on error
    return new Array(numPeaks).fill(0.1);
  }
}

/**
 * Clip audio file to specified start/end times
 * Converts to 48kHz mono to match etman-server's Opus encoder expectations
 * This avoids runtime resampling which degrades quality
 */
export async function clipAndConvertAudio(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number
): Promise<{ duration: number; fileSize: number }> {
  // Validate times
  const clipDuration = endTime - startTime;
  if (clipDuration <= 0) {
    throw new Error('End time must be after start time');
  }
  if (clipDuration > MAX_CLIP_DURATION_SECONDS) {
    throw new Error(`Clip duration cannot exceed ${MAX_CLIP_DURATION_SECONDS} seconds`);
  }

  try {
    // Use ffmpeg to clip and convert
    // -ss: start time (with millisecond precision)
    // -to: end time (with millisecond precision)
    // -ar 48000: convert to 48kHz to match etman-server Opus encoder
    //            (avoids low-quality linear interpolation resampling at runtime)
    // -ac 1: mono (required for ET)
    // -b:a 192k: high bitrate for quality
    // -af aresample=resampler=soxr: use high-quality SoX resampler
    await execAsync(
      `ffmpeg -y -i "${inputPath}" -ss ${startTime.toFixed(3)} -to ${endTime.toFixed(3)} -af "aresample=resampler=soxr:precision=28" -ar 48000 -ac 1 -b:a 192k "${outputPath}"`,
      { timeout: 60000 } // 60 second timeout
    );

    // Get the resulting file info
    const duration = await getAudioDuration(outputPath);
    const stats = statSync(outputPath);

    return {
      duration: Math.round(duration),
      fileSize: stats.size,
    };
  } catch (error) {
    console.error('Error clipping audio:', error);
    throw new Error('Failed to clip audio');
  }
}

/**
 * Ensure temp directory exists
 */
export function ensureTempDir(): void {
  if (!existsSync(SOUNDS_TEMP_DIR)) {
    mkdirSync(SOUNDS_TEMP_DIR, { recursive: true });
  }
}

/**
 * Clean up temp files older than TTL
 */
export async function cleanupTempFiles(): Promise<{ deleted: number; errors: number }> {
  ensureTempDir();

  const now = Date.now();
  const ttlMs = TEMP_FILE_TTL_HOURS * 60 * 60 * 1000;
  let deleted = 0;
  let errors = 0;

  try {
    const files = readdirSync(SOUNDS_TEMP_DIR);

    for (const file of files) {
      // Skip non-mp3 files and hidden files
      if (!file.endsWith('.mp3') || file.startsWith('.')) {
        continue;
      }

      const filePath = join(SOUNDS_TEMP_DIR, file);

      try {
        const stats = statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > ttlMs) {
          unlinkSync(filePath);
          deleted++;
          console.log(`[cleanup] Deleted temp file: ${file} (age: ${Math.round(age / 1000 / 60)} minutes)`);
        }
      } catch (err) {
        console.error(`[cleanup] Error processing ${file}:`, err);
        errors++;
      }
    }
  } catch (err) {
    console.error('[cleanup] Error reading temp directory:', err);
    errors++;
  }

  return { deleted, errors };
}

/**
 * Delete a specific temp file
 */
export function deleteTempFile(tempId: string): boolean {
  const filePath = join(SOUNDS_TEMP_DIR, `${tempId}.mp3`);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
  } catch (err) {
    console.error(`Error deleting temp file ${tempId}:`, err);
  }
  return false;
}

/**
 * Check if ffmpeg is available
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    await execAsync('ffprobe -version');
    return true;
  } catch {
    return false;
  }
}
