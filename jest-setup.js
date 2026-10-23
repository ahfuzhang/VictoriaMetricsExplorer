// Jest setup provided by Grafana scaffolding. It assumes a browser (jsdom) environment, so suites
// that run with `@jest-environment node` skip it.
if (typeof window !== 'undefined') {
  require('./.config/jest-setup');

  // jsdom lacks the streams, compression and UUID APIs the favorites code uses; Node has them.
  const web = require('stream/web');
  Object.assign(global, {
    ReadableStream: web.ReadableStream,
    CompressionStream: web.CompressionStream,
    DecompressionStream: web.DecompressionStream,
  });
  if (!global.crypto.randomUUID) {
    global.crypto.randomUUID = require('crypto').randomUUID;
  }
}
