export interface AppConfig {
  apiBaseUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
  auth0Audience: string;
}
export type ConfigResult = { config: AppConfig; errors: [] } | { config: null; errors: string[] };

export function readConfig(env: Record<string, string | undefined>): ConfigResult {
  const values = {
    apiBaseUrl: env.VITE_API_BASE_URL?.trim() ?? '',
    auth0Domain: env.VITE_AUTH0_DOMAIN?.trim() ?? '',
    auth0ClientId: env.VITE_AUTH0_CLIENT_ID?.trim() ?? '',
    auth0Audience: env.VITE_AUTH0_AUDIENCE?.trim() ?? '',
  };
  const errors: string[] = [];
  for (const key of [
    'VITE_API_BASE_URL',
    'VITE_AUTH0_DOMAIN',
    'VITE_AUTH0_CLIENT_ID',
    'VITE_AUTH0_AUDIENCE',
  ]) {
    if (!env[key]?.trim()) errors.push(`${key} is missing.`);
  }
  if (values.apiBaseUrl) {
    try {
      const url = new URL(values.apiBaseUrl);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error();
      values.apiBaseUrl = url.origin;
    } catch {
      errors.push(
        'VITE_API_BASE_URL must be an HTTPS origin (HTTP is allowed only on localhost), without a path, credentials, query, or fragment.',
      );
    }
  }
  if (
    values.auth0Domain &&
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(values.auth0Domain)
  )
    errors.push('VITE_AUTH0_DOMAIN must be your Auth0 hostname, without https:// or a path.');
  return errors.length ? { config: null, errors } : { config: values, errors: [] };
}

export const configuration = readConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_AUTH0_DOMAIN: import.meta.env.VITE_AUTH0_DOMAIN,
  VITE_AUTH0_CLIENT_ID: import.meta.env.VITE_AUTH0_CLIENT_ID,
  VITE_AUTH0_AUDIENCE: import.meta.env.VITE_AUTH0_AUDIENCE,
});

export const appBaseUrl = () => `${window.location.origin}${window.location.pathname}`;
export function safeReturnTo(value: unknown) {
  return typeof value === 'string' && /^\/projects(?:\/|$)/.test(value) && !/[\\\r\n]/.test(value)
    ? value
    : '/';
}
