import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../auth/session';
import { canEdit, roleFor, type Approval, type Project } from '../types/domain';
import { Badge, Empty, Field, PageHeader, Timestamp } from '../components/common';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { Button } from '../components/ui/button';

export function ApprovalsPage({ project, kind, embedded = false }: { project: Project; kind?: 'contract' | 'result'; embedded?: boolean }) {
  const { user } = useSession();
  const writable = canEdit(roleFor(project, user!.id));
  const [params, setParams] = useSearchParams();
  const status = params.get('approvalStatus') ?? 'pending';
  const [selected, setSelected] = useState<Approval | null>(null);
  const approvals = [...project.approvals]
    .reverse()
    .filter(a => !kind || a.action === (kind === 'contract' ? 'Approve contract' : 'Review result'))
    .filter((a) => status === 'all' || a.status === status);
  return (
    <>
      <PageHeader
        level={embedded ? 2 : 1}
        title={kind === 'contract' ? 'Approve scope' : 'Result approvals'}
        description={kind === 'contract' ? 'Review task contracts and acceptance criteria before agents begin work.' : 'Review the exact submitted code and record a decision. Acceptance remains in the task.'}
      />
      {!embedded && <div className="notice">
        <div>
          <strong>Decisions apply to one exact target.</strong>
          <p>
            The mediator validates your authority and the current task, contract and PR head.
            Recording an approval does not merge the pull request.
          </p>
        </div>
      </div>}
      <section className="panel">
        <div className="filters">
          <Field label="Approval status">
            <select
              value={status}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.set('approvalStatus', e.target.value);
                setParams(next, { replace: true });
              }}
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
            {kind === 'contract' ? 'Contracts requiring a decision appear here. Choose all decisions to see approved scope.' : 'Result review requests appear here when agents submit work. Choose all decisions to see past reviews.'}
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
                    <dd>{approval.repository}</dd>
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
