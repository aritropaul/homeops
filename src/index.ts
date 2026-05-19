/**
 * HomeOps — Hosted Wrapper Service for SmartRent + iOS Shortcuts
 * Entry point: starts the server and background poller.
 */
import { logger } from './logger.js';
import { startServer } from './server.js';
import { stopPoller } from './poller.js';

async function main(): Promise<void> {
  logger.info('Starting HomeOps');

  // Catch errors that escape promise chains so we exit cleanly instead of
  // running in a half-dead state.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection — exiting');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });

  try {
    const server = await startServer();

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutdown signal received');
      stopPoller();
      try {
        await server.close();
      } catch (err) {
        logger.error({ err }, 'Error closing server');
      }
      logger.info('Server closed');
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start HomeOps');
    process.exit(1);
  }
}

void main();
