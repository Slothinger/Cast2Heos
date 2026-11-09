import { Constants, Player } from 'yt-cast-receiver';
import { buildDidl } from './heos.js';

const { PLAYER_STATUSES } = Constants;
const POLL_INTERVAL_MS = 1000;
// After our own commands the speaker passes through TRANSITIONING etc.; don't
// mistake that for user interaction.
const COMMAND_GRACE_MS = 2500;
const START_TIMEOUT_MS = 20_000;
// Stopping within this many seconds of the end counts as "track finished".
const END_TOLERANCE_S = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * yt-cast-receiver Player that plays on a HEOS speaker via UPnP.
 *
 * The speaker pulls prepared audio files from our HTTP server. Its transport
 * state is polled to detect track ends (-> next in queue) and changes made on
 * the speaker or in the HEOS app (pause, volume, switching source).
 */
export class HeosPlayer extends Player {
  #renderer;
  #library;
  #mediaPrefix;
  #artPrefix;
  /** Incremented by every play/stop so superseded operations bail out. */
  #generation = 0;
  /** @type {{video: object, track: import('./media.js').Track} | null} */
  #current = null;
  #position = 0;
  #volume = { level: 0, muted: false };
  #busy = 0;
  #graceUntil = 0;
  #polling = false;
  #pollTimer = null;
  #pollFailing = false;
  #prefetchedId = null;

  constructor({ renderer, library, baseUrl }) {
    super();
    this.#renderer = renderer;
    this.#library = library;
    this.#mediaPrefix = `${baseUrl}/media/`;
    this.#artPrefix = `${baseUrl}/art/`;
  }

  async start() {
    this.#volume = await this.#renderer.getVolume();
    this.#pollTimer = setInterval(() => this.#poll(), POLL_INTERVAL_MS);
  }

  shutdown() {
    clearInterval(this.#pollTimer);
  }

  async #command(fn) {
    this.#busy++;
    try {
      return await fn();
    }
    finally {
      this.#busy--;
      this.#graceUntil = Date.now() + COMMAND_GRACE_MS;
    }
  }

  async #waitForPlaying(generation) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && generation === this.#generation) {
      if (await this.#renderer.getTransportState() === 'PLAYING') {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async #speakerPlaysOurMedia() {
    const { trackUri } = await this.#renderer.getPositionInfo();
    return trackUri.startsWith(this.#mediaPrefix);
  }

  doPlay(video, position) {
    return this.#command(async () => {
      const generation = ++this.#generation;
      this.#current = null;
      let track;
      try {
        track = await this.#library.get(video);
      }
      catch (error) {
        this.logger.error(`[heos-ytcast] Cannot load ${video.id}:`, error.message);
        return false;
      }
      if (generation !== this.#generation) {
        return false;
      }
      const url = `${this.#mediaPrefix}${track.id}.${track.ext}`;
      this.#current = { video, track };
      this.#position = position;
      try {
        await this.#renderer.setUri(url, buildDidl({ ...track, url, artUrl: `${this.#artPrefix}${track.id}.jpg` }));
        await this.#renderer.play();
        if (!await this.#waitForPlaying(generation)) {
          if (generation === this.#generation) {
            this.logger.error(`[heos-ytcast] Speaker did not start playing ${video.id}`);
            this.#current = null;
          }
          return false;
        }
        if (position > 1) {
          await this.#renderer.seek(position);
        }
        this.#position = position;
        return true;
      }
      catch (error) {
        this.logger.error(`[heos-ytcast] Playback of ${video.id} failed:`, error.message);
        if (generation === this.#generation) {
          this.#current = null;
        }
        return false;
      }
    });
  }

  doPause() {
    return this.#command(async () => {
      try {
        await this.#renderer.pause();
        return true;
      }
      catch (error) {
        this.logger.error('[heos-ytcast] Pause failed:', error.message);
        return false;
      }
    });
  }

  doResume() {
    return this.#command(async () => {
      try {
        await this.#renderer.play();
        return true;
      }
      catch (error) {
        this.logger.error('[heos-ytcast] Resume failed:', error.message);
        return false;
      }
    });
  }

  doStop() {
    return this.#command(async () => {
      this.#generation++;
      const hadMedia = this.#current !== null;
      this.#current = null;
      try {
        // Never stop something else (Spotify, AirPlay, ...) the user switched to.
        if (hadMedia && await this.#speakerPlaysOurMedia()) {
          await this.#renderer.stop();
        }
      }
      catch (error) {
        this.logger.warn('[heos-ytcast] Stop failed:', error.message);
      }
      return true;
    });
  }

  doSeek(position) {
    return this.#command(async () => {
      if (!this.#current) {
        return false;
      }
      try {
        await this.#renderer.seek(position);
        this.#position = position;
        return true;
      }
      catch (error) {
        this.logger.error('[heos-ytcast] Seek failed:', error.message);
        return false;
      }
    });
  }

  doSetVolume(volume) {
    return this.#command(async () => {
      try {
        if (volume.level !== this.#volume.level) {
          await this.#renderer.setVolume(volume.level);
        }
        if (volume.muted !== this.#volume.muted) {
          await this.#renderer.setMute(volume.muted);
        }
        this.#volume = { level: volume.level, muted: volume.muted };
        return true;
      }
      catch (error) {
        this.logger.error('[heos-ytcast] Setting volume failed:', error.message);
        return false;
      }
    });
  }

  async doGetVolume() {
    return this.#volume;
  }

  async doGetPosition() {
    return this.#current ? this.#position : 0;
  }

  async doGetDuration() {
    return this.#current?.track.duration ?? 0;
  }

  async #poll() {
    if (this.#polling) {
      return;
    }
    this.#polling = true;
    try {
      const [state, info, volume] = await Promise.all([
        this.#renderer.getTransportState(),
        this.#renderer.getPositionInfo(),
        this.#renderer.getVolume()
      ]);
      if (this.#pollFailing) {
        this.logger.info('[heos-ytcast] Speaker reachable again');
        this.#pollFailing = false;
      }
      if (this.#busy > 0 || Date.now() < this.#graceUntil) {
        return;
      }
      const ours = info.trackUri.startsWith(this.#mediaPrefix);
      // A stopped transport reports position 0; keep the last real position for end detection.
      if (this.#current && ours && (state === 'PLAYING' || state === 'PAUSED_PLAYBACK')) {
        this.#position = info.position;
      }
      const volumeChanged = volume.level !== this.#volume.level || volume.muted !== this.#volume.muted;
      if (volumeChanged) {
        this.#volume = volume;
        if (this.status !== PLAYER_STATUSES.IDLE) {
          await this.notifyExternalStateChange();
        }
      }
      if (this.#current) {
        await this.#sync(state, ours);
      }
    }
    catch (error) {
      if (!this.#pollFailing) {
        this.logger.warn('[heos-ytcast] Speaker not reachable:', error.message);
        this.#pollFailing = true;
      }
    }
    finally {
      this.#polling = false;
    }
  }

  /** Reconciles the receiver's status with what the speaker is actually doing. */
  async #sync(state, ours) {
    const status = this.status;
    if (status === PLAYER_STATUSES.PLAYING) {
      this.#prefetchNext();
    }
    if ((state === 'STOPPED' || state === 'NO_MEDIA_PRESENT') && status === PLAYER_STATUSES.PLAYING) {
      const ended = this.#position >= this.#current.track.duration - END_TOLERANCE_S;
      this.#current = null;
      if (ended) {
        this.logger.info('[heos-ytcast] Track finished, playing next');
        if (!await this.next() && this.status === PLAYER_STATUSES.PLAYING) {
          await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
        }
      }
      else {
        this.logger.info('[heos-ytcast] Playback stopped on the speaker');
        await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
      }
      return;
    }
    if (!ours && state !== 'TRANSITIONING') {
      this.logger.info('[heos-ytcast] Speaker switched to another source');
      this.#generation++;
      this.#current = null;
      await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
      return;
    }
    if (state === 'PLAYING' && status === PLAYER_STATUSES.PAUSED) {
      await this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING);
    }
    else if (state === 'PAUSED_PLAYBACK' && status === PLAYER_STATUSES.PLAYING) {
      await this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED);
    }
  }

  #prefetchNext() {
    const queue = this.queue.getState();
    const next = queue.next ?? queue.autoplay;
    if (next && next.id !== this.#prefetchedId) {
      this.#prefetchedId = next.id;
      this.#library.prefetch(next);
    }
  }
}
