import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import type { ApprovePlanRequest, PlanRevision } from '../types/plans';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { ErrorNotice, Field } from './common';

export function PlanApproval({ plan, projectVersion, disabled }: {
  plan: PlanRevision; projectVersion: number; disabled: boolean;
}) {
  const { api, user } = useSession();
  const client = useQueryClient();
  // Capture the review target when opening; background refreshes must not change it.
  const [target, setTarget] = useState<{ plan: PlanRevision; projectVersion: number } | null>(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const pending = useRef<ApprovePlanRequest | null>(null);
  const action = useMutation({
    mutationFn: () => {
      if (!target) throw new Error('Open a plan to review first.');
      pending.current ??= { operationId: crypto.randomUUID(), expectedVersion: target.projectVersion,
        expectedPlanVersion: target.plan.planVersion, note };
      return api.approvePlan(target.plan.projectId, target.plan.planId, pending.current);
    },
    onSuccess: () => {
      pending.current = null; setTarget(null);
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
      title="Approve this plan" description="Creates the tasks below once. Each task still needs contract approval before an agent can claim it.">
      {target && <>
        <h3>{target.plan.proposal.goal} · revision {target.plan.planVersion}</h3>
        <p>{target.plan.proposal.summary}</p>
        {target.plan.proposal.tasks.map(task => <section key={task.key}>
          <h4>{task.title}</h4><p>{task.description}</p><p>Scope: {task.contractSummary}</p>
          <p>Files: {task.paths.join(', ') || 'Not specified'}</p>
          <ul>{task.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
          <p>Depends on: {task.dependencies.map(key => target.plan.proposal.tasks.find(t => t.key === key)?.title ?? key).join(', ') || 'None'}</p>
        </section>)}
        <Field label="Review note"><textarea disabled={locked} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></Field>
        <label className="row"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} />
          I reviewed this revision and want to create these tasks.</label>
        <ErrorNotice error={action.error} retry={uncertain && !action.isPending ? () => action.mutate() : undefined} />
        {conflict && <p>Close this review, refresh the dashboard, and review the latest plan before approving again.</p>}
        <div className="row end">
          <Button variant="outline" disabled={locked} onClick={() => setTarget(null)}>Cancel</Button>
          <Button disabled={disabled || locked || conflict || !confirmed || !note.trim()} onClick={() => action.mutate()}>
            {action.isPending ? 'Creating tasks…' : 'Approve and create tasks'}</Button>
        </div>
      </>}
    </Modal>
  </>;
}
