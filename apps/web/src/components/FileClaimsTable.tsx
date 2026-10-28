import { Link } from 'react-router-dom';
import type { Project } from '../types/domain';
import { Badge, Empty, Timestamp } from './common';

export function FileClaimsTable({ project, taskId }: { project: Project; taskId?: string }) {
  const claims = project.claims.filter((claim) => !taskId || claim.taskId === taskId);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>File claims</h2>
          <p className="muted">
            Reservations do not lock a local worktree. Stale claims need reconciliation.
          </p>
        </div>
      </div>
      {claims.length === 0 ? (
        <Empty title="No file claims">
          Proposed file scope becomes a claim only after the mediator accepts it.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Repository path</th>
                <th>Owner</th>
                <th>State</th>
                <th>Generation</th>
                <th>Lease deadline</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr key={claim.id}>
                  <td>
                    <Link to={`/projects/${project.id}/tasks/${claim.taskId}`}>
                      <code>{claim.path}</code>
                    </Link>
                  </td>
                  <td>
                    {project.agents.find((a) => a.id === claim.agentId)?.name ?? 'Unknown agent'}
                  </td>
                  <td>
                    <Badge value={claim.state} />
                  </td>
                  <td>{claim.generation}</td>
                  <td>
                    {claim.expiresAt ? <Timestamp value={claim.expiresAt} /> : 'No lease deadline'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
