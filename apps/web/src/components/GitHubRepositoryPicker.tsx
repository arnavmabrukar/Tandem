import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSession } from '../auth/session';
import type { GitHubRepository } from '../types/domain';
import { Button } from './ui/button';
import { ErrorNotice, Field } from './common';

export function GitHubRepositoryPicker({ onSelect }: {
  onSelect: (repo: GitHubRepository | null, installationId: number) => void;
}) {
  const { api, user } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const completed = useRef(false);
  const [installationId, setInstallationId] = useState(0);
  const [accountPage, setAccountPage] = useState(1);
  const [repoPage, setRepoPage] = useState(1);
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const accounts = useQuery({ queryKey: ['github-accounts', user?.id, accountPage],
    queryFn: () => api.githubInstallations(accountPage), retry: false });
  const repos = useQuery({ queryKey: ['github-repos', user?.id, installationId, repoPage],
    queryFn: () => api.githubRepositories(installationId, repoPage), enabled: installationId > 0, retry: false });
  const connect = useMutation({ mutationFn: () => api.connectGitHub(), retry: false,
    onSuccess: ({url}) => { window.location.assign(url); } });
  const finish = useMutation({ mutationFn: ({code, state}: {code: string; state: string}) => api.completeGitHub(code, state),
    retry: false, onSuccess: () => { void accounts.refetch(); } });
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('github_state') || completed.current) return;
    completed.current = true;
    const code = params.get('github_code') ?? '';
    const state = params.get('github_state') ?? '';
    // Remove the single-use authorization code from browser history immediately.
    navigate('/projects/new', {replace: true});
    finish.mutate({code, state});
  }, [location.search]);
  function clear() { setSelected(0); onSelect(null, 0); }
  return <div>
    <p>Connect GitHub, choose an account, then select the repository to track.</p>
    <Button type="button" variant="outline" disabled={connect.isPending || finish.isPending}
      onClick={() => connect.mutate()}>{finish.isPending ? 'Connecting…' : 'Connect GitHub'}</Button>
    <ErrorNotice error={connect.error || finish.error} />
    <ErrorNotice error={accounts.error} />
    {accounts.data && <>
      <p><a href={accounts.data.installUrl} target="_blank" rel="noreferrer">Choose repositories GitHub allows Tandem to access</a></p>
      <Button type="button" variant="ghost" onClick={() => {clear(); void accounts.refetch(); if (installationId > 0) void repos.refetch();}}>Refresh repositories</Button>
      <Field label="GitHub account"><select value={installationId} onChange={e => {
        clear(); setInstallationId(Number(e.target.value)); setRepoPage(1);
      }}><option value={0}>Choose an account</option>{accounts.data.items.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      {accounts.data.items.length === 0 && <p>Install Tandem using the link above, then refresh.</p>}
      <div className="button-row">
        <Button type="button" variant="ghost" disabled={accountPage === 1} onClick={() => {clear(); setInstallationId(0); setAccountPage(p => p - 1);}}>Previous accounts</Button>
        <Button type="button" variant="ghost" disabled={!accounts.data.hasMore} onClick={() => {clear(); setInstallationId(0); setAccountPage(p => p + 1);}}>More accounts</Button>
      </div>
    </>}
    {installationId > 0 && <>
      {repos.isPending && <p role="status">Loading repositories…</p>}
      <ErrorNotice error={repos.error} />
      <Field label="Filter this page"><input value={search} onChange={e => setSearch(e.target.value)} /></Field>
      <Field label="Repository"><select required value={selected} onChange={e => {
        const id = Number(e.target.value); setSelected(id);
        onSelect(repos.data?.items.find(r => r.id === id) ?? null, installationId);
      }}><option value={0}>Choose a repository</option>{repos.data?.items.filter(r => r.fullName.toLowerCase().includes(search.toLowerCase())).map(r => <option key={r.id} value={r.id}>{r.fullName}</option>)}</select></Field>
      <div className="button-row">
        <Button type="button" variant="ghost" disabled={repoPage === 1} onClick={() => {clear(); setRepoPage(p => p - 1);}}>Previous repositories</Button>
        <Button type="button" variant="ghost" disabled={!repos.data?.hasMore} onClick={() => {clear(); setRepoPage(p => p + 1);}}>More repositories</Button>
      </div>
    </>}
  </div>;
}
