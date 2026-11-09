// Minimal UPnP/DLNA client for a HEOS speaker's MediaRenderer.
// HEOS speakers expose the renderer on port 60006; the HEOS CLI (port 1255) is
// not available on every firmware, UPnP is.

const DESCRIPTION_PATH = '/upnp/desc/aios_device/aios_device.xml';
const TIMEOUT_MS = 5000;

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** "1:02:03" / "00:01:23.000" -> seconds; anything else (e.g. NOT_IMPLEMENTED) -> 0 */
export function parseTime(value) {
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value ?? '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/**
 * DIDL-Lite metadata so the HEOS app / speaker shows title, artist and cover.
 */
export function buildDidl({ id, url, mimeType, title, artist, album, artUrl, duration }) {
  const protocolInfo = `http-get:*:${mimeType}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01500000000000000000000000000000`;
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
    + `<item id="ytcast-${escapeXml(id)}" parentID="0" restricted="1">`
    + `<dc:title>${escapeXml(title)}</dc:title>`
    + (artist ? `<dc:creator>${escapeXml(artist)}</dc:creator><upnp:artist>${escapeXml(artist)}</upnp:artist>` : '')
    + (album ? `<upnp:album>${escapeXml(album)}</upnp:album>` : '')
    + (artUrl ? `<upnp:albumArtURI>${escapeXml(artUrl)}</upnp:albumArtURI>` : '')
    + '<upnp:class>object.item.audioItem.musicTrack</upnp:class>'
    + `<res protocolInfo="${escapeXml(protocolInfo)}"${duration ? ` duration="${formatTime(duration)}.000"` : ''}>${escapeXml(url)}</res>`
    + '</item></DIDL-Lite>';
}

export class HeosRenderer {
  #host;
  #baseUrl;
  #controlUrls = {};
  name = 'HEOS';

  constructor(host, port = 60006) {
    this.#host = host;
    this.#baseUrl = `http://${host}:${port}`;
  }

  get host() {
    return this.#host;
  }

  /** Reads the device description: speaker name and renderer control URLs. */
  async init() {
    const res = await fetch(this.#baseUrl + DESCRIPTION_PATH, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`HEOS device description at ${this.#baseUrl}${DESCRIPTION_PATH}: HTTP ${res.status}`);
    }
    const xml = await res.text();
    const name = /<friendlyName>([^<]*)<\/friendlyName>/.exec(xml);
    if (name) {
      this.name = unescapeXml(name[1]);
    }
    for (const service of xml.matchAll(/<service>([\s\S]*?)<\/service>/g)) {
      const type = /<serviceType>urn:schemas-upnp-org:service:(\w+):1<\/serviceType>/.exec(service[1]);
      const control = /<controlURL>([^<]+)<\/controlURL>/.exec(service[1]);
      // The MediaRenderer's services come first; keep the first match per type.
      if (type && control && !this.#controlUrls[type[1]]) {
        this.#controlUrls[type[1]] = control[1];
      }
    }
    for (const required of ['AVTransport', 'RenderingControl']) {
      if (!this.#controlUrls[required]) {
        throw new Error(`HEOS device at ${this.#host} has no ${required} service`);
      }
    }
  }

  async #call(service, action, args = {}) {
    const body = Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('');
    const envelope = '<?xml version="1.0" encoding="utf-8"?>'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
      + `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(this.#baseUrl + this.#controlUrls[service], {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"`
      },
      body: envelope,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await res.text();
    if (!res.ok) {
      const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1];
      const desc = /<errorDescription>([^<]*)<\/errorDescription>/.exec(text)?.[1];
      throw new Error(`UPnP ${action} failed: HTTP ${res.status}${code ? ` (error ${code}${desc ? `: ${desc}` : ''})` : ''}`);
    }
    const result = {};
    for (const m of text.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) {
      result[m[1]] = unescapeXml(m[2]);
    }
    return result;
  }

  setUri(uri, metadata) {
    return this.#call('AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: metadata });
  }

  play() {
    return this.#call('AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
  }

  pause() {
    return this.#call('AVTransport', 'Pause', { InstanceID: 0 });
  }

  stop() {
    return this.#call('AVTransport', 'Stop', { InstanceID: 0 });
  }

  seek(seconds) {
    return this.#call('AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: formatTime(seconds) });
  }

  /** @returns {Promise<string>} PLAYING | PAUSED_PLAYBACK | STOPPED | TRANSITIONING | NO_MEDIA_PRESENT */
  async getTransportState() {
    return (await this.#call('AVTransport', 'GetTransportInfo', { InstanceID: 0 })).CurrentTransportState;
  }

  /** @returns {Promise<{trackUri: string, position: number, duration: number}>} */
  async getPositionInfo() {
    const r = await this.#call('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
    return { trackUri: r.TrackURI ?? '', position: parseTime(r.RelTime), duration: parseTime(r.TrackDuration) };
  }

  /** @returns {Promise<{level: number, muted: boolean}>} */
  async getVolume() {
    const [volume, mute] = await Promise.all([
      this.#call('RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }),
      this.#call('RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' })
    ]);
    return { level: Number(volume.CurrentVolume), muted: mute.CurrentMute === '1' };
  }

  setVolume(level) {
    return this.#call('RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(level) });
  }

  setMute(muted) {
    return this.#call('RenderingControl', 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: muted ? 1 : 0 });
  }
}
