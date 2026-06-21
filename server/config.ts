import path from 'path';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  dbPath: process.env.DB_PATH || undefined,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  outputDir: process.env.OUTPUT_DIR || path.join(process.cwd(), '.pipeline', 'output'),
};
