import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useSession } from '../auth/session';
import type { GitHubConnection } from '../types/domain';
import { ErrorNotice } from './common';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';

export function useGitHubConnection(enabled = true) {
  const { api, user } = useSession();
  return useQuery({ queryKey: ['github-connection', user?.id], queryFn: () => api.githubConnection(), enabled });
}

function GitHubMark() {
  return (
    <svg className="github-mark" viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function StatusRow({ title, detail, badge, children }: {
  title: ReactNode;
  detail?: ReactNode;
  badge?: { text: string; tone: 'approved' | 'pending' };
  children?: ReactNode;
}) {
  return (
    <div className="github-status">
      <GitHubMark />
      <div className="github-status-text">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </div>
      {badge && <span className={`badge badge-${badge.tone}`}>{badge.text}</span>}
      {children}
    </div>
  );
}

const linkState = (data: GitHubConnection) =>
  data.connected ? 'linked' : data.login ? 'expired' : 'unlinked';

const githubSettings = '/settings/user?section=github';
const returnKey = (userId: string, state: string) => `tandem:github-return:${userId}:${state}`;

function useConnectGitHub(returnTo: '/projects/new' | typeof githubSettings) {
  const { api, user } = useSession();
  return useMutation({
    mutationFn: () => api.connectGitHub(),
    onSuccess: ({ url }) => {
      // Keep navigation separate from OAuth validation, which stays on the server.
      // Bind the destination to this account and authorization attempt in this tab.
      const state = new URL(url).searchParams.get('state');
      if (state && user) {
        try { sessionStorage.setItem(returnKey(user.id, state), returnTo); } catch { /* Storage may be disabled. */ }
      }
      window.location.assign(url);
    },
  });
}

export function GitHubLinkStatus({ query }: { query: UseQueryResult<GitHubConnection> }) {
  const connect = useConnectGitHub('/projects/new');
  if (query.isPending) return <StatusRow title={<span role="status">Checking GitHub account…</span>} />;
  if (!query.data) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const { login } = query.data;
  const state = linkState(query.data);
  if (state === 'linked') {
    return (
      <StatusRow
        title={<code>{login}</code>}
        detail="GitHub account linked to Tandem"
        badge={{ text: 'Linked', tone: 'approved' }}
      >
        <Button asChild variant="ghost" size="sm"><Link to={githubSettings}>Manage</Link></Button>
      </StatusRow>
    );
  }
  return (
    <><StatusRow
      title={state === 'expired' ? <>Link to <code>{login}</code> expired</> : 'No GitHub account linked'}
      detail={state === 'expired'
        ? 'Reconnect GitHub to see your repositories.'
        : 'Link your GitHub account to see your repositories.'}
    >
      <Button type="button" size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
        {connect.isPending ? 'Opening GitHub…' : state === 'expired' ? 'Reconnect GitHub' : 'Connect GitHub'}
      </Button>
    </StatusRow>
    <ErrorNotice error={connect.error} /></>
  );
}

// The Settings panel, and the page GitHub returns to after authorization.
export function GitHubConnectionPanel() {
  const { api, user } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const completed = useRef(false);
  const query = useGitHubConnection();
  const connect = useConnectGitHub(githubSettings);
  const finish = useMutation({
    mutationFn: ({ code, state }: { code: string; state: string }) => api.completeGitHub(code, state),
    onSuccess: async (_, { state }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['github-connection'] }),
        queryClient.invalidateQueries({ queryKey: ['github-accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['github-repos'] }),
      ]);
      let returnTo = githubSettings;
      if (user) {
        try {
          const key = returnKey(user.id, state);
          // Only the fixed Create project destination is accepted from browser storage.
          if (sessionStorage.getItem(key) === '/projects/new') returnTo = '/projects/new';
          sessionStorage.removeItem(key);
        } catch { /* Fall back to GitHub account settings. */ }
      }
      navigate(returnTo, { replace: true });
    },
  });
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('github_state') || completed.current) return;
    completed.current = true;
    // Remove the single-use authorization code from browser history immediately.
    navigate(githubSettings, { replace: true });
    finish.mutate({ code: params.get('github_code') ?? '', state: params.get('github_state') ?? '' });
  }, [location.search]);

  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => api.disconnectGitHub(),
    onSuccess: async () => {
      setConfirming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['github-connection'] }),
        queryClient.invalidateQueries({ queryKey: ['github-accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['github-repos'] }),
      ]);
    },
  });
  const busy = connect.isPending || finish.isPending || disconnect.isPending;
  const state = query.data && linkState(query.data);
  return (
    <section className="panel narrow-panel" aria-labelledby="settings-github">
      <h2 id="settings-github">GitHub</h2>
      <p className="muted">Link your GitHub account to import repositories as Tandem projects.</p>
      {finish.isPending && <StatusRow title={<span role="status">Linking GitHub account…</span>} />}
      {!finish.isPending && query.isPending && (
        <StatusRow title={<span role="status">Checking GitHub account…</span>} />
      )}
      {!finish.isPending && state === 'linked' && (
        <StatusRow
          title={<code>{query.data!.login}</code>}
          detail="Linked to this Tandem account"
          badge={{ text: 'Linked', tone: 'approved' }}
        />
      )}
      {!finish.isPending && state === 'expired' && (
        <StatusRow
          title={<>Link to <code>{query.data!.login}</code> expired</>}
          detail="Reconnect GitHub to import repositories."
          badge={{ text: 'Expired', tone: 'pending' }}
        />
      )}
      {!finish.isPending && state === 'unlinked' && (
        <StatusRow title="No GitHub account linked" detail="You'll need one to create a project." />
      )}
      <ErrorNotice error={query.error || connect.error || finish.error} />
      {query.data && (
        <div className="row wrap">
          {state === 'linked' ? (
            <>
              {query.data.installUrl && (
                <Button asChild variant="outline">
                  <a href={query.data.installUrl} target="_blank" rel="noreferrer">
                    Manage repository access <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </Button>
              )}
              <Button variant="destructive" disabled={busy} onClick={() => { disconnect.reset(); setConfirming(true); }}>
                Disconnect
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => connect.mutate()}>
                {connect.isPending ? 'Opening GitHub…' : state === 'expired' ? 'Reconnect GitHub' : 'Connect GitHub'}
              </Button>
              {state === 'expired' && (
                <Button variant="destructive" disabled={busy} onClick={() => { disconnect.reset(); setConfirming(true); }}>
                  Disconnect
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <Modal
        open={confirming}
        onOpenChange={(open) => { if (!disconnect.isPending && !open) setConfirming(false); }}
        title="Disconnect GitHub?"
        description="Tandem will forget your GitHub link. You won't be able to import repositories until you connect again."
      >
        <p>
          Projects you already imported keep working. This doesn’t remove the Tandem GitHub App
          from your GitHub account; do that from GitHub’s settings if you want to revoke it
          there too.
        </p>
        <ErrorNotice error={disconnect.error} />
        <div className="row end">
          <Button variant="outline" disabled={disconnect.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect GitHub'}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
