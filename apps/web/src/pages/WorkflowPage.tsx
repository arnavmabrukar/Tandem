import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCheck, ClipboardList, FileCheck2, Layers2 } from 'lucide-react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useSession } from '../auth/session';
import type { Project } from '../types/domain';
import { Badge, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';
import { PlansPage } from './PlansPage';
import { TasksPage } from './TasksPage';
import { ApprovalsPage } from './ApprovalsPage';

type Stage = 'plan' | 'scope' | 'execute' | 'review';

export function WorkflowRedirect({ project, stage }: { project: Project; stage: Stage | 'approvals' }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (stage === 'approvals') {
    if (params.has('status')) {
      params.set('approvalStatus', params.get('status')!);
      params.delete('status');
    }
    stage = project.approvals.some(a => a.action === 'Approve contract' && a.status === 'pending') ? 'scope' : 'review';
  }
  params.set('stage', stage);
  return <Navigate replace to={`/projects/${project.id}/workflow?${params}`} />;
}

export function WorkflowPage({ project }: { project: Project }) {
  const { api, user } = useSession();
  const [params, setParams] = useSearchParams();
  const requested = params.get('stage');
  // Never change the selected stage when background refreshes change the counts.
  const stage: Stage = requested === 'scope' || requested === 'execute' || requested === 'review' ? requested : 'plan';
  const plans = useQuery({ queryKey: ['plans', user!.id, project.id],
    queryFn: ({ signal }) => api.listPlans(project.id, signal), retry: false });
  const drafts = plans.data?.filter(plan => !plan.approvedPlanVersion).length;
  const scope = project.approvals.filter(a => a.action === 'Approve contract' && a.status === 'pending').length;
  const resultRequests = project.approvals.filter(a => a.action === 'Review result' && a.status === 'pending');
  const ready = project.tasks.filter(task => ['in_review', 'approved'].includes(task.status));
  // A task can have both a submitted result and a pending review request.
  const review = new Set([...resultRequests.map(a => a.taskId), ...ready.map(t => t.id)]).size;
  const active = project.tasks.filter(task => !['merged', 'cancelled'].includes(task.status)).length;
  const completed = project.tasks.filter(task => task.status === 'merged').length;
  const blocked = project.tasks.filter(task => ['blocked', 'conflict'].includes(task.status)).length;
  const next: Stage = review ? 'review' : scope ? 'scope' : blocked ? 'execute' : drafts ? 'plan' : active ? 'execute' : 'plan';
  const stages = [
    { id: 'plan' as const, title: 'Plan', icon: Layers2, description: 'Turn a goal into scoped tasks.', count: drafts ?? '—', caption: plans.isError ? 'unavailable' : drafts === 1 ? 'draft' : 'drafts' },
    { id: 'scope' as const, title: 'Approve scope', icon: FileCheck2, description: 'Confirm contracts before work starts.', count: scope, caption: 'pending' },
    { id: 'execute' as const, title: 'Execute', icon: ClipboardList, description: 'Assign agents and track progress.', count: active, caption: active === 1 ? 'active task' : 'active tasks' },
    { id: 'review' as const, title: 'Review & finish', icon: CheckCheck, description: 'Review results and accept finished work.', count: review, caption: 'to review' },
  ];
  const guidance = {
    plan: { title: drafts ? 'Review your draft plans' : 'Start with a plan', body: 'Describe the goal, review the proposed tasks, then approve a plan to create them.', action: 'Open planning' },
    scope: { title: `${scope} contract${scope === 1 ? '' : 's'} awaiting approval`, body: 'Check the scope and acceptance criteria so agents can start the right work.', action: 'Review scope' },
    execute: { title: blocked ? `${blocked} task${blocked === 1 ? '' : 's'} need attention` : 'Keep work moving', body: 'Open a task to assign an agent, inspect dependencies, or resolve blockers.', action: 'Open tasks' },
    review: { title: `${review} task${review === 1 ? '' : 's'} ready for review`, body: 'Check submitted results, request changes if needed, and accept completed work from its task.', action: 'Review results' },
  }[next];
  function select(value: Stage) {
    const updated = new URLSearchParams(params);
    updated.set('stage', value);
    setParams(updated);
  }
  return <div className="workflow-page">
    <PageHeader title="Workflow" description="One place to plan, approve, execute, and finish the work."
      action={<span className="workflow-completed"><CheckCheck size={16} />{completed} completed</span>} />
    <nav aria-label="Workflow stages" className="workflow-stages">
      <ol>{stages.map(({ id, title, icon: Icon, description, count, caption }, index) => <li key={id}>
        <button type="button" aria-current={stage === id ? 'step' : undefined} aria-controls={`workflow-${id}`} onClick={() => select(id)}>
          <span className="workflow-step-top"><span className="workflow-step-number">{index + 1}</span><Icon size={19} aria-hidden="true" /><ArrowRight size={15} className="workflow-step-arrow" aria-hidden="true" /></span>
          <strong>{title}</strong><span className="workflow-step-description">{description}</span>
          <span className="workflow-count"><b>{count}</b> {caption}</span>
        </button>
      </li>)}</ol>
    </nav>
    <section className="workflow-next" aria-label="Suggested next action">
      <div><p className="eyebrow">Next action</p><h2>{guidance.title}</h2><p>{guidance.body}</p></div>
      <Button variant="outline" onClick={() => select(next)}>{guidance.action}<ArrowRight size={16} /></Button>
    </section>
    {/* Keep panels mounted so changing stages does not erase an unsaved draft or review note. */}
    <div id="workflow-plan" hidden={stage !== 'plan'}><PlansPage project={project} plans={plans} embedded
      onApproved={startNow => select(startNow ? 'execute' : 'scope')} /></div>
    <div id="workflow-scope" hidden={stage !== 'scope'}>
      <ApprovalsPage project={project} kind="contract" embedded />
      <div className="workflow-handoff"><p>Plans approved with “Approve and run” already have approved contracts. Ready tasks can move straight to execution.</p>
        <Button variant="outline" onClick={() => select('execute')}>Continue to execution<ArrowRight size={16} /></Button></div>
    </div>
    <div id="workflow-execute" hidden={stage !== 'execute'}><TasksPage project={project} embedded />
      <div className="workflow-handoff"><p>Agents work on approved scope. When results arrive, review them before accepting the work.</p>
        <Button variant="outline" onClick={() => select('review')}>Continue to review<ArrowRight size={16} /></Button></div>
    </div>
    <div id="workflow-review" hidden={stage !== 'review'}>
      <PageHeader level={2} title="Review & finish" description="Review the code published to the configured branch, request changes, and accept completed work." />
      {ready.length > 0 && <section className="panel" aria-label="Submitted work">
        <h2>Submitted work</h2><p className="muted">Open each task to inspect the result and finish acceptance.</p>
        <div className="workflow-task-list">{ready.map(task => <Link className="workflow-task-row" key={task.id} to={`/projects/${project.id}/tasks/${task.id}`}>
          <div><strong>{task.title}</strong><p className="muted">{task.progress}</p></div><Badge value={task.status} /><span className="workflow-open-task">Open task <ArrowRight size={15} /></span>
        </Link>)}</div>
      </section>}
      <ApprovalsPage project={project} kind="result" embedded />
    </div>
  </div>;
}
