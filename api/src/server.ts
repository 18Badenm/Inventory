import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

/**
 * Process entry point: load config, open storage, serve, and shut down
 * cleanly so in-flight requests finish and the database file is closed.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  const app = buildApp({ db, logLevel: config.LOG_LEVEL });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      db.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  // Startup failures must be loud and must not leave a half-booted process
  // accepting traffic.
  console.error('Failed to start Inventory API:', error);
  process.exit(1);
});
