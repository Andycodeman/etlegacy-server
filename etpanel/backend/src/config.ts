import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Server
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // ET:Legacy Server
  ET_RCON_PASSWORD: z.string(),
  ET_SERVER_HOST: z.string().default('127.0.0.1'),
  ET_SERVER_PORT: z.coerce.number().default(27960),

  // Game Events API Key
  GAME_API_KEY: z.string(),

  // Sound Storage
  SOUNDS_DIR: z.string().default('/home/andy/etlegacy/sounds'),
  SOUNDS_TEMP_DIR: z.string().default('/home/andy/etlegacy/sounds/temp'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const isDev = config.NODE_ENV === 'development';
export const isProd = config.NODE_ENV === 'production';

// Sound configuration
export const SOUNDS_DIR = config.SOUNDS_DIR;
export const SOUNDS_TEMP_DIR = config.SOUNDS_TEMP_DIR;
export const TEMP_FILE_TTL_HOURS = 24; // Temp files older than this are cleaned up
export const MAX_CLIP_DURATION_SECONDS = 30; // Maximum clip length allowed
