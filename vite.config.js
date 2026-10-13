import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR and getUserMedia need a secure context. http://localhost already
// counts as one, so plain HTTP is the default for desktop work. A headset on
// the LAN hits the machine by IP, which is not secure, so for that run
//   HTTPS=1 npm run client
// and accept the self-signed certificate once in the headset browser.
// The API server (Express + Socket.IO) runs on :3000 and is proxied here, so
// the client only ever talks to one origin.
const useHttps = process.env.HTTPS === '1';
const api = `http://localhost:${process.env.API_PORT || 3000}`;   // the test harness runs a second API on another port
const port = Number(process.env.VITE_PORT || 5173);

export default defineConfig({
  root: 'client',
  plugins: useHttps ? [basicSsl()] : [],
  server: {
    port,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/audio': { target: api, changeOrigin: true },
      '/models': { target: api, changeOrigin: true },
      '/socket.io': { target: api, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
