import { loadConfig } from './config.js';
import { buildApp, VERSION } from './app.js';

const config = loadConfig();
const ctx = await buildApp(config);
await ctx.app.listen({ host: config.host, port: config.port });
ctx.app.log.info({ version: VERSION, relay: config.relayEnabled }, 'NIAL CONTROL demarre');

const shutdown = async (signal: string) => {
  ctx.app.log.info({ signal }, 'arret en cours');
  await ctx.app.close();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
