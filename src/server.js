import { Readable } from 'node:stream';
import express from 'express';
import { isVideoId } from './media.js';

/**
 * HTTP server the speaker pulls audio and cover art from.
 * Files are served with Content-Length and Range support so the speaker can
 * seek and resume after long pauses on its own.
 */
export function startMediaServer({ library, port, logger }) {
  const app = express();

  app.get('/media/:id.:ext', async (req, res) => {
    const track = isVideoId(req.params.id) ? await library.ready(req.params.id) : null;
    if (!track || track.ext !== req.params.ext) {
      res.sendStatus(404);
      return;
    }
    logger.debug(`[heos-ytcast] ${req.method} ${req.url} range=${req.headers.range ?? '-'}`);
    res.sendFile(track.file, { headers: { 'Content-Type': track.mimeType } }, (error) => {
      if (error && !res.headersSent) {
        res.sendStatus(404);
      }
    });
  });

  app.get('/art/:id.jpg', async (req, res) => {
    if (!isVideoId(req.params.id)) {
      res.sendStatus(404);
      return;
    }
    try {
      const upstream = await fetch(`https://i.ytimg.com/vi/${req.params.id}/hqdefault.jpg`, { signal: AbortSignal.timeout(10_000) });
      if (!upstream.ok || !upstream.body) {
        res.sendStatus(404);
        return;
      }
      res.set('Content-Type', 'image/jpeg');
      Readable.fromWeb(upstream.body).pipe(res);
    }
    catch {
      res.sendStatus(502);
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}
