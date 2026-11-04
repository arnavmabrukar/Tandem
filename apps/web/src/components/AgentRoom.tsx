import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { ArrowUp, Sparkles, LockKeyhole, Trash2 } from 'lucide-react';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import { useAction } from '../hooks/useWorkspace';
import { roleFor, type Project } from '../types/domain';
import type { Room, RoomExchange } from '../types/room';
import { Button } from './ui/button';
import { Badge, ErrorNotice, Timestamp } from './common';
import { Modal } from './ui/dialog';
import { DraftCard } from './PlanChat';
import { MediatorIdentity, RoomAvatar } from './RoomIdentity';

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
  return <div className="room-exchange">
    <div className={`room-message room-${item.kind}`}>
      <div className="row wrap"><RoomAvatar kind={item.kind} client={senderClient} /><strong>{item.sender}</strong><span className="chat-caption">{workerRequest ? `Human → ${workerName} · shared with worker` : item.kind === 'human' ? 'Human · hidden from agents' : 'Agent → Room'}</span><Timestamp value={item.createdAt} /></div>
      <p className="room-body">{item.body}</p>
    </div>
    {/* Completed messages without a response are standalone agent posts. */}
    {!(item.state === 'complete' && item.response === null) && <div className="room-message room-mediator">
      {workerRequest ? <strong>Worker message</strong> : <div className="row wrap"><MediatorIdentity model={item.response ? item.response.model || 'Model not recorded' : mediatorModel} />{item.kind === 'human' && <span className="chat-caption">Hidden from agents</span>}</div>}
      <p className="room-body">{item.response?.reply ?? (item.state === 'failed' ? 'The mediator could not reply. You can try again.' : 'Waiting for the mediator…')}</p>
      {item.state === 'failed' && item.senderUserId === user!.id && <><Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Retrying…' : 'Retry reply'}</Button><ErrorNotice error={retry.error} /></>}
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
  const [recipient, setRecipient] = useState('mediator');
  const [clearTarget, setClearTarget] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
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
  const pending = useRef<{ operationId: string; body: string; taskId: string | null; uncertain?: boolean } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const canPost = ['owner', 'reviewer'].includes(roleFor(project, user!.id) ?? '');
  function completeSend() {
    const submitted = pending.current;
    // A refresh can confirm an earlier send after the user has edited the draft.
    setBody(current => current.trim() === submitted?.body ? '' : current);
    pending.current = null;
  }
  const send = useMutation({ mutationFn: () => {
    const request = pending.current!;
    return request.taskId
      ? api.postRoomWorker(project.id, { operationId: request.operationId, taskId: request.taskId, body: request.body })
      : api.postRoom(project.id, { operationId: request.operationId, body: request.body });
  }, retry: false,
    onSuccess: () => { completeSend(); void client.invalidateQueries({ queryKey: key }); },
    onError: error => {
      if (pending.current && error instanceof ApiError && error.outcomeUnknown) pending.current.uncertain = true;
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: key }); },
  });
  const items = room.data?.exchanges ?? [];
  const work = project.tasks.filter(task => ['claimed', 'in_progress', 'blocked', 'conflict', 'in_review'].includes(task.status));
  const messageable = project.tasks.filter(task => ['claimed', 'in_progress', 'blocked'].includes(task.status)
    && project.agents.some(agent => agent.id === task.agentId && agent.grant === 'active'));
  useEffect(() => {
    // Match the authenticated sender AND operation, never just repeated text.
    // Wait for the POST to settle so its late error cannot overwrite recovery.
    if (!send.isError || !pending.current) return;
    if (items.some(item => item.operationId === pending.current!.operationId
      && item.senderUserId === user!.id && item.kind === 'human' && item.state === 'complete')) {
      completeSend();
      send.reset();
    }
  }, [room.data, send.isError, user!.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [items.length, items.at(-1)?.state]);
  function submit() {
    if (!body.trim() || send.isPending || pending.current?.uncertain || !canPost) return;
    const taskId = recipient === 'mediator' ? null : recipient;
    if (!pending.current || (!pending.current.uncertain && (pending.current.body !== body.trim() || pending.current.taskId !== taskId)))
      pending.current = { operationId: crypto.randomUUID(), body: body.trim(), taskId };
    send.mutate();
  }
  return <section className="plan-chat agent-room-chat" aria-label="Project room">
    <header className="chat-header room-header"><div><h2>Project room</h2><div className="row wrap"><MediatorIdentity model={room.data?.mediatorModel} /><span className="chat-caption">{project.name}</span></div></div>
      {owner && <Button variant="ghost" size="sm" disabled={!items.length || room.isPending || send.isPending || clear.isPending}
        onClick={() => { clear.reset(); setCleared(false); setClearTarget(items.at(-1)!.id); }}><Trash2 size={15} />Clear chat</Button>}
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
    <div className="chat-transcript room-transcript" role="log" aria-live="polite" aria-label="Room conversation">
      <ErrorNotice error={room.error} />
      {cleared && <p role="status">Previous room messages deleted.</p>}
      {room.isPending ? <p>Loading conversation…</p> : items.length === 0 && <div className="chat-welcome"><Sparkles size={30} /><h2>Build together.</h2><p>Ask the mediator for a plan, change direction, or check what’s happening.<br />Your agents can join through their MCP connection.</p></div>}
      {items.map(item => <Exchange key={item.id} item={item} project={project} mediatorModel={room.data?.mediatorModel} />)}
      {send.isPending && <p role="status">Mediator is thinking…</p>}<div ref={end} />
    </div>
    <div className="chat-bottom"><ErrorNotice error={send.error} />
      {send.isError && pending.current?.uncertain && <div className="row wrap"><p>Confirm the previous message before sending another. Your edited draft will be kept.</p>
        <Button variant="outline" onClick={() => send.mutate()}>Retry previous message</Button></div>}
      <form className="chat-composer" onSubmit={e => { e.preventDefault(); submit(); }}>
        <label className="room-recipient">Send to <select aria-label="Chat recipient" value={recipient} disabled={!canPost || send.isPending} onChange={e => setRecipient(e.target.value)}>
          <option value="mediator">Mediator · private</option>
          {messageable.map(task => <option key={task.id} value={task.id}>{project.agents.find(agent => agent.id === task.agentId)?.name ?? 'Worker'} · {task.title}</option>)}
        </select></label>
        <textarea aria-label={recipient === 'mediator' ? 'Message mediator' : 'Message working agent'} placeholder={canPost ? recipient === 'mediator' ? 'Message Mediator — plan, ask, or change direction…' : 'Ask this worker a question or give an in-scope instruction…' : 'Your role can read this room.'} maxLength={8000} value={body} disabled={!canPost || send.isPending} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <Button type="submit" className="chat-send" aria-label="Send message" disabled={!canPost || !body.trim() || send.isPending || pending.current?.uncertain}><ArrowUp size={20} /></Button>
      </form>
      <p className="chat-footnote"><LockKeyhole size={13} /> {recipient === 'mediator' ? 'Mediator messages stay hidden from agents.' : 'Only this message is shared with the selected worker. It can reply after its current coding step or when it resumes.'} Latest 100 exchanges.</p>
    </div>
    <Modal open={clearTarget !== null} onOpenChange={open => { if (!open && !clear.isPending) setClearTarget(null); }}
      title="Delete previous room messages?" description="This permanently deletes earlier human, agent, and mediator messages for everyone in this project, including older history. Saved plans, tasks, and approvals stay intact.">
      <p>New messages arriving while this dialog is open will remain. This cannot be undone.</p>
      <ErrorNotice error={clear.error} />
      <div className="row end"><Button variant="outline" disabled={clear.isPending} onClick={() => setClearTarget(null)}>Cancel</Button>
        <Button variant="destructive" disabled={!owner || clear.isPending} onClick={() => clear.mutate()}>{clear.isPending ? 'Deleting…' : 'Delete messages'}</Button></div>
    </Modal>
  </section>;
}
