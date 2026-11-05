import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState, type FormEvent } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { Project } from '../types/domain';
import { ProjectSetupPage } from './ProjectSetupPage';
import { useSession } from '../auth/session';
import { useMcpDiscovery } from '../components/AgentOAuthSetup';
import { ErrorNotice, Field, PageHeader } from '../components/common';
import { GitHubConnectionPanel } from '../components/GitHubConnection';
import { Button } from '../components/ui/button';
import { McpConnectionList } from './McpOAuthPage';

function ConnectIdeAgentGuide() {
  const discovery = useMcpDiscovery();
  return (
    <div className="connect-ide-guide">
      <h3>Connect an IDE agent with OAuth</h3>
      <p>Add this remote MCP URL in your IDE, then choose its sign-in or authenticate action:</p>
      {discovery.data && <p><code>{discovery.data}</code></p>}
      {discovery.isPending && <p role="status">Checking MCP server…</p>}
      <ErrorNotice error={discovery.error} retry={() => void discovery.refetch()} />
      <p>Sign in to Tandem in the browser, choose your agent and project, and allow the connection.
        Choose an existing agent or create one during sign-in. Use Connect your IDE on the Agents page for guided setup.</p>
    </div>
  );
}

export function SettingsPage({ project, userOnly = false }: { project: Project | null; userOnly?: boolean }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const section = params.get('section') ?? (userOnly ? 'profile' : 'setup-details');
  useLayoutEffect(() => {
    // Query parameters work with the app's hash router and repeated section clicks.
    const target = document.getElementById(section);
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  }, [section, location.key, project?.id]);
  const { user, api } = useSession();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(user!.name);
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
      <PageHeader title={userOnly ? 'User settings' : 'Project Settings'} description={userOnly ? 'Manage your profile, GitHub account and connected agents.' : 'Manage your project, people and automation.'} />

      {userOnly && <>
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
        <ConnectIdeAgentGuide />
      </section>
      </>}
      {!userOnly && project && <ProjectSetupPage key={project.id} project={project} embedded />}    </>
  );
}
