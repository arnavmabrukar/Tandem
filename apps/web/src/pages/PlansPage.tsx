import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import { roleFor, type Project } from '../types/domain';
import { planProposalSchema, type PlanProposal, type PlanRevision, type SavePlanRequest } from '../types/plans';
import { Empty, ErrorNotice, Field, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';
import { PlanApproval } from '../components/PlanApproval';
import { Link } from 'react-router-dom';

const newTask = (): PlanProposal['tasks'][number] => ({
  key: `task_${crypto.randomUUID().replaceAll('-', '')}`, title: '', description: '',
  contractSummary: '', paths: [], criteria: [], dependencies: [],
});
type Editor = { planId: string | null; planVersion?: number; projectVersion: number; proposal: PlanProposal };

export function PlansPage({ project }: { project: Project }) {
  const { api, user } = useSession();
  const client = useQueryClient();
  const writable = roleFor(project, user!.id) === 'owner';
  const [editor, setEditor] = useState<Editor | null>(null);
  const [validation, setValidation] = useState<Error | null>(null);
  const [notice, setNotice] = useState('');
  const [goal, setGoal] = useState('');
  const generate = useMutation({
    mutationFn: () => api.generatePlan(project.id, goal.trim()),
    onSuccess: proposal => {
      save.reset(); setValidation(null);
      setEditor({ planId: null, projectVersion: project.version, proposal });
      setNotice('Meta draft generated. Review and edit it, then save. Nothing has been approved.');
    },
    retry: false,
  });
  // Preserve the exact request on uncertain outcomes, including its versions.
  const pending = useRef<{ planId: string | null; body: SavePlanRequest } | null>(null);
  const plans = useQuery({
    queryKey: ['plans', user!.id, project.id],
    queryFn: ({ signal }) => api.listPlans(project.id, signal),
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => {
      if (!pending.current) throw new Error('No draft to save.');
      return api.savePlan(project.id, pending.current.planId, pending.current.body);
    },
    onSuccess: () => {
      pending.current = null;
      setEditor(null);
      setNotice('Draft saved. Review it below.');
      void client.invalidateQueries({ queryKey: ['plans', user!.id, project.id] });
      void client.invalidateQueries({ queryKey: ['workspace', user!.id] });
    },
    onError: (error) => {
      if (error instanceof ApiError && !error.outcomeUnknown) pending.current = null;
      if (error instanceof ApiError && error.status === 409) {
        void plans.refetch();
        void client.invalidateQueries({ queryKey: ['workspace', user!.id] });
      }
    },
    retry: false,
  });
  const uncertain = save.error instanceof ApiError && save.error.outcomeUnknown;
  const conflict = save.error instanceof ApiError && save.error.status === 409;
  const locked = save.isPending || uncertain;
  function open(plan?: PlanRevision) {
    save.reset(); setValidation(null); setNotice('');
    setEditor({ planId: plan?.planId ?? null, planVersion: plan?.planVersion,
      projectVersion: project.version,
      proposal: plan ? structuredClone(plan.proposal) : { goal: '', summary: '', tasks: [newTask()] } });
  }
  function updateTask(index: number, patch: Partial<PlanProposal['tasks'][number]>) {
    setEditor(current => current && ({ ...current, proposal: { ...current.proposal,
      tasks: current.proposal.tasks.map((task, i) => i === index ? { ...task, ...patch } : task) } }));
  }
  return <>
    <PageHeader title="Plans" description="Break a goal into tasks and review the scope before work begins."
      action={<Button disabled={!writable || !!editor || generate.isPending} onClick={() => open()}>New plan</Button>} />
    <p className="notice">Review a draft to create its tasks. Task contracts are reviewed separately before agents can claim work.</p>
    {writable && !editor && <section className="panel">
      <h2>Plan with Meta</h2>
      <p>Describe your goal. Meta receives the goal and this project's name, repository name, and description. Repository files are not read.</p>
      <p className="muted">The configured Contributor model may use submitted content for training. Each generation uses your backend's model API account.</p>
      <form onSubmit={event => { event.preventDefault(); if (!generate.isPending && goal.trim()) generate.mutate(); }}>
        <Field label="What do you want to build?"><textarea required maxLength={10000} value={goal}
          disabled={generate.isPending} onChange={event => setGoal(event.target.value)} /></Field>
        <ErrorNotice error={generate.error} />
        {generate.error && <p>No draft was saved. Trying again makes a new model request.</p>}
        <Button type="submit" disabled={generate.isPending || !goal.trim()}>
          {generate.isPending ? 'Generating plan…' : 'Generate with Meta'}
        </Button>
      </form>
    </section>}
    {notice && <p role="status">{notice}</p>}
    <ErrorNotice error={plans.error} retry={() => void plans.refetch()} />
    {editor && <section className="panel">
      <h2>{editor.planId ? `Edit draft · revision ${editor.planVersion}` : 'New draft'}</h2>
      <form onSubmit={event => {
        event.preventDefault();
        if (locked || conflict || !writable) return;
        // Remove empty lines only on submit so multiline fields stay editable.
        const parsed = planProposalSchema.safeParse({ ...editor.proposal,
          tasks: editor.proposal.tasks.map(task => ({ ...task,
            paths: task.paths.map(p => p.trim()).filter(Boolean),
            criteria: task.criteria.map(c => c.trim()).filter(Boolean) })) });
        if (!parsed.success) {
          setValidation(new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' ')));
          return;
        }
        setValidation(null);
        pending.current = { planId: editor.planId, body: {
          operationId: crypto.randomUUID(), expectedVersion: editor.projectVersion,
          ...(editor.planId ? { expectedPlanVersion: editor.planVersion } : {}), proposal: parsed.data } };
        save.mutate();
      }}>
        <fieldset disabled={!writable || locked}>
          <Field label="Goal"><textarea required maxLength={10000} value={editor.proposal.goal}
            onChange={e => setEditor({ ...editor, proposal: { ...editor.proposal, goal: e.target.value } })} /></Field>
          <Field label="Plan summary"><textarea required maxLength={4000} value={editor.proposal.summary}
            onChange={e => setEditor({ ...editor, proposal: { ...editor.proposal, summary: e.target.value } })} /></Field>
          {editor.proposal.tasks.map((task, index) => <section className="panel" key={task.key}>
            <h3>Task {index + 1}</h3>
            <Field label="Title"><input required maxLength={200} value={task.title}
              onChange={e => updateTask(index, { title: e.target.value })} /></Field>
            <Field label="Instructions"><textarea maxLength={10000} value={task.description}
              onChange={e => updateTask(index, { description: e.target.value })} /></Field>
            <Field label="Agreed scope"><textarea required maxLength={2000} value={task.contractSummary}
              onChange={e => updateTask(index, { contractSummary: e.target.value })} /></Field>
            <Field label="Files" hint="One repository-relative path per line; optional."><textarea value={task.paths.join('\n')}
              onChange={e => updateTask(index, { paths: e.target.value.split('\n') })} /></Field>
            <Field label="Acceptance criteria" hint="One condition per line; at least one required."><textarea required value={task.criteria.join('\n')}
              onChange={e => updateTask(index, { criteria: e.target.value.split('\n') })} /></Field>
            <fieldset><legend>Depends on</legend>
              {editor.proposal.tasks.filter(other => other.key !== task.key).map(other =>
                <label className="row" key={other.key}><input type="checkbox" checked={task.dependencies.includes(other.key)}
                  onChange={e => updateTask(index, { dependencies: e.target.checked
                    ? [...task.dependencies, other.key] : task.dependencies.filter(key => key !== other.key) })} />
                  {other.title || 'Untitled task'}</label>)}
            </fieldset>
            <Button variant="outline" disabled={editor.proposal.tasks.length === 1} onClick={() => {
              setEditor({ ...editor, proposal: { ...editor.proposal,
                tasks: editor.proposal.tasks.filter(t => t.key !== task.key).map(t => ({ ...t,
                  dependencies: t.dependencies.filter(key => key !== task.key) })) } });
            }}>Remove task</Button>
          </section>)}
          <Button variant="outline" disabled={editor.proposal.tasks.length >= 50} onClick={() =>
            setEditor({ ...editor, proposal: { ...editor.proposal, tasks: [...editor.proposal.tasks, newTask()] } })}>Add task</Button>
        </fieldset>
        <ErrorNotice error={validation ?? save.error} retry={uncertain && !save.isPending ? () => save.mutate() : undefined} />
        {conflict && <p role="status">Your draft is preserved. Review the latest saved plan below, then cancel and reopen it before editing again.</p>}
        <div className="row end">
          <Button variant="outline" disabled={locked} onClick={() => { setEditor(null); save.reset(); setValidation(null); }}>Cancel</Button>
          <Button type="submit" disabled={!writable || locked || conflict}>{save.isPending ? 'Saving…' : 'Save draft'}</Button>
        </div>
      </form>
    </section>}
    {plans.isPending && <p role="status">Loading plans…</p>}
    {!plans.isError && plans.data && <>
      <p className="muted">Latest revisions of the 100 most recently created plans.</p>
      {plans.data.length === 0 && <Empty title="No plans yet">Create a draft to outline your next goal.</Empty>}
      {plans.data.map(plan => <section className="panel" key={plan.planId}>
        <div className="row between"><h2>{plan.proposal.goal}</h2><span>{plan.approvedPlanVersion ? 'Approved' : 'Draft'} · revision {plan.planVersion}</span></div>
        <p>{plan.proposal.summary}</p>
        {plan.proposal.tasks.map((task, index) => <details key={task.key}>
          <summary>{index + 1}. {task.title}</summary>
          <p>{task.description}</p><p><strong>Scope:</strong> {task.contractSummary}</p>
          <p><strong>Files:</strong> {task.paths.join(', ') || 'Not specified'}</p>
          <ul>{task.criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
          <p><strong>Depends on:</strong> {task.dependencies.map(key => plan.proposal.tasks.find(t => t.key === key)?.title ?? key).join(', ') || 'None'}</p>
        </details>)}
        {plan.approvedPlanVersion ? <p>Tasks created. <Link to={`/projects/${project.id}/tasks`}>View tasks</Link> · <Link to={`/projects/${project.id}/approvals`}>Review contracts</Link></p> : <div className="row">
          <Button variant="outline" disabled={!writable || !!editor || generate.isPending} onClick={() => open(plan)}>Edit draft</Button>
          <PlanApproval plan={plan} projectVersion={project.version} disabled={!writable || !!editor || generate.isPending} />
        </div>}
      </section>)}
    </>}
  </>;
}
