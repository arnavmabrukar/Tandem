import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

export default mergeConfig(
  base,
  defineConfig({
    envDir: false,
    define: Object.fromEntries(
      ['VITE_API_BASE_URL', 'VITE_AUTH0_DOMAIN', 'VITE_AUTH0_CLIENT_ID', 'VITE_AUTH0_AUDIENCE'].map(
        (key) => [`import.meta.env.${key}`, JSON.stringify('')],
      ),
    ),
  }),
);
