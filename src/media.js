import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Constants } from 'yt-cast-receiver';

// Direct (non-HLS) audio, AAC preferred: yt-dlp remuxes it into a seekable m4a without re-encoding.
const FORMAT = 'bestaudio[protocol=https][acodec^=mp4a]/bestaudio[protocol=https]';
const FIELDS = 'id,title,track,artists,artist,creator,uploader,channel,album,duration,acodec,filepath';
const MAX_TRACKS = 40;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const isVideoId = (id) => VIDEO_ID.test(id);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      }
      else {
        reject(new Error(`${path.basename(cmd)} exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      }
    });
  });
}

/**
 * @typedef {object} Track
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number} duration seconds
 * @property {string} file local path of the playable file
 * @property {string} ext file extension used in the stream URL
 * @property {string} mimeType
 */

/**
 * Resolves YouTube videos with yt-dlp, downloads the audio and stores it as a
 * file the speaker can play and seek in (AAC remuxed to m4a, anything else as FLAC).
 */
export class MediaLibrary {
  #dir;
  #ytdlp;
  #cookies;
  #logger;
  /** @type {Map<string, Promise<Track>>} insertion order = least recently used first */
  #tracks = new Map();

  constructor({ cacheDir, ytdlpPath, cookiesFile, logger }) {
    this.#dir = cacheDir;
    this.#ytdlp = ytdlpPath;
    this.#cookies = cookiesFile;
    this.#logger = logger;
  }

  async init() {
    await rm(this.#dir, { recursive: true, force: true });
    await mkdir(this.#dir, { recursive: true });
  }

  /**
   * @param {import('yt-cast-receiver').Video} video
   * @returns {Promise<Track>}
   */
  get(video) {
    let track = this.#tracks.get(video.id);
    if (track) {
      this.#tracks.delete(video.id);
    }
    else {
      track = this.#prepare(video);
      track.catch(() => {
        if (this.#tracks.get(video.id) === track) {
          this.#tracks.delete(video.id);
        }
      });
    }
    this.#tracks.set(video.id, track);
    this.#evict();
    return track;
  }

  prefetch(video) {
    this.get(video).catch((error) => this.#logger.warn(`[heos-ytcast] Prefetch of ${video.id} failed:`, error.message));
  }

  /** A track that is already prepared (for the HTTP server); `null` otherwise. */
  async ready(id) {
    const track = this.#tracks.get(id);
    return track ? track.catch(() => null) : null;
  }

  async #prepare(video) {
    if (!isVideoId(video.id)) {
      throw new Error(`Invalid video id: ${video.id}`);
    }
    const started = Date.now();
    let info;
    try {
      info = await this.#download(video);
    }
    catch (error) {
      await this.#removeSources(video.id);
      throw error;
    }
    const aac = (info.acodec ?? '').startsWith('mp4a') && info.filepath.endsWith('.m4a');
    const ext = aac ? 'm4a' : 'flac';
    const file = path.join(this.#dir, `${video.id}.${ext}`);
    try {
      if (aac) {
        await rename(info.filepath, file);
      }
      else {
        await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', info.filepath, '-vn', '-c:a', 'flac', '-f', 'flac', `${file}.part`]);
        await rename(`${file}.part`, file);
      }
    }
    finally {
      await this.#removeSources(video.id);
      await rm(`${file}.part`, { force: true });
    }
    const artist = info.artists?.join(', ') || info.artist || info.creator || info.uploader || info.channel || '';
    this.#logger.info(`[heos-ytcast] Prepared ${video.id} "${artist} - ${info.track || info.title}" in ${Date.now() - started} ms`);
    return {
      id: video.id,
      title: info.track || info.title || video.id,
      artist,
      album: info.album ?? '',
      duration: Number(info.duration) || 0,
      file,
      ext,
      mimeType: aac ? 'audio/m4a' : 'audio/flac'
    };
  }

  /** Lets yt-dlp download the audio; it also honours YouTube's mandatory wait before a stream URL becomes valid. */
  async #download(video) {
    const host = video.client?.key === Constants.CLIENTS.YTMUSIC.key ? 'music.youtube.com' : 'www.youtube.com';
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress', '--no-mtime', '--no-part',
      '--js-runtimes', 'node',
      '-f', FORMAT,
      '-o', path.join(this.#dir, `${video.id}.source.%(ext)s`),
      '--print', `after_move:%(.{${FIELDS}})j`,
      ...(this.#cookies ? ['--cookies', this.#cookies] : []),
      `https://${host}/watch?v=${video.id}`
    ];
    return JSON.parse(await run(this.#ytdlp, args));
  }

  async #removeSources(id) {
    const files = await readdir(this.#dir);
    await Promise.all(files
      .filter((f) => f.startsWith(`${id}.source.`))
      .map((f) => rm(path.join(this.#dir, f), { force: true })));
  }

  #evict() {
    for (const [id, track] of this.#tracks) {
      if (this.#tracks.size <= MAX_TRACKS) {
        break;
      }
      this.#tracks.delete(id);
      track.then((t) => unlink(t.file)).catch(() => {});
    }
  }
}
