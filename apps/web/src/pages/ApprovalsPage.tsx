import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../auth/session';
import { canEdit, roleFor, type Approval, type Project } from '../types/domain';
import { Badge, Empty, Field, PageHeader, Timestamp } from '../components/common';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { Button } from '../components/ui/button';

export function ApprovalsPage({ project }: { project: Project }) {
  const { user } = useSession();
  const writable = canEdit(roleFor(project, user!.id));
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'all';
  const [selected, setSelected] = useState<Approval | null>(null);
  const approvals = [...project.approvals]
    .reverse()
    .filter((a) => status === 'all' || a.status === status);
  return (
    <>
      <PageHeader
        title="Human approvals"
        description="Review the exact action, contract version and code head. Approval is separate from merging."
      />
      <div className="notice">
        <div>
          <strong>Demo decisions stay in this browser.</strong>
          <p>
            There is no Auth0 verification, GitHub approval check or merge integration. Review
            authority must ultimately be enforced by the mediator.
          </p>
        </div>
      </div>
      <section className="panel">
        <div className="filters">
          <Field label="Approval status">
            <select
              value={status}
              onChange={(e) =>
                setParams(e.target.value === 'all' ? {} : { status: e.target.value })
              }
            >
              <option value="all">All decisions and requests</option>
              {['pending', 'approved', 'rejected', 'stale'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>
        {approvals.length === 0 ? (
          <Empty title="No matching reviews">
            Result and contract review requests will appear here.
          </Empty>
        ) : (
          <div className="approval-list">
            {approvals.map((approval) => {
              const task = project.tasks.find((t) => t.id === approval.taskId);
              return (
                <article className="approval-card" key={approval.id}>
                  <div className="row between wrap">
                    <div>
                      <p className="eyebrow">{approval.action}</p>
                      <h2>
                        <Link to={`/projects/${project.id}/tasks/${approval.taskId}`}>
                          {task?.title ?? 'Unknown task'}
                        </Link>
                      </h2>
                    </div>
                    <Badge value={approval.status} />
                  </div>
                  <dl className="details-grid">
                    <dt>Target</dt>
                    <dd>
                      Task v{approval.taskVersion} · contract v{approval.contractVersion}
                    </dd>
                    <dt>Repository</dt>
                    <dd>{project.repository}</dd>
                    <dt>PR head</dt>
                    <dd>
                      <code className="break-all">{approval.head ?? 'No code target'}</code>
                    </dd>
                    <dt>Requested</dt>
                    <dd>
                      <Timestamp value={approval.requestedAt} />
                    </dd>
                  </dl>
                  {approval.decidedBy && (
                    <p>
                      {approval.decidedBy} · <Timestamp value={approval.decidedAt} />
                    </p>
                  )}
                  {approval.note && <p className="review-note pre-wrap">{approval.note}</p>}
                  {approval.status === 'stale' && (
                    <p className="muted">
                      Historical target. A changed head or version requires a fresh review.
                    </p>
                  )}
                  {approval.status === 'pending' && (
                    <Button
                      disabled={!writable}
                      onClick={() => setSelected(structuredClone(approval))}
                    >
                      Review target
                    </Button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      {selected && (
        <ApprovalDialog
          key={selected.id}
          project={project}
          approval={selected}
          close={() => setSelected(null)}
        />
      )}
    </>
  );
}
