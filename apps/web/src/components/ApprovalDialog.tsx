import { useState } from 'react';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { canEdit, currentApproval, roleFor, type Approval, type Project } from '../types/domain';
import { ErrorNotice, Field } from './common';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';

export function ApprovalDialog({
  project,
  approval,
  close,
}: {
  project: Project;
  approval: Approval;
  close: () => void;
}) {
  const { user } = useSession();
  const action = useAction(project);
  const task = project.tasks.find((t) => t.id === approval.taskId);
  const live = project.approvals.find((a) => a.id === approval.id);
  const stale = !task || !live || live.status !== 'pending' || !currentApproval(approval, task);
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [note, setNote] = useState('');
  const [reviewed, setReviewed] = useState(false);
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !action.isPending) close();
      }}
      title="Review exact target"
      description="This records a local demo decision. It does not merge code or publish a GitHub check."
    >
      <dl className="details-grid">
        <dt>Action</dt>
        <dd>{approval.action}</dd>
        <dt>Task</dt>
        <dd>
          {task?.title ?? approval.taskId} · v{approval.taskVersion}
        </dd>
        <dt>Contract</dt>
        <dd>v{approval.contractVersion}</dd>
        <dt>Repository</dt>
        <dd>{project.repository}</dd>
        <dt>PR head</dt>
        <dd>
          <code className="break-all">{approval.head ?? 'No code target'}</code>
        </dd>
      </dl>
      {stale && (
        <div role="alert" className="notice error">
          This target is no longer current. Close this dialog and review the latest request.
        </div>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (stale || !reviewed) return;
          try {
            await action.mutateAsync({
              type: 'decide',
              approvalId: approval.id,
              decision,
              note,
              target: {
                taskVersion: approval.taskVersion,
                contractVersion: approval.contractVersion,
                head: approval.head,
              },
            });
            close();
          } catch {
            /* Keep the exact target and review note visible. */
          }
        }}
      >
        <Field label="Decision">
          <select
            value={decision}
            onChange={(e) => setDecision(e.target.value as typeof decision)}
            disabled={stale}
          >
            <option value="approved">Approve this target</option>
            <option value="rejected">Reject this target</option>
          </select>
        </Field>
        <Field label="Review note">
          <textarea
            required
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={stale}
            placeholder="What did you review, and why is this your decision?"
          />
        </Field>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
            disabled={stale}
          />
          I reviewed this action, version and exact head.
        </label>
        <ErrorNotice error={action.error} />
        <div className="row end">
          <Button variant="outline" disabled={action.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              stale ||
              !reviewed ||
              !note.trim() ||
              action.isPending ||
              !canEdit(roleFor(project, user!.id))
            }
          >
            {action.isPending
              ? 'Recording…'
              : decision === 'approved'
                ? 'Record approval'
                : 'Record rejection'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
