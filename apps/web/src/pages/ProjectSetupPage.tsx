import { GitHubRepositoryPicker } from '../components/GitHubRepositoryPicker';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { roleFor, roles, type Project, type Role } from '../types/domain';
import { Badge, Empty, ErrorNotice, Field, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';

export function ProjectSetupPage({ project }: { project: Project | null }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const owner = !project || roleFor(project, user!.id) === 'owner';
  const [selection, setSelection] = useState<{repositoryId: number; installationId: number} | null>(null);
  const [branch, setBranch] = useState(project?.trackedBranch ?? '');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const removal = useAction(project);
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
  const SettingsContainer = project ? 'div' : 'details';
  function loadLatest() {
    if (project) {
      setName(project.name);
      setRepo(project.repository);
      setDescription(project.description);
      setBranch(project.trackedBranch ?? '');
      setFormVersion(project.version);
      setSaved(false);
      save.reset();
    }
  }
  return (
    <>
      <PageHeader
        title={project ? 'Project setup' : 'Import GitHub repository'}
        description="Project details, human membership and invitations."
      />
      <section className="panel narrow-panel">
        <h2>{project ? 'Project details' : 'Choose your repository'}</h2>
        <p className="muted">{project ? 'Manage your project description and access.' : 'Select a repository to create your Tandem project.'}</p>
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
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              if (!project && !selection) return;
              const result = await save.mutateAsync(project ? {
                type: 'update-project', name: project.name, repository: project.repository,
                description, trackedBranch: branch,
              } : {
                type: 'create-project', name, repository: repo, description,
                githubRepositoryId: selection!.repositoryId,
                githubInstallationId: selection!.installationId, trackedBranch: branch,
              });
              if (!project) navigate(`/projects/${result.projectId}/activity`);
              else {
                setFormVersion(result.projectVersion);
                setSaved(true);
              }
            } catch {
              /* Keep drafts and show errors. */
            }
          }}
        >
          <fieldset disabled={!owner || save.isPending}>
            {!project && <GitHubRepositoryPicker onSelect={(repository, installationId) => {
              setSelection(repository ? {repositoryId: repository.id, installationId} : null);
              setRepo(repository?.fullName ?? ''); setName(repository?.name.slice(0, 80) ?? '');
              // Tandem deliberately uses main when no agent push branch is specified.
              setBranch(''); setDescription(repository?.description.slice(0, 1000) ?? '');
            }} />}
            {project ? <>
              <dl>
                <dt>Project name</dt><dd>{project.name}</dd>
                <dt>GitHub repository</dt><dd>{project.repository}</dd>
              </dl>
              <p className="muted">The repository is fixed after import. Your GitHub repository isn't affected by editing these settings.</p>
            </> : null}
            <SettingsContainer>
            {!project && <summary>Optional settings</summary>}
            <Field label="Agent push branch" hint="Agents commit and push only to this branch. Leave blank to use main. The backend checks imported repositories before saving.">
              <input maxLength={255} value={branch} placeholder="main" onChange={e => {
                setBranch(e.target.value);
                setSaved(false);
              }} />
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
            </SettingsContainer>
            <Button type="submit" disabled={changed || (!project && !selection)}>
              {save.isPending ? 'Saving…' : project ? 'Save project' : 'Import repository'}
            </Button>
          </fieldset>
          {!owner && <p className="muted">Only the project owner can edit setup.</p>}
          <ErrorNotice error={save.error} />
          {saved && (
            <p role="status" className="success-text">
              Project saved by the backend.
            </p>
          )}
        </form>
      </section>
      {project && owner && <section className="panel narrow-panel">
        <h2>Delete project</h2>
        <p>Permanently deletes this Tandem project for all {project.members.length} members, including its {project.tasks.length} tasks, plans, messages and activity. This can't be undone.</p>
        <p><strong>Your GitHub repository, branches and pull requests aren't affected.</strong></p>
        <p className="muted">Agents lose access immediately, but work already running on someone's machine keeps going. Text already sent to Meta for planning can't be recalled. You can import the repository again as a new, empty project.</p>
        <Field label={`Type ${project.repository} to confirm`}><input value={deleteConfirmation} onChange={e => setDeleteConfirmation(e.target.value)} /></Field>
        <Button variant="outline" disabled={removal.isPending || deleteConfirmation !== project.repository}
          onClick={async () => {try {await removal.mutateAsync({type: 'delete-project'}); navigate('/projects/new');} catch { /* Display the API error. */ }}}>
          {removal.isPending ? 'Deleting…' : 'Delete project'}
        </Button>
        <ErrorNotice error={removal.error} />
      </section>}
      {project && (
        <section className="panel narrow-panel">
          <h2>Auto-delegate</h2>
          <p>Automatically assign approved, ready tasks to eligible agents, balancing their workload in this project.</p>
          <p className="muted">Checks about every 15 seconds while the backend is running. Agents must still fetch and claim work from their IDE. Existing assignments stay in place when you turn this off. While enabled, clearing an assignment makes it eligible for assignment again.</p>
          <Button role="switch" aria-checked={!!project.autoDelegate}
            disabled={!owner || delegate.isPending}
            onClick={() => delegate.mutate({ type: 'auto-delegate', enabled: !project.autoDelegate })}>
            {delegate.isPending ? 'Saving…' : project.autoDelegate ? 'Auto-delegate: On' : 'Auto-delegate: Off'}
          </Button>
          {!owner && <p className="muted">Only project owners can change automatic delegation.</p>}
          <ErrorNotice error={delegate.error} />
        </section>
      )}
      {project && (
        <div className="two-column">
          <section className="panel">
            <h2>Human members</h2>
            <ul className="member-list">
              {project.members.map((member) => (
                <li key={member.id}>
                  <div>
                    <strong>{member.name}</strong>
                    <small>{member.id === user!.id ? 'You' : 'Project member'}</small>
                  </div>
                  <Badge value={member.role} />
                </li>
              ))}
            </ul>
            <p className="small muted">
              Membership and permission checks are managed by the backend.
            </p>
          </section>
          <section className="panel">
            <h2>Invitation records</h2>
            <p className="muted">
              Recipients accept from the sidebar Invitations page after signing in with the same
              verified email you invite. A pending record is not proof they have access yet.
            </p>
            {owner && (
              <form
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
                <Field label="Invitation email">
                  <input
                    required
                    type="email"
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field label="Invitation role">
                  <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {roles.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" disabled={invite.isPending}>
                  {invite.isPending ? 'Saving…' : 'Create invitation record'}
                </Button>
                <ErrorNotice error={invite.error} />
              </form>
            )}
            {project.invitations.length === 0 ? (
              <Empty title="No invitation records" />
            ) : (
              <ul className="member-list">
                {project.invitations.map((invitation) => (
                  <li key={invitation.id}>
                    <div>
                      <strong>{invitation.email}</strong>
                      <small>{invitation.role}</small>
                      <Badge value={invitation.status} />
                    </div>
                    {owner && invitation.status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() =>
                          revoke.mutate({ type: 'revoke-invite', invitationId: invitation.id })
                        }
                      >
                        Revoke invitation
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <ErrorNotice error={revoke.error} />
          </section>
        </div>
      )}
    </>
  );
}
