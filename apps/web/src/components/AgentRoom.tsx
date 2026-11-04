import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AlertCircle, ArrowUp, Sparkles, LockKeyhole, Trash2 } from 'lucide-react';
import { useSession } from '../auth/session';
import { ApiError } from '../api/client';
import { useAction } from '../hooks/useWorkspace';
import { roleFor, type Project } from '../types/domain';
import type { Room, RoomExchange } from '../types/room';
import { Button } from './ui/button';
import { ErrorNotice, Timestamp } from './common';
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
  return <div className="room-exchange">
    <div className={`room-message room-${item.kind}`}>
      <div className="row wrap"><RoomAvatar kind={item.kind} client={senderClient} /><strong>{item.sender}</strong><span className="chat-caption">{item.kind === 'human' ? 'Human · hidden from agents' : 'Agent → Mediator'}</span><Timestamp value={item.createdAt} /></div>
      <p className="room-body">{item.body}</p>
    </div>
    {/* Completed messages without a response are standalone agent acknowledgements. */}
    {!(item.state === 'complete' && item.response === null) && <div className="room-message room-mediator">
      <div className="row wrap"><MediatorIdentity model={item.response ? item.response.model || 'Model not recorded' : mediatorModel} />{item.kind === 'human' && <span className="chat-caption">Hidden from agents</span>}</div>
      {item.state === 'failed' && !item.response
        ? <div className="room-failure">
            <p role="status">{retry.error instanceof ApiError && retry.error.status !== 502 ? retry.error.message
              : retry.isError ? 'The mediator still could not reply.' : 'The mediator could not reply.'}</p>
            {item.senderUserId === user!.id && <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Retrying…' : 'Retry reply'}</Button>}
          </div>
        : <p className="room-body">{item.response?.reply ?? 'Waiting for the mediator…'}</p>}
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
  const pending = useRef<{ operationId: string; body: string; uncertain?: boolean } | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const canPost = ['owner', 'reviewer'].includes(roleFor(project, user!.id) ?? '');
  function completeSend() {
    const submitted = pending.current;
    // A refresh can confirm an earlier send after the user has edited the draft.
    setBody(current => current.trim() === submitted?.body ? '' : current);
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
    if (!pending.current || (!pending.current.uncertain && pending.current.body !== body.trim())) pending.current = { operationId: crypto.randomUUID(), body: body.trim() };
    send.mutate();
  }
  return <section className="plan-chat agent-room-chat" aria-label="Project room">
    <header className="chat-header room-header"><div><h2>Project room</h2><div className="row wrap"><MediatorIdentity model={room.data?.mediatorModel} /><span className="chat-caption">{project.name}</span></div></div>
      {owner && <Button variant="ghost" size="sm" disabled={!items.length || room.isPending || send.isPending || clear.isPending}
        onClick={() => { clear.reset(); setCleared(false); setClearTarget(items.at(-1)!.id); }}><Trash2 size={15} />Clear chat</Button>}
    </header>
    <div ref={transcript} className="chat-transcript room-transcript" role="log" aria-live="polite" aria-label="Room conversation">
      <ErrorNotice error={room.error} />
      {cleared && <p role="status">Previous room messages deleted.</p>}
      {room.isPending ? <p>Loading conversation…</p> : items.length === 0 && <div className="chat-welcome"><Sparkles size={30} /><h2>Build together.</h2><p>Ask the mediator for a plan, change direction, or check what’s happening.<br />Your agents can join through their MCP connection.</p></div>}
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
        <textarea aria-label="Message mediator" placeholder={canPost ? 'Message Mediator — plan, ask, or change direction…' : 'Your role can read this room.'} maxLength={8000} value={body} disabled={!canPost || send.isPending} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <Button type="submit" className="chat-send" aria-label="Send message" disabled={!canPost || !body.trim() || send.isPending || pending.current?.uncertain}><ArrowUp size={20} /></Button>
      </form>
      <p className="chat-footnote"><LockKeyhole size={13} /> Human exchanges are visible to project members, never to agents. Latest 100 exchanges.</p>
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
