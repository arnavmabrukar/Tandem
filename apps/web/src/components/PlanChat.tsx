import { useState, useRef, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUp, Sparkles, Plus, MessageSquare, ListChecks, Compass } from 'lucide-react';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import type { Project } from '../types/domain';
import { planProposalSchema, planRevisionSchema, type PlanProposal, type PlanRevision, type SavePlanRequest } from '../types/plans';
import { Button } from './ui/button';
import { ErrorNotice } from './common';
import { PlanApproval } from './PlanApproval';

type Message = { role: 'user' | 'assistant'; content: string; proposal?: PlanProposal; saved?: PlanRevision; approved?: boolean };

export function DraftCard({ proposal, project, disabled, message, onUpdate, saveDraft }: { proposal: PlanProposal; project: Project; disabled: boolean; message: Message; onUpdate: (patch: Partial<Message>) => void; saveDraft?: () => Promise<PlanRevision> }) {
  const { api, user } = useSession();
  const client = useQueryClient();
  const pending = useRef<SavePlanRequest | null>(null);
  const [approved, setApproved] = useState(message.approved ?? false);
  const [saved, setSaved] = useState<PlanRevision | null>(message.saved ?? null);
  useEffect(() => {
    if (message.saved) setSaved(message.saved);
    if (message.approved) setApproved(true);
  }, [message.saved, message.approved]);
  const save = useMutation({
    mutationFn: () => {
      if (saveDraft) return saveDraft();
      // A retry reuses the operation ID so an uncertain save cannot duplicate the plan.
      pending.current ??= { operationId: crypto.randomUUID(), expectedVersion: project.version, proposal };
      return api.savePlan(project.id, null, pending.current);
    },
    onSuccess: result => {
      const revision = saveDraft ? result as PlanRevision : { ...result, createdBy: user!.id, createdAt: new Date().toISOString(), approvedPlanVersion: null, proposal };
      setSaved(revision); onUpdate({ saved: revision });
      void client.invalidateQueries({ queryKey: ['plans', user!.id, project.id] });
      void client.invalidateQueries({ queryKey: ['workspace', user!.id] });
    },
    onError: error => {
      if (error instanceof ApiError && !error.outcomeUnknown) pending.current = null;
    }, retry: false,
  });
  return <section className="panel chat-draft">
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
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (composer.current) {
      composer.current.style.height = 'auto';
      composer.current.style.height = `${Math.min(composer.current.scrollHeight, 180)}px`;
    }
  }, [input]);
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
  useEffect(() => {
    const area = transcript.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [messages, chat.isPending]);
  function send() {
    if (disabled || chat.isPending || !input.trim()) return;
    // Include structured drafts in context so follow-up edits preserve their task keys.
    request.current = [...messages.slice(-8), { role: 'user', content: input.trim() }];
    chat.mutate();
  }
  const suggestions = [
    { icon: ListChecks, title: 'Plan a feature', prompt: 'Help me break our next feature into a clear plan with tasks.' },
    { icon: MessageSquare, title: 'Explore an idea', prompt: 'I have an idea for this project. Help me think through the approach.' },
    { icon: Compass, title: 'Find my way around', prompt: 'Guide me through Tandem and how to get my agents working on tasks.' },
  ];
  return <section className="plan-chat" aria-label="Plan with Meta">
    <header className="chat-header">
      <div className="row"><span className="chat-avatar"><Sparkles size={18} /></span>
        <div><h2>Meta</h2><span className="chat-caption">Your planning partner</span></div></div>
      <Button variant="ghost" size="sm" disabled={chat.isPending} onClick={() => {
        setMessages([]); chat.reset(); setInput(''); composer.current?.focus();
      }}><Plus size={16} />New chat</Button>
    </header>
    <div ref={transcript} className="chat-transcript" role="log" aria-label="Conversation" aria-live="polite" aria-busy={chat.isPending}>
      {messages.length === 0 && !chat.isPending && <div className="chat-welcome">
        <span className="chat-welcome-icon"><Sparkles size={28} /></span>
        <span className="chat-eyebrow">LET’S BUILD SOMETHING</span>
        <h2>What’s the plan?</h2>
        <p>Talk through an idea. Turn it into tasks.<br />Decide what happens next.</p>
        <div className="chat-suggestions">{suggestions.map(({ icon: Icon, title, prompt }) =>
          <button key={title} type="button" disabled={disabled} onClick={() => { setInput(prompt); composer.current?.focus(); }}>
            <Icon size={18} /><span>{title}</span><span aria-hidden="true">↗</span>
          </button>)}</div>
      </div>}
      <div className="chat-messages">
        {messages.map((message, index) => <article key={index} className={`chat-message chat-message-${message.role}`}>
          <span className="chat-speaker">{message.role === 'user' ? 'You' : <><Sparkles size={14} /> Meta</>}</span>
          <div className="chat-bubble">{message.content}</div>
          {message.proposal && <DraftCard proposal={message.proposal} project={project} disabled={disabled || chat.isPending} message={message}
            onUpdate={patch => setMessages(current => current.map((item, i) => i === index ? { ...item, ...patch } : item))} />}
        </article>)}
        {chat.isPending && <>
          <article className="chat-message chat-message-user"><span className="chat-speaker">You</span><div className="chat-bubble">{input}</div></article>
          <div className="chat-thinking" role="status"><Sparkles size={16} /><span>Thinking through your idea</span><span className="chat-dots" aria-hidden="true">•••</span></div>
        </>}
      </div>
    </div>
    <div className="chat-bottom">
      <ErrorNotice error={chat.error} />
      {chat.error && <p className="chat-caption">Your message is preserved. Try sending it again.</p>}
      <form className="chat-composer" onSubmit={event => { event.preventDefault(); send(); }}>
        <label className="sr-only" htmlFor="meta-message">Message Meta</label>
        <textarea id="meta-message" ref={composer} rows={1} value={input} maxLength={10000} required disabled={disabled || chat.isPending}
          placeholder="Ask Meta to help you plan…" onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
          }} />
        <div className="chat-composer-actions"><span>Shift + Enter for a new line</span>
          <Button className="chat-send" type="submit" aria-label="Send message" disabled={disabled || chat.isPending || !input.trim()}><ArrowUp size={20} /></Button>
        </div>
      </form>
      <div className="chat-footnote"><span>Review and approve plans before work begins.</span>
        <details><summary>About this chat</summary><p>Saved in this browser tab. Messages and project details are sent to Meta. Repository files are not read.</p></details>
      </div>
    </div>
  </section>;
}
