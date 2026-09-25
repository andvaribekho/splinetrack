// Worker para trazar la imagen sin bloquear la interfaz.
import { traceImage } from './trace.js';

self.onmessage = (e) => {
  const { id, image, opts } = e.data;
  try {
    const res = traceImage(image, opts);
    self.postMessage({ id, ok: true, main: res.main, alts: res.alts, info: res.info });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};
