import { createContext, useContext, useState, type ReactNode } from 'react';

// Browser tests isolate the identity provider, while exercising the real HTTP client.
// This module is reachable only through tests/vite.config.ts, never production imports.
const getAccessTokenSilently = async () => 'test-only-access-token';
interface Auth {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: undefined;
  user: { sub: string } | undefined;
  getAccessTokenSilently: typeof getAccessTokenSilently;
  loginWithRedirect: (options?: { appState?: { returnTo?: string } }) => Promise<void>;
  logout: () => Promise<void>;
}
const Context = createContext<Auth | null>(null);
export function Auth0Provider({
  children,
  onRedirectCallback,
}: {
  children: ReactNode;
  onRedirectCallback?: (state?: { returnTo?: string }) => void;
}) {
  const [authenticated, setAuthenticated] = useState(!location.search.includes('test-auth=off'));
  return (
    <Context.Provider
      value={{
        isAuthenticated: authenticated,
        isLoading: false,
        error: undefined,
        user: authenticated ? { sub: 'auth0|test-user' } : undefined,
        getAccessTokenSilently,
        loginWithRedirect: async (options) => {
          setAuthenticated(true);
          onRedirectCallback?.(options?.appState);
        },
        logout: async () => {
          location.href = '/?test-auth=off#/signin';
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth0() {
  return useContext(Context)!;
}
