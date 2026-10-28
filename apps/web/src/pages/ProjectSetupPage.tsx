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
  const [name, setName] = useState(project?.name ?? '');
  const [repo, setRepo] = useState(project?.repository ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [formVersion, setFormVersion] = useState(project?.version ?? null);
  const save = useAction(project ? { ...project, version: formVersion! } : null);
  const invite = useAction(project);
  const revoke = useAction(project);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('reviewer');
  const [saved, setSaved] = useState(false);
  const changed = !!project && project.version !== formVersion;
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
  return (
    <>
      <PageHeader
        title={project ? 'Project setup' : 'Create a project'}
        description="Project details, human membership and local invitation records."
      />
      <section className="panel narrow-panel">
        <h2>{project ? 'Project details' : 'Start a local test project'}</h2>
        <p className="muted">
          Repository references are labels only. Tandem does not clone, inspect or change the
          repository.
        </p>
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
              const result = await save.mutateAsync({
                type: project ? 'update-project' : 'create-project',
                name,
                repository: repo,
                description,
              });
              if (!project) navigate(`/projects/${result.projectId}/activity`);
              else {
                setFormVersion((v) => (v ?? 0) + 1);
                setSaved(true);
              }
            } catch {
              /* Keep drafts and show errors. */
            }
          }}
        >
          <fieldset disabled={!owner || save.isPending}>
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
            <Field
              label="GitHub repository"
              hint="Use owner/repository, for example arnavmabrukar/Tandem."
            >
              <input
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]*/[a-zA-Z0-9][a-zA-Z0-9_.\-]*"
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                  setSaved(false);
                }}
                placeholder="owner/repository"
              />
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
            <Button type="submit" disabled={changed}>
              {save.isPending ? 'Saving…' : project ? 'Save project' : 'Create project'}
            </Button>
          </fieldset>
          {!owner && <p className="muted">Only the project owner can edit setup.</p>}
          <ErrorNotice error={save.error} />
          {saved && (
            <p role="status" className="success-text">
              Project saved locally.
            </p>
          )}
        </form>
      </section>
      {project && (
        <div className="two-column">
          <section className="panel">
            <h2>Human members</h2>
            <ul className="member-list">
              {project.members.map((member) => (
                <li key={member.id}>
                  <div>
                    <strong>{member.name}</strong>
                    <small>
                      {member.id === user!.id ? 'Current demo persona' : 'Demo persona'}
                    </small>
                  </div>
                  <Badge value={member.role} />
                </li>
              ))}
            </ul>
            <p className="small muted">
              Role changes and real invitations require the backend. Demo personas are fixed
              fixtures.
            </p>
          </section>
          <section className="panel">
            <h2>Invitation records</h2>
            <p className="muted">
              Test the invitation UI. No email, invitation link or account is created.
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
