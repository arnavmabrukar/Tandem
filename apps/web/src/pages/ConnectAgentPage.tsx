import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Plus } from 'lucide-react';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { roleFor, type Agent, type Project } from '../types/domain';
import { Badge, Empty, ErrorNotice, Field, PageHeader, Timestamp } from '../components/common';
import { FileClaimsTable } from '../components/FileClaimsTable';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';

export function ConnectAgentPage({ project }: { project: Project }) {
  const { user } = useSession();
  const owner = roleFor(project, user!.id) === 'owner';
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState<Agent | null>(null);
  const add = useAction(project);
  const revoke = useAction(project);
  const [name, setName] = useState('');
  const [client, setClient] = useState<Agent['client']>('Codex');
  const [human, setHuman] = useState(user!.name);
  const [machine, setMachine] = useState('');
  const [capabilities, setCapabilities] = useState('');
  return (
    <>
      <PageHeader
        title="Agent connections"
        description="Each agent keeps its own machine, context, credentials and local worktree."
        action={
          <Button
            disabled={!owner}
            onClick={() => {
              add.reset();
              setOpen(true);
            }}
          >
            <Plus size={17} />
            Add agent record
          </Button>
        }
      />
      <div className="notice">
        <div>
          <strong>These are simulated connection records.</strong>
          <p>
            No client has authenticated or registered with Tandem. See the{' '}
            <Link to={`/projects/${project.id}/connections`}>connection guide</Link> for the
            integration steps.
          </p>
        </div>
      </div>
      {project.agents.length === 0 ? (
        <section className="panel">
          <Empty title="No agents registered">
            Add a demo record to test setup, then connect real agents when the backend is ready.
          </Empty>
        </section>
      ) : (
        <div className="agent-grid">
          {project.agents.map((agent) => (
            <article className="panel" key={agent.id}>
              <div className="row between">
                <span className="agent-icon">
                  <Bot size={22} />
                </span>
                <Badge value={agent.grant} />
              </div>
              <h2>{agent.name}</h2>
              <p className="muted">
                {agent.client} · {agent.owner}
              </p>
              <dl className="details-grid">
                <dt>Machine</dt>
                <dd>{agent.machine}</dd>
                <dt>Presence</dt>
                <dd>
                  <Badge value={agent.presence} />
                </dd>
                <dt>Last check-in</dt>
                <dd>
                  <Timestamp value={agent.lastSeen} />
                </dd>
                <dt>Session</dt>
                <dd>
                  <code>{agent.session ?? 'No session'}</code>
                </dd>
                <dt>Open tasks</dt>
                <dd>
                  {
                    project.tasks.filter(
                      (t) => t.agentId === agent.id && !['merged', 'cancelled'].includes(t.status),
                    ).length
                  }
                </dd>
              </dl>
              <div className="row wrap">
                {agent.capabilities.map((capability) => (
                  <span className="tag" key={capability}>
                    {capability}
                  </span>
                ))}
              </div>
              <p className="small muted">
                Presence does not prove task progress. Revoking a grant does not release claims or
                stop the local agent.
              </p>
              {owner && agent.grant !== 'revoked' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    revoke.reset();
                    setRevoking(agent);
                  }}
                >
                  Revoke demo grant
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
      <FileClaimsTable project={project} />
      <Modal
        open={open}
        onOpenChange={(v) => {
          if (!add.isPending) setOpen(v);
        }}
        title="Add a demo agent record"
        description="A pending record is saved locally. This does not launch an agent or configure OAuth."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await add.mutateAsync({
                type: 'add-agent',
                name,
                client,
                owner: human,
                machine,
                capabilities: [
                  ...new Set(
                    capabilities
                      .split(',')
                      .map((c) => c.trim())
                      .filter(Boolean),
                  ),
                ],
              });
              setOpen(false);
              setName('');
              setMachine('');
              setCapabilities('');
            } catch {
              /* Keep the form. */
            }
          }}
        >
          <Field label="Agent name">
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Client">
            <select value={client} onChange={(e) => setClient(e.target.value as Agent['client'])}>
              <option>Codex</option>
              <option>Claude Code</option>
              <option>Other</option>
            </select>
          </Field>
          <Field label="Human owner">
            <input
              required
              maxLength={80}
              value={human}
              onChange={(e) => setHuman(e.target.value)}
            />
          </Field>
          <Field label="Machine label">
            <input
              required
              maxLength={100}
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              placeholder="Workstation or laptop"
            />
          </Field>
          <Field
            label="Capabilities"
            hint="Comma-separated labels, such as Frontend, Python, Tests."
          >
            <input
              maxLength={500}
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
            />
          </Field>
          <ErrorNotice error={add.error} />
          <div className="row end">
            <Button variant="outline" disabled={add.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Adding…' : 'Add record'}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={!!revoking}
        onOpenChange={(v) => {
          if (!v && !revoke.isPending) setRevoking(null);
        }}
        title="Revoke this demo grant?"
        description="Existing assignments and file claims remain visible for reconciliation. No real credentials or sessions are changed."
      >
        <p>{revoking?.name}</p>
        <ErrorNotice error={revoke.error} />
        <div className="row end">
          <Button variant="outline" onClick={() => setRevoking(null)} disabled={revoke.isPending}>
            Keep grant
          </Button>
          <Button
            variant="destructive"
            disabled={revoke.isPending}
            onClick={async () => {
              try {
                await revoke.mutateAsync({ type: 'revoke-agent', agentId: revoking!.id });
                setRevoking(null);
              } catch {
                /* Shown above. */
              }
            }}
          >
            {revoke.isPending ? 'Revoking…' : 'Confirm revocation'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
