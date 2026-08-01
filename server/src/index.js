import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || '0.0.0.0';

createApp().listen(port, host, () => {
  console.log(`Shirt Designs studio server on http://localhost:${port}`);

  // A phone cannot reach "localhost", so print the LAN address the Expo app
  // should be pointed at.
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  On this network:  http://${address.address}:${port}`);
      }
    }
  }
});
