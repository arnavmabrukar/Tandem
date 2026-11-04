import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AlertCircle, ArrowUp, Sparkles, LockKeyhole, Trash2, Terminal } from 'lucide-react';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import { useAction } from '../hooks/useWorkspace';
import { roleFor, type Project } from '../types/domain';
import type { Room, RoomExchange } from '../types/room';
import { Button } from './ui/button';
import { Badge, ErrorNotice, Field, Timestamp } from './common';
import { Modal } from './ui/dialog';
import { DraftCard } from './PlanChat';
import { MediatorIdentity, RoomAvatar } from './RoomIdentity';

function TaskUpdate({ item, project }: { item: RoomExchange; project: Project }) {
  const { user } = useSession();
  const action = useAction(project);
  const [note, setNote] = useState('');
  const event = item.taskEvent!;
  const task = project.tasks.find(candidate => candidate.id === event.taskId);
  if (!task) return <p className="small muted">This task is no longer available.</p>;
  const review = event.status === 'in_review';
  // A historical card must never accept a newer submission after polling.
  const current = task.status === 'in_review' && task.version === event.taskVersion
    && task.agentId === item.senderAgentId;
  const canReview = ['owner', 'reviewer'].includes(roleFor(project, user!.id) ?? '');
  async function decide(decision: 'accept' | 'request_changes') {
    try {
      await action.mutateAsync({ type: 'review-task', taskId: event.taskId, decision,
        expectedTaskVersion: event.taskVersion, note: note.trim() || null });
      setNote('');
    } catch { /* Keep the note and the same operation available for retry. */ }
  }
  return <section className="room-task-update" aria-label={`Task update: ${task.title}`}>
    <div className="row wrap"><Link to={`/projects/${project.id}/tasks/${task.id}`}>{task.title}</Link><Badge value={task.status} /></div>
    {review && <>
      <details><summary>Review details</summary>
        <p>{task.contract.summary}</p>
        <ul>{task.contract.criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
        {task.result && <><p>Commit: <code>{task.result.head}</code> · Branch: {task.result.branch}</p>
          <ul>{task.result.evidence.map((evidence, i) => <li key={i}>{evidence}</li>)}</ul></>}
        <Link to={`/projects/${project.id}/tasks/${task.id}`}>Open task and evidence</Link>
      </details>
      {current && canReview ? <>
        <p className="small muted">Accept to finish this task. Decline returns it to the agent for changes.</p>
        <Field label="Review note" hint="Shared with the agent in its task thread. Required to decline.">
          <textarea value={note} maxLength={10000} disabled={action.isPending} onChange={e => setNote(e.target.value)} />
        </Field>
        <div className="row wrap">
          <Button size="sm" disabled={action.isPending} onClick={() => { void decide('accept'); }}>Accept work</Button>
          <Button size="sm" variant="outline" disabled={action.isPending || !note.trim()} onClick={() => { void decide('request_changes'); }}>Decline</Button>
        </div>
      </> : <p className="small muted">{['approved', 'merged'].includes(task.status) ? 'Work accepted.'
        : !current ? 'This submission is no longer current. Open the task for its latest status.'
        : 'Waiting for an owner or reviewer to decide.'}</p>}
      <ErrorNotice error={action.error} />
    </>}
  </section>;
}

function Exchange({ item, project, mediatorModel }: { item: RoomExchange; project: Project; mediatorModel?: string }) {
  const { api, user } = useSession();
  const client = useQueryClient();
  const action = useAction(project);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => api.postRoom(project.id, { operationId: item.operationId, body: item.body }),
    onSettled: () => { void client.invalidateQueries({ queryKey: ['agent-room', user!.id, project.id] }); },
    retry: false,
  });
  const owner = roleFor(project, user!.id) === 'owner';
  const senderClient = project.agents.find(agent => agent.id === item.senderAgentId)?.client;
  const workerRequest = item.response?.workerRequest;
  const workerName = project.agents.find(agent => agent.id === workerRequest?.agentId)?.name ?? 'worker';
  const legacyDirectMessage = workerRequest && !workerRequest.message;
  return <div className="room-exchange">
    <div className={`room-message room-${item.kind}`}>
      <div className="row wrap"><RoomAvatar kind={item.kind} client={senderClient} /><strong>{item.sender}</strong><span className="chat-caption">{legacyDirectMessage ? `Human → ${workerName} · shared with worker` : item.kind === 'human' ? 'Human → Mediator · hidden from agents' : 'Agent → Mediator'}</span><Timestamp value={item.createdAt} /></div>
      <p className="room-body">{item.body}</p>
      {item.taskEvent && <TaskUpdate item={item} project={project} />}
    </div>
    {/* Completed messages without a response are standalone agent posts. */}
    {!(item.state === 'complete' && item.response === null) && <div className="room-message room-mediator">
      <div className="row wrap"><MediatorIdentity model={item.response ? item.response.model || 'Model not recorded' : mediatorModel} />{item.kind === 'human' && <span className="chat-caption">Hidden from agents</span>}</div>
      {item.state === 'failed' && !item.response
        ? <div className="room-failure">
            <p role="status">{retry.error instanceof ApiError && retry.error.status !== 502 ? retry.error.message
              : retry.isError ? 'The mediator still could not reply.' : 'The mediator could not reply.'}</p>
            {item.senderUserId === user!.id && <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Retrying…' : 'Retry reply'}</Button>}
          </div>
        : <p className="room-body">{item.response?.reply ?? 'Waiting for the mediator…'}</p>}
      {workerRequest?.message && <p className="room-body"><strong>Relayed to {workerName}:</strong> {workerRequest.message}</p>}
      {item.response?.workerRequests?.map(request => <p className="room-body" key={request.id}><strong>Relayed to {project.agents.find(agent => agent.id === request.agentId)?.name ?? 'agent'}:</strong> {request.message}</p>)}
      {item.response?.proposal && <DraftCard project={project} proposal={item.response.proposal}
        disabled={!owner || item.senderUserId !== user!.id} message={{ role: 'assistant', content: item.response.reply,
          saved: item.response.saved, approved: item.response.saved?.approvedPlanVersion === item.response.saved?.planVersion && !!item.response.saved }}
        saveDraft={() => api.saveRoomDraft(project.id, item.id)}
        onUpdate={() => { void client.invalidateQueries({ queryKey: ['agent-room', user!.id, project.id] }); }} />}
      {owner && item.response?.cancelTaskIds.map(id => {
        const task = project.tasks.find(t => t.id === id);
        return task && <div className="room-change" key={id}><span>Suggested change: cancel “{task.title}”</span>
          <Button size="sm" variant="outline" disabled={task.status !== 'open'} onClick={() => { action.reset(); setCancelId(id); }}>{task.status === 'open' ? 'Review change' : `Task is ${task.status}`}</Button></div>;
      })}
    </div>}
    <Modal open={!!cancelId} onOpenChange={v => { if (!action.isPending && !v) setCancelId(null); }} title="Cancel this task?" description="This changes the shared project. Only tasks that have not been claimed can be cancelled here.">
      <p>{project.tasks.find(t => t.id === cancelId)?.title}</p><ErrorNotice error={action.error} />
      <Button disabled={action.isPending} onClick={async () => { if (!cancelId) return; try { await action.mutateAsync({ type: 'cancel-task', taskId: cancelId }); setCancelId(null); } catch { /* Keep review open. */ } }}>Confirm cancellation</Button>
    </Modal>
  </div>;
}

export function AgentRoom({ project, room }: { project: Project; room: UseQueryResult<Room> }) {
  const { api, user } = useSession();
  const client = useQueryClient();
  const key = ['agent-room', user!.id, project.id];
  const [body, setBody] = useState('');
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [clearTarget, setClearTarget] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const owner = roleFor(project, user!.id) === 'owner';
  const clear = useMutation({
    mutationFn: () => api.clearRoom(project.id, clearTarget!),
    onSuccess: () => {
      // Remove confirmed deletions from the cache even if the follow-up read
      // fails. Polling may have added newer messages since confirmation opened.
      client.setQueryData<Room>(key, current => {
        if (!current) return current;
        const boundary = current.exchanges.findIndex(item => item.id === clearTarget);
        return boundary < 0 ? current : { ...current, exchanges: current.exchanges.slice(boundary + 1) };
      });
      setClearTarget(null); setCleared(true);
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: key }); },
    retry: false,
  });
  const pending = useRef<{ operationId: string; body: string; uncertain?: boolean } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const mentionCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    // Restore the caret before another keystroke can arrive after selecting a mention.
    if (mentionCaret.current !== null) {
      composer.current?.focus();
      composer.current?.setSelectionRange(mentionCaret.current, mentionCaret.current);
      mentionCaret.current = null;
    }
  }, [body]);
  const canPost = ['owner', 'reviewer'].includes(roleFor(project, user!.id) ?? '');
  function completeSend() {
    const submitted = pending.current;
    // A refresh can confirm an earlier send after the user has edited the draft.
    setBody(current => current.trim() === submitted?.body ? '' : current);
    setMention(null);
    pending.current = null;
  }
  const send = useMutation({ mutationFn: () => {
    const request = pending.current!;
    return api.postRoom(project.id, { operationId: request.operationId, body: request.body });
  }, retry: false,
    onSuccess: () => { completeSend(); void client.invalidateQueries({ queryKey: key }); },
    onError: error => {
      if (pending.current && error instanceof ApiError && error.outcomeUnknown) pending.current.uncertain = true;
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const items = room.data?.exchanges ?? [];
  // Once this send appears in the conversation, the conversation reports its outcome.
  const sendRecorded = !!pending.current && items.some(item => item.operationId === pending.current!.operationId
    && item.senderUserId === user!.id && item.kind === 'human' && (item.state === 'complete' || item.state === 'failed'));
  const work = project.tasks.filter(task => ['claimed', 'in_progress', 'blocked', 'conflict', 'in_review'].includes(task.status));
  const workingAgents = project.agents.filter(agent => agent.grant === 'active');
  const mentionOptions = mention ? [{ id: 'everyone', name: 'everyone' }, ...workingAgents].filter(agent =>
    agent.name.toLocaleLowerCase().startsWith(mention.query.trimStart().toLocaleLowerCase())).slice(0, 5) : [];
  useEffect(() => {
    // Match the authenticated sender AND operation, never just repeated text.
    // Wait for the POST to settle so its late error cannot overwrite recovery.
    if (!send.isError || !pending.current) return;
    if (sendRecorded) {
      completeSend();
      send.reset();
    }
  }, [room.data, send.isError, user!.id]);
  useEffect(() => {
    // Scroll only the conversation. scrollIntoView would also move the page around it.
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [items.length, items.at(-1)?.state]);
  function submit() {
    if (!body.trim() || send.isPending || pending.current?.uncertain || !canPost) return;
    if (!pending.current || (!pending.current.uncertain && pending.current.body !== body.trim()))
      pending.current = { operationId: crypto.randomUUID(), body: body.trim() };
    send.mutate();
  }
  function updateMention(text: string, caret: number) {
    const match = /(^|\s)@([^@\n]*)$/.exec(text.slice(0, caret));
    setMention(match ? { start: match.index + match[1].length, end: caret, query: match[2] } : null);
  }
  function insertMention(name: string) {
    if (!mention) return;
    const inserted = `@${name} `;
    const caret = mention.start + inserted.length;
    setBody(current => current.slice(0, mention.start) + inserted + current.slice(mention.end));
    setMention(null);
    mentionCaret.current = caret;
  }
  return <section className="plan-chat agent-room-chat" aria-label="Project room">
    <header className="chat-header room-header"><div><h2>Project room</h2><div className="row wrap"><MediatorIdentity model={room.data?.mediatorModel} /><span className="chat-caption">{project.name}</span></div></div>
      <div className="row wrap">
      <Button variant="ghost" size="sm" onClick={() => setCommandsOpen(true)}><Terminal size={15} />Commands</Button>
      {owner && <Button variant="ghost" size="sm" disabled={!items.length || room.isPending || send.isPending || clear.isPending}
        onClick={() => { clear.reset(); setCleared(false); setClearTarget(items.at(-1)!.id); }}><Trash2 size={15} />Clear chat</Button>}
      </div>
    </header>
    {work.length > 0 && <section className="room-work-status" aria-label="Recorded work status">
      <details><summary><strong>Work status · {work.length}</strong><span className="room-work-preview">{work[0].progress || 'Waiting for an agent update.'}</span></summary>
      <Link to={`/projects/${project.id}/workflow?stage=execute`}>View workflow</Link>
      {work.slice(0, 4).map(task => <Link className="room-work-item" key={task.id} to={`/projects/${project.id}/tasks/${task.id}`}>
        <div className="row wrap"><strong>{task.title}</strong><Badge value={task.status} /></div>
        <span>{task.progress || 'Waiting for an agent update.'}</span>
      </Link>)}
      <p className="small muted">Latest recorded progress. Online indicates recent activity; completion estimates come from the agent.</p>
      </details>
    </section>}
    <div ref={transcript} className="chat-transcript room-transcript" role="log" aria-live="polite" aria-label="Room conversation">
      <ErrorNotice error={room.error} />
      {cleared && <p role="status">Previous room messages deleted.</p>}
      {room.isPending ? <p>Loading conversation…</p> : items.length === 0 && <div className="chat-welcome"><Sparkles size={30} /><h2>Build together.</h2><p>Ask the mediator for a plan, a status update, or to relay a question to a working agent.<br />Your agents can join through their MCP connection.</p></div>}
      {items.map(item => <Exchange key={item.id} item={item} project={project} mediatorModel={room.data?.mediatorModel} />)}
      {send.isPending && <p role="status">Mediator is thinking…</p>}
    </div>
    <div className="chat-bottom">
      {send.isError && !sendRecorded && <div className="room-send-error" role="alert">
        <AlertCircle size={15} aria-hidden="true" />
        <span>{pending.current?.uncertain ? 'We couldn’t confirm your last message was sent. Try again before sending another; your draft is kept.' : send.error.message}</span>
        {pending.current?.uncertain && <Button variant="outline" size="sm" onClick={() => send.mutate()}>Try again</Button>}
      </div>}
      <form className="chat-composer" onSubmit={e => { e.preventDefault(); submit(); }}>
        {mentionOptions.length > 0 && <div className="room-mentions" aria-label="Mention an agent or everyone">
          {mentionOptions.map(agent => <button type="button" key={agent.id} onClick={() => insertMention(agent.name)}>@{agent.name}</button>)}
        </div>}
        <textarea ref={composer} aria-label="Message mediator" placeholder={canPost ? 'Message Mediator — use @Agent Name or @everyone…' : 'Your role can read this room.'} maxLength={8000} value={body} disabled={!canPost || send.isPending} onChange={e => { setBody(e.target.value); updateMention(e.target.value, e.target.selectionStart); }} onKeyDown={e => { if (e.key === 'Escape') setMention(null); else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (mentionOptions.length) insertMention(mentionOptions[0].name); else submit(); } }} />
        <Button type="submit" className="chat-send" aria-label="Send message" disabled={!canPost || !body.trim() || send.isPending || pending.current?.uncertain}><ArrowUp size={20} /></Button>
      </form>
      <p className="chat-footnote"><LockKeyhole size={13} /> Use @Agent Name or @everyone to relay a question. /stop @Agent Name finishes current work, then goes idle; /start @Agent Name resumes accepting tasks. Commands require an @recipient. Your messages stay private. Latest 100 exchanges.</p>
    </div>
    <Modal open={commandsOpen} onOpenChange={setCommandsOpen} title="Chat commands"
      description="Talk through the mediator, or control which agents accept new tasks.">
      <dl>
        <dt><strong><code>/stop @Agent Name</code></strong></dt>
        <dd>Finish current work, then stop claiming tasks. The agent posts “I’m idle” when it has finished.</dd>
        <dt><strong><code>/start @Agent Name</code></strong></dt>
        <dd>Allow the agent to accept tasks again. Its terminal worker must be running.</dd>
        <dt><strong><code>@Agent Name your question</code></strong></dt>
        <dd>Ask one agent through the mediator. Its reply appears in this chat after check-in.</dd>
        <dt><strong><code>@everyone your question</code></strong></dt>
        <dd>Relay a question to all eligible project agents, including idle ones.</dd>
      </dl>
      <p>Slash commands require an @recipient. Use <code>/stop @everyone</code> or <code>/start @everyone</code> to control all agents.</p>
      <p className="small muted">Use the agent’s exact name, or type @ to select it. Owners and reviewers can send commands. Stop state survives restarts and clearing chat. Workers need the latest runner; these commands do not launch a closed terminal.</p>
      <div className="row end"><Button variant="outline" onClick={() => setCommandsOpen(false)}>Got it</Button></div>
    </Modal>
    <Modal open={clearTarget !== null} onOpenChange={open => { if (!open && !clear.isPending) setClearTarget(null); }}
      title="Delete previous room messages?" description="This permanently deletes earlier human, agent, and mediator messages for everyone in this project, including older history. Saved plans, tasks, and approvals stay intact.">
      <p>New messages arriving while this dialog is open will remain. This cannot be undone.</p>
      <ErrorNotice error={clear.error} />
      <div className="row end"><Button variant="outline" disabled={clear.isPending} onClick={() => setClearTarget(null)}>Cancel</Button>
        <Button variant="destructive" disabled={!owner || clear.isPending} onClick={() => clear.mutate()}>{clear.isPending ? 'Deleting…' : 'Delete messages'}</Button></div>
    </Modal>
  </section>;
}
