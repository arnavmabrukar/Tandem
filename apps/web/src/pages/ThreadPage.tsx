import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Send } from 'lucide-react';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { canEdit, roleFor, type Approval, type Project, type Task } from '../types/domain';
import { Badge, Empty, ErrorNotice, Field, PageHeader, Timestamp } from '../components/common';
import { FileClaimsTable } from '../components/FileClaimsTable';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';

export function ThreadPage({ project }: { project: Project }) {
  const { taskId } = useParams();
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task)
    return (
      <Empty title="Task not found">
        This task is not present in the current project snapshot.{' '}
        <Link to={`/projects/${project.id}/tasks`}>Return to tasks</Link>.
      </Empty>
    );
  return <ThreadDetail key={task.id} project={project} task={task} />;
}
function ThreadDetail({ project, task }: { project: Project; task: Task }) {
  const { user } = useSession();
  const writable = canEdit(roleFor(project, user!.id));
  const message = useAction(project);
  const cancel = useAction(project);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [review, setReview] = useState<Approval | null>(null);
  const messages = project.messages
    .filter((m) => m.taskId === task.id)
    .sort((a, b) => a.sequence - b.sequence);
  const approvals = project.approvals.filter((a) => a.taskId === task.id);
  return (
    <>
      <Link className="back-link" to={`/projects/${project.id}/tasks`}>
        <ArrowLeft size={15} /> All tasks
      </Link>
      <PageHeader
        title={task.title}
        description={`Thread ${task.threadId} · Task v${task.version}`}
        action={<Badge value={task.status} />}
      />
      <section className="panel">
        <p className="pre-wrap">{task.description}</p>
        <div className="signal-grid">
          <div>
            <small>Assigned agent</small>
            <strong>
              {project.agents.find((a) => a.id === task.agentId)?.name ?? 'Unassigned'}
            </strong>
          </div>
          <div>
            <small>Delivery receipt</small>
            <Badge value={task.receipt} />
          </div>
          <div>
            <small>Task acceptance</small>
            <Badge value={task.acceptance} />
          </div>
          <div>
            <small>Code merge</small>
            <Badge value={task.result?.mergeCommit ? 'merged' : 'not_merged'} />
          </div>
        </div>
        <p>
          <strong>Progress:</strong> {task.progress}
        </p>
        {task.dependencies.length > 0 && (
          <p>
            Dependencies:{' '}
            {task.dependencies.map((id) => (
              <Link key={id} to={`/projects/${project.id}/tasks/${id}`}>
                {project.tasks.find((t) => t.id === id)?.title ?? id}{' '}
              </Link>
            ))}
          </p>
        )}
        {writable && !['merged', 'cancelled'].includes(task.status) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              cancel.reset();
              setCancelOpen(true);
            }}
          >
            Cancel task
          </Button>
        )}
      </section>
      <div className="two-column">
        <section className="panel">
          <div className="section-heading">
            <h2>Contract & scope</h2>
            <Badge value={`v${task.contract.version}`} />
          </div>
          <p>{task.contract.summary}</p>
          <h3>Proposed files</h3>
          {task.contract.paths.length ? (
            <ul className="plain-list">
              {task.contract.paths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No file scope recorded.</p>
          )}
          <h3>Acceptance criteria</h3>
          {task.contract.criteria.length ? (
            <ul className="bullets">
              {task.contract.criteria.map((criterion, i) => (
                <li key={i}>{criterion}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No criteria recorded.</p>
          )}
          <details>
            <summary>Contract history</summary>
            <ul className="bullets">
              {task.contract.history.map((version, i) => (
                <li key={i}>{version}</li>
              ))}
            </ul>
          </details>
          <p className="muted small">
            Discussion does not silently amend a contract. Contract editing needs a backend
            amendment operation.
          </p>
        </section>
        <section className="panel">
          <h2>Result & review</h2>
          {task.result ? (
            <>
              <dl className="details-grid">
                <dt>Pull request</dt>
                <dd>
                  #{task.result.prNumber} · {task.result.branch}
                </dd>
                <dt>Head</dt>
                <dd>
                  <code className="break-all">{task.result.head}</code>
                </dd>
                <dt>Merge commit</dt>
                <dd>
                  <code className="break-all">
                    {task.result.mergeCommit ?? 'No merge evidence'}
                  </code>
                </dd>
              </dl>
              <ul className="bullets">
                {task.result.evidence.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">No result has been submitted.</p>
          )}
          {approvals.map((approval) => (
            <div className="review-row" key={approval.id}>
              <div>
                <strong>{approval.action}</strong>
                <small>
                  Task v{approval.taskVersion} · contract v{approval.contractVersion}
                </small>
                <Badge value={approval.status} />
              </div>
              {approval.status === 'pending' && (
                <Button
                  variant="outline"
                  disabled={!writable}
                  onClick={() => setReview(structuredClone(approval))}
                >
                  Review target
                </Button>
              )}
            </div>
          ))}
        </section>
      </div>
      <FileClaimsTable project={project} taskId={task.id} />
      <section className="panel">
        <div className="section-heading">
          <h2>
            <MessageSquare size={18} /> Thread discussion
          </h2>
          <span className="muted">{messages.length} messages</span>
        </div>
        {messages.length === 0 ? (
          <Empty title="Start the discussion">
            Human notes appear here. They do not trigger an agent session.
          </Empty>
        ) : (
          <ol className="messages">
            {messages.map((item) => (
              <li key={item.id} id={item.id}>
                <div className="row wrap">
                  <strong>{item.sender}</strong>
                  <Badge value={item.type} />
                  <small>
                    #{item.sequence} · <Timestamp value={item.createdAt} />
                  </small>
                </div>
                {item.replyTo && (
                  <small className="reply-reference">
                    Reply to #{messages.find((m) => m.id === item.replyTo)?.sequence ?? '?'} —{' '}
                    {messages.find((m) => m.id === item.replyTo)?.sender ?? 'Earlier message'}
                  </small>
                )}
                <p className="pre-wrap">{item.body}</p>
                <div className="row between">
                  <small>Delivery receipt: {item.receipt}</small>
                  {writable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReplyTo(item.id);
                        document.getElementById('message-body')?.focus();
                      }}
                    >
                      Reply to #{item.sequence}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {writable ? (
          <form
            className="message-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await message.mutateAsync({ type: 'send-message', taskId: task.id, body, replyTo });
                setBody('');
                setReplyTo(null);
              } catch {
                /* Retain draft on failure. */
              }
            }}
          >
            {replyTo && (
              <div className="row wrap">
                <span>Replying to #{messages.find((m) => m.id === replyTo)?.sequence}</span>
                <Button size="sm" variant="ghost" onClick={() => setReplyTo(null)}>
                  Clear reply
                </Button>
              </div>
            )}
            <Field label="Human note">
              <textarea
                id="message-body"
                required
                maxLength={4000}
                placeholder="Ask a question or add context…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <ErrorNotice error={message.error} />
            <div className="row between">
              <small className="muted">
                Sent through the mediator. Delivery receipt is shown separately.
              </small>
              <Button type="submit" disabled={message.isPending || !body.trim()}>
                <Send size={16} />
                {message.isPending ? 'Saving…' : 'Post note'}
              </Button>
            </div>
          </form>
        ) : (
          <p className="muted">Your project role is read-only.</p>
        )}
      </section>
      <Modal
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!cancel.isPending) setCancelOpen(open);
        }}
        title="Cancel this task?"
        description="The task will be marked cancelled. File claims are retained for explicit reconciliation; no local agent is stopped."
      >
        <ErrorNotice error={cancel.error} />
        <div className="row end">
          <Button variant="outline" onClick={() => setCancelOpen(false)}>
            Keep task
          </Button>
          <Button
            variant="destructive"
            disabled={cancel.isPending}
            onClick={async () => {
              try {
                await cancel.mutateAsync({ type: 'cancel-task', taskId: task.id });
                setCancelOpen(false);
              } catch {
                /* Shown above. */
              }
            }}
          >
            {cancel.isPending ? 'Cancelling…' : 'Confirm cancellation'}
          </Button>
        </div>
      </Modal>
      {review && (
        <ApprovalDialog project={project} approval={review} close={() => setReview(null)} />
      )}
    </>
  );
}
