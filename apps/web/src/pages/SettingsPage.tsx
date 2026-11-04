import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState, type FormEvent } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { Project } from '../types/domain';
import { ProjectSetupPage } from './ProjectSetupPage';
import { ConnectionsPage } from './ConnectionsPage';
import { useSession } from '../auth/session';
import { ErrorNotice, Field, PageHeader } from '../components/common';
import { GitHubConnectionPanel } from '../components/GitHubConnection';
import { Button } from '../components/ui/button';
import { McpConnectionList } from './McpOAuthPage';

export function SettingsPage({ project, userOnly = false }: { project: Project | null; userOnly?: boolean }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const section = params.get('section') ?? 'profile';
  useLayoutEffect(() => {
    // Query parameters work with the app's hash router and repeated section clicks.
    const target = document.getElementById(section);
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  }, [section, location.key, project?.id]);
  const { user, api, signOut } = useSession();
  const [confirmation, setConfirmation] = useState('');
  const deletion = useMutation({
    mutationFn: () => api.deleteAccount(confirmation),
    onSuccess: () => signOut(),
  });
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(user!.name);
  const [removalCopied, setRemovalCopied] = useState(false);
  const [removalCopyFailed, setRemovalCopyFailed] = useState(false);
  // Match the one-command install location; never remove the project clone.
  const removeRunnerCommand = 'rm -f -- "$HOME/Downloads/tandem_runner.py" "$HOME/.local/share/tandem/tandem_runner.py"';
  const name = draft.trim();

  const save = useMutation({
    mutationFn: () => api.updateProfile(name),
    onSuccess: async () => {
      setDraft(name);
      // Names also appear on project members and agents, so reload both from the server.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['session'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      ]);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name && name !== user!.name) save.mutate();
  };

  return (
    <>
      <PageHeader title={userOnly ? 'User settings' : 'Settings'} description={userOnly ? 'Manage your profile, sign-ins and account access.' : 'Manage your account, project and agent connections in one place.'} />

      <section id="profile" tabIndex={-1} className="panel narrow-panel settings-section">
        <h2>Profile</h2>
        <form onSubmit={submit}>
          <Field
            label="Display name"
            hint="Shown to people in your projects. Past activity keeps the name used at the time."
          >
            <input
              value={draft}
              maxLength={80}
              autoComplete="name"
              onChange={(event) => {
                setDraft(event.target.value);
                save.reset();
              }}
            />
          </Field>
          <ErrorNotice error={save.error} />
          <div className="row">
            <Button type="submit" disabled={!name || name === user!.name || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save name'}
            </Button>
            {save.isSuccess && (
              <span role="status" className="settings-saved">
                Name saved
              </span>
            )}
          </div>
        </form>
        <dl className="details-grid profile-email">
          <dt>Email</dt>
          <dd className="row wrap">
            {user!.email ?? 'No email on this sign-in'}
            {user!.email && (
              <span className={`badge ${user!.emailVerified ? 'badge-approved' : 'badge-pending'}`}>
                {user!.emailVerified ? 'Verified' : 'Not verified'}
              </span>
            )}
          </dd>
        </dl>
        <h3>Sign-in methods</h3>
        <ul>{user!.signIns?.map((signIn, index) => <li key={index}>{signIn.method}{signIn.current ? ' · Current sign-in' : ''}</li>) ?? <li>Your connected sign-in provider</li>}</ul>
        <p className="small muted">Manage your email address and password with your sign-in provider. Changing your display name here only changes your Tandem profile.</p>
        {user!.email && !user!.emailVerified && (
          <p className="notice" role="status">
            Verify this email to combine this account with other sign-ins that use it. Open the
            verification email, then log out and sign in again.
          </p>
        )}
      </section>

      <div id="github" tabIndex={-1} className="settings-section"><GitHubConnectionPanel /></div>

      <section id="connected-agents" tabIndex={-1} className="panel narrow-panel settings-section">
        <h2>Connected agents</h2>
        <p className="muted">
          See which agent clients can reach your projects, and disconnect them.
        </p>
        <McpConnectionList />
      </section>
      <section id="local-runner" tabIndex={-1} className="panel narrow-panel settings-section" aria-label="Remove local runner">
        <h2>Remove local runner</h2>
        <p>First stop each running worker with Ctrl+C in its terminal. Then run this command on the Mac or Linux machine where you used the one-command installer:</p>
        <pre className="oauth-code">{removeRunnerCommand}</pre>
        <Button variant="outline" onClick={async () => {
          try {
            await navigator.clipboard.writeText(removeRunnerCommand);
            setRemovalCopied(true); setRemovalCopyFailed(false);
          } catch { setRemovalCopyFailed(true); }
        }}>{removalCopied ? 'Copied' : 'Copy removal command'}</Button>
        {removalCopyFailed && <p role="alert">Clipboard unavailable. Select and copy the command above.</p>}
        <p className="small muted">This deletes the runner from Downloads and its previous install location. It does not stop an already running worker, remove project clones or managed workspaces, or revoke agent access. You can download it again from agent setup.</p>
      </section>
      {!userOnly && project && <ProjectSetupPage key={project.id} project={project} embedded />}
      {!userOnly && <div id="connection-guide" tabIndex={-1} className="settings-section"><ConnectionsPage /></div>}
      <section id="delete-account" tabIndex={-1} className="panel narrow-panel danger-zone settings-section">
        <h2>Delete your Tandem account</h2>
        <p>Removes your profile and project memberships, disconnects GitHub, and revokes your agents and their tokens. Transfer ownership or delete any projects where you are the only owner first.</p>
        <p className="small muted">Shared project history, including past messages and activity, remains. Your Google, GitHub and Auth0 accounts are not deleted. Signing in again creates a new Tandem account without your previous access.</p>
        <form onSubmit={event => { event.preventDefault(); if (confirmation === 'DELETE') deletion.mutate(); }}>
          <Field label="Type DELETE to confirm" hint="This cannot be undone."><input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></Field>
          <ErrorNotice error={deletion.error} />
          <Button variant="destructive" type="submit" disabled={confirmation !== 'DELETE' || deletion.isPending || deletion.isSuccess}>{deletion.isPending ? 'Deleting…' : 'Delete my account'}</Button>
        </form>
      </section>
    </>
  );
}
