import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DataStore } from 'yt-cast-receiver';

/**
 * Persists the receiver identity (DIAL pid, screen id) in one JSON file, so
 * the speaker keeps a single stable entry in the Cast menu across restarts.
 */
export class FileDataStore extends DataStore {
  #file;
  #data = {};

  constructor(dir) {
    super();
    mkdirSync(dir, { recursive: true });
    this.#file = path.join(dir, 'receiver.json');
    try {
      this.#data = JSON.parse(readFileSync(this.#file, 'utf8'));
    }
    catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Cannot read ${this.#file}: ${error.message}`);
      }
    }
  }

  async set(key, value) {
    this.#data[key] = value;
    await writeFile(this.#file, JSON.stringify(this.#data, null, 2));
  }

  async get(key) {
    return this.#data[key] ?? null;
  }
}
