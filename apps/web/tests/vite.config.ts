import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

// Test-only authentication substitute. Normal dev/build never load this configuration.
export default mergeConfig(
  base,
  defineConfig({
    envDir: false,
    resolve: {
      alias: {
        '@auth0/auth0-react': fileURLToPath(new URL('./support/auth0.tsx', import.meta.url)),
      },
    },
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://api.tandem.test'),
      'import.meta.env.VITE_AUTH0_DOMAIN': JSON.stringify('tandem.auth0.com'),
      'import.meta.env.VITE_AUTH0_CLIENT_ID': JSON.stringify('test-client'),
      'import.meta.env.VITE_AUTH0_AUDIENCE': JSON.stringify('https://api.tandem.test'),
    },
  }),
);
