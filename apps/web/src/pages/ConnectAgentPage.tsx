import { useState } from 'react';
import { Bot, Plus } from 'lucide-react';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { roleFor, type Agent, type Project } from '../types/domain';
import { Badge, ErrorNotice, Field, Timestamp } from '../components/common';
import { FileClaimsTable } from '../components/FileClaimsTable';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { AgentOAuthSetup } from '../components/AgentOAuthSetup';
import { AgentRoom } from '../components/AgentRoom';
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
      <div className="agent-room-layout">
        <AgentRoom key={project.id} project={project} />
        <aside className="room-roster" aria-label="Project agents">
          <Button onClick={() => setConnectOpen(true)}><Plus size={17} />Connect agent</Button>
          <h2>In this project</h2>
          <div className="roster-member"><span className="agent-icon"><Bot size={20} /></span><div><strong>Mediator</strong><small>Plans & coordination · on request</small></div></div>
          <h3>Agents · {project.agents.length}</h3>
          {project.agents.length === 0 && <p className="small muted">Connect an IDE agent to join the room.</p>}
          {project.agents.map(agent => <details className="roster-agent" key={agent.id}>
            <summary><span className="roster-member"><span className="agent-icon"><Bot size={18} /></span><span><strong>{agent.name}</strong><small>{agent.client}</small></span><Badge value={agent.grant === 'active' ? agent.presence : agent.grant} /></span></summary>
            <dl className="details-grid"><dt>Machine</dt><dd>{agent.machine}</dd><dt>Last seen</dt><dd><Timestamp value={agent.lastSeen} /></dd><dt>Tasks</dt><dd>{project.tasks.filter(t => t.agentId === agent.id && !['merged', 'cancelled'].includes(t.status)).length}</dd></dl>
            {owner && agent.ownerId === user!.id && agent.grant !== 'revoked' && <>
              <Button size="sm" onClick={() => setSetupId(agent.id)}>Connect</Button>
              <details><summary>Manual token</summary><AgentTokenButton project={project} agent={agent} /></details>
            </>}
            {owner && agent.grant !== 'revoked' && <Button size="sm" variant="outline" onClick={() => { revoke.reset(); setRevoking(agent); }}>Revoke access</Button>}
          </details>)}
          {owner && <details className="agent-advanced"><summary>Advanced</summary><Button variant="ghost" size="sm" onClick={() => { add.reset(); setOpen(true); }}>Add agent manually</Button></details>}
          <p className="small muted">Agents talk to the mediator through MCP. An online status does not mean an agent is working.</p>
        </aside>
      </div>
      {connectOpen && <AgentOAuthSetup project={project} onClose={() => setConnectOpen(false)} />}
      {setupAgent && <AgentOAuthSetup key={setupAgent.id} project={project} agent={setupAgent}
        onClose={() => setSetupId(null)} />}
      <details className="room-claims"><summary>File claims</summary><FileClaimsTable project={project} /></details>
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
