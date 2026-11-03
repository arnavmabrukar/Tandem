import { useState, useRef, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import type { Project } from '../types/domain';
import { planProposalSchema, planRevisionSchema, type PlanProposal, type PlanRevision, type SavePlanRequest } from '../types/plans';
import { Button } from './ui/button';
import { ErrorNotice, Field } from './common';
import { PlanApproval } from './PlanApproval';

type Message = { role: 'user' | 'assistant'; content: string; proposal?: PlanProposal; saved?: PlanRevision; approved?: boolean };

function DraftCard({ proposal, project, disabled, message, onUpdate }: { proposal: PlanProposal; project: Project; disabled: boolean; message: Message; onUpdate: (patch: Partial<Message>) => void }) {
  const { api, user } = useSession();
  const client = useQueryClient();
  const pending = useRef<SavePlanRequest | null>(null);
  const [approved, setApproved] = useState(message.approved ?? false);
  const [saved, setSaved] = useState<PlanRevision | null>(message.saved ?? null);
  const save = useMutation({
    mutationFn: () => {
      // A retry reuses the operation ID so an uncertain save cannot duplicate the plan.
      pending.current ??= { operationId: crypto.randomUUID(), expectedVersion: project.version, proposal };
      return api.savePlan(project.id, null, pending.current);
    },
    onSuccess: result => {
      const revision = { ...result, createdBy: user!.id, createdAt: new Date().toISOString(), approvedPlanVersion: null, proposal };
      setSaved(revision); onUpdate({ saved: revision });
      void client.invalidateQueries({ queryKey: ['plans', user!.id, project.id] });
      void client.invalidateQueries({ queryKey: ['workspace', user!.id] });
    },
    onError: error => {
      if (error instanceof ApiError && !error.outcomeUnknown) pending.current = null;
    }, retry: false,
  });
  return <section className="panel">
    <h3>{proposal.goal}</h3><p>{proposal.summary}</p>
    {proposal.tasks.map(task => <details key={task.key}>
      <summary>{task.title}</summary><p>{task.description}</p><p>Scope: {task.contractSummary}</p>
      <p>Files: {task.paths.join(', ') || 'Not specified'}</p>
      <ul>{task.criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
      <p>Depends on: {task.dependencies.map(key => proposal.tasks.find(t => t.key === key)?.title ?? key).join(', ') || 'None'}</p>
    </details>)}
    <ErrorNotice error={save.error} />
    {approved ? <p>Tasks created. <Link to={`/projects/${project.id}/tasks`}>View tasks</Link></p> : saved ? <>
      <p>Draft saved. Review its exact scope before creating tasks.</p>
      <PlanApproval plan={saved} projectVersion={project.version} disabled={disabled} onApproved={() => { setApproved(true); onUpdate({ approved: true }); }} />
    </> : <Button disabled={disabled || save.isPending} onClick={() => save.mutate()}>
      {save.isPending ? 'Saving…' : save.error ? 'Retry saving draft' : 'Save for approval'}
    </Button>}
  </section>;
}

export function PlanChat({ project, disabled }: { project: Project; disabled: boolean }) {
  const { api, user } = useSession();
  const storageKey = `tandem-plan-chat:${user!.id}:${project.id}`;
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is Message => item && ['user', 'assistant'].includes(item.role)
        && (!item.saved || planRevisionSchema.safeParse(item.saved).success) && typeof item.content === 'string' && (!item.proposal || planProposalSchema.safeParse(item.proposal).success)).slice(-18);
    } catch { return []; }
  });
  const [input, setInput] = useState('');
  const request = useRef<Message[]>([]);
  const chat = useMutation({
    mutationFn: () => {
      const context = request.current.map(({ role, content, proposal }) => ({ role,
        content: proposal ? `${content}\nProposed plan: ${JSON.stringify(proposal)}` : content }));
      if (context.some(message => message.content.length > 12000) || context.reduce((n, message) => n + message.content.length, 0) > 40000)
        throw new Error('This conversation is too long. Save any draft you want to keep, then start a new chat.');
      return api.chatPlan(project.id, context);
    },
    onSuccess: response => {
      setMessages([...request.current, { role: 'assistant', content: response.reply,
        ...(response.proposal ? { proposal: response.proposal } : {}) }]);
      setInput('');
    }, retry: false,
  });
  useEffect(() => {
    // Keep this tab's conversation across refreshes, scoped to its user and project.
    try { sessionStorage.setItem(storageKey, JSON.stringify(messages)); } catch { /* Storage may be disabled. */ }
  }, [messages, storageKey]);
  function send() {
    if (disabled || chat.isPending || !input.trim()) return;
    // Include structured drafts in context so follow-up edits preserve their task keys.
    request.current = [...messages.slice(-8), { role: 'user', content: input.trim() }];
    chat.mutate();
  }
  return <section className="panel">
    <div className="row between"><h2>Plan with Meta</h2>
      <Button variant="outline" disabled={chat.isPending} onClick={() => { setMessages([]); chat.reset(); setInput(''); }}>New chat</Button></div>
    <p>Ask about Tandem, talk through an idea, or ask for a plan you can approve.</p>
    <p className="muted">Chat is saved in this browser tab. Messages and project details are sent to the configured Meta model. Repository files are not read.</p>
    <nav className="row" aria-label="Planning shortcuts">
      <Link to={`/projects/${project.id}/tasks`}>Tasks</Link>
      <Link to={`/projects/${project.id}/agents`}>Agents</Link>
      <Link to={`/projects/${project.id}/approvals`}>Approvals</Link>
    </nav>
    <div aria-live="polite">
      {messages.map((message, index) => <article key={index}>
        <h3>{message.role === 'user' ? 'You' : 'Meta'}</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p>
        {message.proposal && <DraftCard proposal={message.proposal} project={project} disabled={disabled || chat.isPending} message={message}
          onUpdate={patch => setMessages(current => current.map((item, i) => i === index ? { ...item, ...patch } : item))} />}
      </article>)}
      {chat.isPending && <p role="status">Meta is thinking…</p>}
    </div>
    <form onSubmit={event => { event.preventDefault(); send(); }}>
      <Field label="Message Meta"><textarea value={input} maxLength={10000} required disabled={disabled || chat.isPending}
        placeholder="Help me plan our next feature…" onChange={event => setInput(event.target.value)} /></Field>
      <ErrorNotice error={chat.error} />
      {chat.error && <p>Your message is preserved. Sending again makes a new model request.</p>}
      <Button type="submit" disabled={disabled || chat.isPending || !input.trim()}>Send</Button>
    </form>
  </section>;
}
