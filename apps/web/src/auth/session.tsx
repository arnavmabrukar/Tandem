import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { createApiClient } from '../api/client';
import { appBaseUrl, configuration, safeReturnTo, type AppConfig } from '../config';
import type { DashboardApi, User } from '../types/domain';
import { ConfigurationPage } from '../pages/ConfigurationPage';

const SessionContext = createContext<{
  user: User | null;
  authenticated: boolean;
  canSignOut: boolean;
  loading: boolean;
  error: Error | null;
  api: DashboardApi;
  signIn: (returnTo?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => void;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  if (!configuration.config) return <ConfigurationPage errors={configuration.errors} />;
  const config = configuration.config;
  return (
    <Auth0Provider
      domain={config.auth0Domain}
      clientId={config.auth0ClientId}
      cacheLocation="memory"
      authorizationParams={{
        redirect_uri: appBaseUrl(),
        audience: config.auth0Audience,
        scope: 'openid profile email',
      }}
      onRedirectCallback={(state) => {
        window.history.replaceState({}, document.title, appBaseUrl());
        navigate(safeReturnTo(state?.returnTo), { replace: true });
      }}
    >
      <ConnectedSession config={config}>{children}</ConnectedSession>
    </Auth0Provider>
  );
}
function ConnectedSession({ children, config }: { children: ReactNode; config: AppConfig }) {
  const auth = useAuth0();
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);
  const expire = useCallback(() => {
    setExpired(true);
    void queryClient.cancelQueries({ queryKey: ['workspace'] });
    queryClient.removeQueries({ queryKey: ['workspace'] });
  }, [queryClient]);
  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: config.apiBaseUrl,
        getAccessToken: () => auth.getAccessTokenSilently(),
        onUnauthorized: expire,
      }),
    [config.apiBaseUrl, auth.getAccessTokenSilently, expire],
  );
  const account = useQuery({
    queryKey: ['session', auth.user?.sub],
    queryFn: ({ signal }) => api.getCurrentUser(signal),
    enabled: auth.isAuthenticated && !expired,
    retry: false,
    staleTime: 30_000,
  });
  const signIn = async (returnTo = '/') => {
    setActionError(null);
    try {
      await auth.loginWithRedirect({
        appState: { returnTo: safeReturnTo(returnTo) },
        authorizationParams: expired ? { prompt: 'login' } : undefined,
      });
    } catch {
      setActionError(
        new Error('Sign-in could not be started. Check Auth0 configuration and try again.'),
      );
    }
  };
  const signOut = async () => {
    setExpired(true);
    queryClient.clear();
    setActionError(null);
    try {
      await auth.logout({ logoutParams: { returnTo: appBaseUrl() } });
    } catch {
      setActionError(
        new Error('Sign-out could not finish. Retry sign-out before sharing this browser.'),
      );
    }
  };
  const error =
    actionError ??
    (expired
      ? new Error('Your session is no longer authorized. Sign in again.')
      : auth.error
        ? new Error(
            'Authentication failed. Check the Auth0 application settings and retry sign-in.',
          )
        : account.error);
  return (
    <SessionContext.Provider
      value={{
        user: expired || !auth.isAuthenticated || account.isError ? null : (account.data ?? null),
        authenticated: auth.isAuthenticated && !expired,
        canSignOut: auth.isAuthenticated,
        loading: auth.isLoading || (auth.isAuthenticated && !expired && account.isPending),
        error,
        api,
        signIn,
        signOut,
        refresh: () => {
          void account.refetch();
        },
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Missing session provider');
  return session;
}
