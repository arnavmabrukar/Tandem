import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import type { ApprovePlanRequest, PlanRevision } from '../types/plans';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { ErrorNotice, Field } from './common';

export function PlanApproval({ plan, projectVersion, disabled, onApproved }: {
  plan: PlanRevision; projectVersion: number; disabled: boolean; onApproved?: (startNow: boolean) => void;
}) {
  const { api, user } = useSession();
  const client = useQueryClient();
  // Capture the review target when opening; background refreshes must not change it.
  const [target, setTarget] = useState<{ plan: PlanRevision; projectVersion: number } | null>(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const pending = useRef<ApprovePlanRequest | null>(null);
  const action = useMutation({
    mutationFn: (startNow: boolean) => {
      if (!target) throw new Error('Open a plan to review first.');
      pending.current ??= { operationId: crypto.randomUUID(), expectedVersion: target.projectVersion,
        expectedPlanVersion: target.plan.planVersion, note, startNow };
      return api.approvePlan(target.plan.projectId, target.plan.planId, pending.current);
    },
    onSuccess: (_result, startNow) => {
      pending.current = null; setTarget(null); onApproved?.(startNow);
      void client.invalidateQueries({ queryKey: ['plans', user!.id, plan.projectId] });
      void client.invalidateQueries({ queryKey: ['workspace', user!.id] });
    },
    onError: error => {
      if (error instanceof ApiError && !error.outcomeUnknown) pending.current = null;
    }, retry: false,
  });
  const uncertain = action.error instanceof ApiError && action.error.outcomeUnknown;
  const conflict = action.error instanceof ApiError && action.error.status === 409;
  const locked = action.isPending || uncertain;
  return <>
    <Button disabled={disabled} onClick={() => {
      action.reset(); setNote(''); setConfirmed(false);
      setTarget({ plan: structuredClone(plan), projectVersion });
    }}>Review and create tasks</Button>
    <Modal open={!!target} onOpenChange={open => { if (!open && !locked) setTarget(null); }}
      className="plan-approval-dialog" title="Review and approve plan" description="Review the tasks and their contracts, then choose whether to start work now.">
      {target && <>
        <div className="plan-approval-body">
        <section className="plan-approval-overview">
          <p className="small muted">Revision {target.plan.planVersion} · {target.plan.proposal.tasks.length} {target.plan.proposal.tasks.length === 1 ? 'task' : 'tasks'}</p>
          <h3>{target.plan.proposal.goal}</h3>
          <p>{target.plan.proposal.summary}</p>
        </section>
        <h3 className="plan-approval-section-title">Task contracts</h3>
        <div className="plan-approval-tasks">
        {target.plan.proposal.tasks.map((task, index) => <details className="plan-approval-task" key={task.key} open={index === 0}>
          <summary><span className="plan-approval-number">{index + 1}</span><strong>{task.title}</strong></summary>
          <div className="plan-approval-task-body">
          <p>{task.description}</p>
          <dl><dt>Scope</dt><dd>{task.contractSummary}</dd>
          <dt>Files</dt><dd>{task.paths.length ? task.paths.map(path => <code key={path}>{path}</code>) : 'Not specified'}</dd>
          <dt>Acceptance criteria</dt><dd><ul>{task.criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul></dd>
          <dt>Dependencies</dt><dd>{task.dependencies.map(key => target.plan.proposal.tasks.find(t => t.key === key)?.title ?? key).join(', ') || 'None — can start independently'}</dd></dl>
          </div>
        </details>)}
        </div>
        <Field label="Review note" hint="Required. Briefly explain what you reviewed."><textarea rows={2} disabled={locked} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></Field>
        <label className="row"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} />
          I reviewed this revision, including each task's contract.</label>
        <ErrorNotice error={action.error} retry={uncertain && !action.isPending ? () => action.mutate(pending.current?.startNow ?? false) : undefined} />
        {conflict && <p>Close this review, refresh the dashboard, and review the latest plan before approving again.</p>}
        </div>
        <footer className="plan-approval-footer">
          <p><strong>Create tasks:</strong> approve contracts later. <strong>Run:</strong> approve all contracts and assign ready tasks to online agents. You still accept finished work.</p>
        <div className="row end wrap">
          <Button variant="outline" disabled={locked} onClick={() => setTarget(null)}>Cancel</Button>
          <Button variant="outline" disabled={disabled || locked || conflict || !confirmed || !note.trim()} onClick={() => action.mutate(false)}>
            Approve and create tasks</Button>
          <Button disabled={disabled || locked || conflict || !confirmed || !note.trim()} onClick={() => action.mutate(true)}>
            {action.isPending ? 'Saving…' : 'Approve and run'}</Button>
        </div>
        </footer>
      </>}
    </Modal>
  </>;
}
