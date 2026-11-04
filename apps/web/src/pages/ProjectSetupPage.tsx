import { GitHubLinkStatus, useGitHubConnection } from '../components/GitHubConnection';
import { GitHubRepositoryPicker } from '../components/GitHubRepositoryPicker';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, GitBranch } from 'lucide-react';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { initials, label, roleFor, roles, type Project, type Role } from '../types/domain';
import { Badge, ErrorNotice, Field, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';

const roleHelp: Record<Role, string> = {
  owner: 'Owners can do everything: edit the project, invite people, manage agents and delete it.',
  reviewer: 'Reviewers create and cancel tasks, message agents, and approve or reject work.',
  viewer: 'Viewers can see the project but cannot change anything.',
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function ProjectSetupPage({ project }: { project: Project | null }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const owner = !project || roleFor(project, user!.id) === 'owner';
  const [selection, setSelection] = useState<{repositoryId: number; installationId: number} | null>(null);
  const [branch, setBranch] = useState(project?.trackedBranch ?? '');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const removal = useAction(project);
  const github = useGitHubConnection(!project);
  const [name, setName] = useState(project?.name ?? '');
  const [repo, setRepo] = useState(project?.repository ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [formVersion, setFormVersion] = useState(project?.version ?? null);
  const save = useAction(project ? { ...project, version: formVersion! } : null);
  const delegate = useAction(project);
  const invite = useAction(project);
  const revoke = useAction(project);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('reviewer');
  const [saved, setSaved] = useState(false);
  const changed = !!project && project.version !== formVersion;
  const trimmedName = name.trim();
  const dirty =
    !!project && (description !== project.description || trimmedName !== project.name);
  function loadLatest() {
    if (project) {
      setName(project.name);
      setRepo(project.repository);
      setDescription(project.description);
      setFormVersion(project.version);
      setSaved(false);
      save.reset();
    }
  }

  // Importing a repository keeps its original form. Everything below is the settings view.
  if (!project) {
    return (
      <>
        <PageHeader
          title="Import GitHub repository"
          description="Choose a repository to create your Tandem project."
        />
        <section className="panel narrow-panel">
          <GitHubLinkStatus query={github} />
          {github.data?.connected && <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (!selection) return;
                const result = await save.mutateAsync({
                  type: 'create-project', name, repository: repo, description,
                  githubRepositoryId: selection.repositoryId,
                  githubInstallationId: selection.installationId, trackedBranch: branch,
                });
                navigate(`/projects/${result.projectId}/activity`);
              } catch {
                /* Keep drafts and show errors. */
              }
            }}
          >
            <fieldset disabled={save.isPending}>
              <GitHubRepositoryPicker onSelect={(repository, installationId) => {
                setSelection(repository ? {repositoryId: repository.id, installationId} : null);
                setRepo(repository?.fullName ?? ''); setName(repository?.name.slice(0, 80) ?? '');
                setBranch(repository?.defaultBranch ?? ''); setDescription(repository?.description.slice(0, 1000) ?? '');
              }} />
              {selection && <details>
                <summary>Optional settings</summary>
                <Field label="Branch to track" hint="Defaults to the repository’s default branch. The backend checks that this branch exists.">
                  <input required maxLength={255} value={branch} onChange={e => setBranch(e.target.value)} />
                </Field>
                <Field label="Description">
                  <textarea
                    maxLength={1000}
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setSaved(false);
                    }}
                  />
                </Field>
              </details>}
              <Button type="submit" disabled={!selection || !branch}>
                {save.isPending ? 'Importing…' : 'Import repository'}
              </Button>
            </fieldset>
            <ErrorNotice error={save.error} />
          </form>}
        </section>
      </>
    );
  }

  const pendingInvitations = project.invitations.filter((i) => i.status === 'pending').length;
  const delegating = !!project.autoDelegate;

  return (
    <div className="setup-stack">
      <PageHeader
        title="Project setup"
        description={`Who works on ${project.name}, and how work gets handed out.`}
      />

      <section className="panel" aria-labelledby="setup-details">
        <div className="setup-panel-head">
          <h2 id="setup-details">Project details</h2>
        </div>
        {changed && (
          <div className="notice">
            <div>
              <strong>Newer project data is available.</strong>
              <p>
                Reload the latest details before saving. Your current inputs are preserved until you
                choose to reload.
              </p>
              <Button variant="outline" size="sm" onClick={loadLatest}>
                Reload details
              </Button>
            </div>
          </div>
        )}
        <div className="identity">
          <span className="repo-mark" aria-hidden="true">
            {(project.name.split('/').pop() || project.name).charAt(0).toUpperCase()}
          </span>
          <div className="identity-text">
            <strong className="identity-name">{project.name}</strong>
            <div className="identity-repo">
              <code>{project.repository}</code>
              <a
                className="icon-link"
                href={`https://github.com/${project.repository}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={14} aria-hidden="true" />
                Open on GitHub
              </a>
            </div>
          </div>
          <span className="branch-chip" title="Tracked branch">
            <GitBranch size={14} aria-hidden="true" />
            <code>{project.trackedBranch || 'Branch not recorded'}</code>
          </span>
        </div>
        <p className="small muted identity-note">
          The repository and branch are set when a repository is imported. To track a different
          repository, import it as a new project.
        </p>
        <form
          className="setup-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const result = await save.mutateAsync({
                type: 'update-project', name: trimmedName, repository: project.repository, description,
              });
              setFormVersion(result.projectVersion);
              setSaved(true);
            } catch {
              /* Keep drafts and show errors. */
            }
          }}
        >
          {owner ? (
            <fieldset disabled={save.isPending}>
              <Field label="Project name">
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setSaved(false);
                  }}
                />
              </Field>
              <Field label="Description" hint="Shown to teammates and agents.">
                <textarea
                  maxLength={1000}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setSaved(false);
                  }}
                />
              </Field>
              <div className="counter" aria-hidden="true">
                {description.length.toLocaleString()} / 1,000
              </div>
              <div className="form-actions">
                <Button type="submit" disabled={changed || !dirty || !trimmedName}>
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </Button>
                {dirty && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setName(project.name);
                      setDescription(project.description);
                      setSaved(false);
                    }}
                  >
                    Discard
                  </Button>
                )}
                <span role="status" className={saved && !dirty ? 'success-text' : 'form-state'}>
                  {dirty ? 'Unsaved changes' : saved ? 'Saved.' : ''}
                </span>
              </div>
            </fieldset>
          ) : (
            <div className="field">
              <span className="field-label">Description</span>
              <p className="description-readonly">{project.description || 'No description.'}</p>
              <p className="small muted">Only the project owner can edit setup.</p>
            </div>
          )}
          <ErrorNotice error={save.error} />
        </form>
      </section>

      <section className="panel" aria-labelledby="setup-people">
        <div className="setup-panel-head">
          <h2 id="setup-people">People</h2>
          <span className="muted">
            {plural(project.members.length, 'member')}
            {pendingInvitations > 0 ? ` · ${pendingInvitations} pending` : ''}
          </span>
        </div>
        {owner && (
          <form
            className="invite-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await invite.mutateAsync({ type: 'invite', email, role });
                setEmail('');
              } catch {
                /* Error is shown. */
              }
            }}
          >
            <div className="invite-row">
              <Field label="Invite by email">
                <input
                  required
                  type="email"
                  maxLength={254}
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Role" hint={roleHelp[role]}>
                <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {label(r)}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? 'Inviting…' : 'Invite'}
              </Button>
            </div>
            <p className="small muted">
              They accept from Invitations in the sidebar after signing in with the same verified email.
              Until they accept, they don't have access.
            </p>
            <ErrorNotice error={invite.error} />
          </form>
        )}
        <ul className="people-list">
          {project.members.map((member) => (
            <li key={member.id}>
              <span className="avatar" aria-hidden="true">{initials(member.name)}</span>
              <div className="people-text">
                <strong>{member.name}</strong>
                {member.id === user!.id && <small>You</small>}
              </div>
              <Badge value={member.role} />
            </li>
          ))}
          {project.invitations.map((invitation) => (
            <li key={invitation.id}>
              <span className="avatar avatar-pending" aria-hidden="true">@</span>
              <div className="people-text">
                <strong>{invitation.email}</strong>
                <small>Invited as {label(invitation.role).toLowerCase()}</small>
              </div>
              <Badge value={invitation.status} />
              {owner && invitation.status === 'pending' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ type: 'revoke-invite', invitationId: invitation.id })}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
        <ErrorNotice error={revoke.error} />
      </section>

      <section className="panel" aria-labelledby="setup-automation">
        <div className="setup-panel-head">
          <h2 id="setup-automation">Agents and automation</h2>
        </div>
        <div className="setting-row">
          <div>
            <strong id="delegate-title">Auto-delegate</strong>
            <p className="muted" id="delegate-desc">
              Assign approved, ready tasks to eligible agents automatically, balancing their workload.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={delegating}
            aria-labelledby="delegate-title"
            aria-describedby="delegate-desc"
            className="switch"
            disabled={!owner || delegate.isPending}
            onClick={() => delegate.mutate({ type: 'auto-delegate', enabled: !delegating })}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            <span className="switch-text">
              {delegate.isPending ? 'Saving…' : delegating ? 'On' : 'Off'}
            </span>
          </button>
        </div>
        <details className="how">
          <summary>How it works</summary>
          <p className="muted">
            It checks about every 15 seconds while the backend is running. Agents still fetch and claim
            work from their IDE. Existing assignments stay in place when you turn it off. While it is on,
            clearing an assignment makes the task eligible for assignment again.
          </p>
        </details>
        {!owner && <p className="small muted">Only project owners can change automatic delegation.</p>}
        <ErrorNotice error={delegate.error} />
      </section>

      {owner && (
        <section className="panel danger-zone" aria-labelledby="setup-danger">
          <div className="danger-head">
            <h2 id="setup-danger">Danger zone</h2>
          </div>
          <div className="danger-body">
            <div className="setting-row">
              <div>
                <strong>Delete this project</strong>
                <p className="muted">
                  Permanently removes {plural(project.members.length, 'member')},{' '}
                  {plural(project.tasks.length, 'task')}, plans, messages and activity. This can't be
                  undone. Your GitHub repository, branches and pull requests aren't affected.
                </p>
              </div>
              {!confirmingDelete && (
                <Button variant="destructive" className="danger-start" onClick={() => setConfirmingDelete(true)}>
                  Delete project
                </Button>
              )}
            </div>
            <details className="how">
              <summary>What happens to agents and Meta</summary>
              <p className="muted">
                Agents lose access immediately, but work already running on someone's machine keeps going.
                Text already sent to Meta for planning can't be recalled. You can import the repository
                again as a new, empty project.
              </p>
            </details>
            {confirmingDelete && (
              <div className="delete-confirm">
                <Field label={`Type ${project.repository} to confirm`}>
                  <input
                    autoFocus
                    autoComplete="off"
                    value={deleteConfirmation}
                    onChange={(e) => setDeleteConfirmation(e.target.value)}
                  />
                </Field>
                <div className="form-actions">
                  <Button
                    variant="destructive"
                    disabled={removal.isPending || deleteConfirmation !== project.repository}
                    onClick={async () => {
                      try {
                        await removal.mutateAsync({ type: 'delete-project' });
                        navigate('/projects/new');
                      } catch {
                        /* Display the API error. */
                      }
                    }}
                  >
                    {removal.isPending ? 'Deleting…' : `Delete ${project.name}`}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={removal.isPending}
                    onClick={() => {
                      setConfirmingDelete(false);
                      setDeleteConfirmation('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <ErrorNotice error={removal.error} />
          </div>
        </section>
      )}
    </div>
  );
}
