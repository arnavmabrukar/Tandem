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
import { AgentOAuthSetup } from '../components/AgentOAuthSetup';
import { AgentTokenButton } from '../components/AgentTokenButton';

export function ConnectAgentPage({ project }: { project: Project }) {
  const { user } = useSession();
  const owner = roleFor(project, user!.id) === 'owner';
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [setupId, setSetupId] = useState<string | null>(null);
  const setupAgent = project.agents.find((agent) => agent.id === setupId);
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
            Add agent manually
          </Button>
        }
      />
      <p><Button onClick={() => setConnectOpen(true)}>Connect your IDE</Button></p>
      <div className="notice">
        <div>
          <strong>Connect your IDE in three steps.</strong>
          <p>
            Choose your IDE, sign in, and allow access to your project. See the{' '}
            <Link to={`/projects/${project.id}/connections`}>connection guide</Link> for the
            integration steps.
          </p>
        </div>
      </div>
      {project.agents.length === 0 ? (
        <section className="panel">
          <Empty title="No agents registered">
            Connect your IDE to get started. You can name your agent during sign-in.
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
                {agent.client}
              </p>
              {owner && agent.ownerId === user!.id && agent.grant !== 'revoked' && <>
                <Button onClick={() => setSetupId(agent.id)}>Connect agent</Button>
                <p className="small muted">{agent.grant === 'pending'
                  ? 'Sign in from your IDE to get started.'
                  : 'Access enabled. Connect or check your IDE.'}</p>
              </>}
              <details className="agent-advanced">
                <summary>Details and settings</summary>
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
                {owner && agent.ownerId === user!.id && agent.grant !== 'revoked' && <>
                  <p className="small muted">Manual token for clients without browser sign-in:</p>
                  <AgentTokenButton key={`${project.id}:${agent.id}:${user!.id}`} project={project} agent={agent} />
                </>}
                {owner && agent.grant !== 'revoked' && <>
                  <p className="small muted">Revoking access does not stop the agent on its machine.</p>
                  <Button variant="outline" size="sm" onClick={() => { revoke.reset(); setRevoking(agent); }}>
                    Revoke access
                  </Button>
                </>}
              </details>
            </article>
          ))}
        </div>
      )}
      {connectOpen && <AgentOAuthSetup project={project} onClose={() => setConnectOpen(false)} />}
      {setupAgent && <AgentOAuthSetup key={setupAgent.id} project={project} agent={setupAgent}
        onClose={() => setSetupId(null)} />}
      <FileClaimsTable project={project} />
      <Modal
        open={open}
        onOpenChange={(v) => {
          if (!add.isPending) setOpen(v);
        }}
        title="Add an agent record"
        description="Submit the agent’s details to the mediator. The client must authenticate before it can work."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const created = await add.mutateAsync({
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
              if (created.entityId) setSetupId(created.entityId);
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
              {add.isPending ? 'Adding…' : 'Add and connect'}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={!!revoking}
        onOpenChange={(v) => {
          if (!v && !revoke.isPending) setRevoking(null);
        }}
        title="Revoke this agent grant?"
        description="Ask the mediator to revoke this agent’s project access. Existing tasks and file claims need reconciliation; the local process is not stopped."
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
