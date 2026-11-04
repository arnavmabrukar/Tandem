import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function runnerDownload(): Plugin {
  const source = new URL('../../agent-integrations/runner/tandem_runner.py', import.meta.url);
  const fileName = 'downloads/tandem_runner.py';
  return {
    name: 'tandem-runner-download',
    // Package the canonical script with the site; no private-repository access
    // or separately maintained copy is required on the user's machine.
    buildStart() { this.addWatchFile(source.pathname); },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${fileName}`) return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="tandem_runner.py"');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(req.method === 'HEAD' ? undefined : readFileSync(source));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), runnerDownload()],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
