import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import YouTubeCastReceiver, { Constants, DefaultLogger } from 'yt-cast-receiver';
import { FileDataStore } from './datastore.js';
import { HeosRenderer } from './heos.js';
import { MediaLibrary } from './media.js';
import { HeosPlayer } from './player.js';
import { startMediaServer } from './server.js';

const env = process.env;
const config = {
  heosHost: env.HEOS_HOST,
  deviceName: env.DEVICE_NAME,
  bridgeHost: env.BRIDGE_HOST,
  httpPort: Number(env.HTTP_PORT || 8098),
  dialPort: Number(env.DIAL_PORT || 8099),
  dataDir: env.DATA_DIR || path.resolve('data'),
  cacheDir: env.CACHE_DIR || path.join(os.tmpdir(), 'heos-ytcast'),
  ytdlpPath: env.YTDLP_PATH || 'yt-dlp',
  ytdlpAutoUpdate: env.YTDLP_AUTO_UPDATE !== 'false',
  cookiesFile: env.YTDLP_COOKIES || null,
  logLevel: env.LOG_LEVEL || Constants.LOG_LEVELS.INFO
};

const logger = new DefaultLogger();
logger.setLevel(config.logLevel);

if (!config.heosHost) {
  logger.error('[heos-ytcast] HEOS_HOST is required (IP address of the HEOS speaker).');
  process.exit(1);
}

/** The local address the speaker can reach us on (the interface routing to it). */
function localAddressFor(host) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', reject);
    socket.connect(9, host, () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}

if (config.ytdlpAutoUpdate) {
  const update = spawnSync(config.ytdlpPath, ['-U'], { encoding: 'utf8' });
  const output = `${update.stdout ?? ''}${update.stderr ?? ''}`.trim().split('\n').pop();
  logger.info(`[heos-ytcast] yt-dlp update: ${update.error?.message ?? output}`);
}

const renderer = new HeosRenderer(config.heosHost);
await renderer.init();
const bridgeHost = config.bridgeHost || await localAddressFor(config.heosHost);
const deviceName = config.deviceName || `HEOS ${renderer.name}`;

const library = new MediaLibrary({
  cacheDir: config.cacheDir,
  ytdlpPath: config.ytdlpPath,
  cookiesFile: config.cookiesFile,
  logger
});
await library.init();
const server = await startMediaServer({ library, port: config.httpPort, logger });

const player = new HeosPlayer({ renderer, library, baseUrl: `http://${bridgeHost}:${config.httpPort}` });
const receiver = new YouTubeCastReceiver(player, {
  // Never drop the speaker's volume level to 0 just because a phone app can't express "muted".
  app: { mutePolicy: Constants.MUTE_POLICIES.PRESERVE_VOLUME_LEVEL },
  device: { name: deviceName, brand: 'Denon', model: 'HEOS' },
  dial: { port: config.dialPort, bindToAddresses: [bridgeHost] },
  dataStore: new FileDataStore(config.dataDir),
  logger,
  logLevel: config.logLevel
});

receiver.on('senderConnect', (sender) => logger.info(`[heos-ytcast] Connected: ${sender.name} (${sender.client?.name ?? 'unknown app'})`));
receiver.on('senderDisconnect', (sender) => logger.info(`[heos-ytcast] Disconnected: ${sender.name}`));
receiver.on('error', (error) => logger.error('[heos-ytcast] Receiver error:', error));
receiver.on('terminate', (error) => {
  logger.error('[heos-ytcast] Receiver terminated, exiting so the container restarts:', error);
  process.exit(1);
});

await receiver.start();
await player.start();
logger.info(`[heos-ytcast] "${deviceName}" ready: speaker ${config.heosHost}, media server http://${bridgeHost}:${config.httpPort}, DIAL port ${config.dialPort}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`[heos-ytcast] ${signal} received, shutting down`);
  player.shutdown();
  server.close();
  try {
    await receiver.stop();
  }
  catch (error) {
    logger.error('[heos-ytcast] Error stopping receiver:', error);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
