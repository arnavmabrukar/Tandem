import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Sparkles, LockKeyhole } from 'lucide-react';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { roleFor, type Project } from '../types/domain';
import type { RoomExchange } from '../types/room';
import { Button } from './ui/button';
import { ErrorNotice, Timestamp } from './common';
import { Modal } from './ui/dialog';
import { DraftCard } from './PlanChat';

function Exchange({ item, project }: { item: RoomExchange; project: Project }) {
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
  return <div className="room-exchange">
    <div className={`room-message room-${item.kind}`}>
      <div className="row wrap"><strong>{item.sender}</strong><span className="chat-caption">{item.kind === 'human' ? 'Human · hidden from agents' : 'Agent → Mediator'}</span><Timestamp value={item.createdAt} /></div>
      <p className="room-body">{item.body}</p>
    </div>
    <div className="room-message room-mediator">
      <div className="row"><Sparkles size={17} /><strong>Mediator</strong>{item.kind === 'human' && <span className="chat-caption">Hidden from agents</span>}</div>
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
    </div>
    <Modal open={!!cancelId} onOpenChange={v => { if (!action.isPending && !v) setCancelId(null); }} title="Cancel this task?" description="This changes the shared project. Only tasks that have not been claimed can be cancelled here.">
      <p>{project.tasks.find(t => t.id === cancelId)?.title}</p><ErrorNotice error={action.error} />
      <Button disabled={action.isPending} onClick={async () => { if (!cancelId) return; try { await action.mutateAsync({ type: 'cancel-task', taskId: cancelId }); setCancelId(null); } catch { /* Keep review open. */ } }}>Confirm cancellation</Button>
    </Modal>
  </div>;
}

export function AgentRoom({ project }: { project: Project }) {
  const { api, user } = useSession();
  const client = useQueryClient();
  const key = ['agent-room', user!.id, project.id];
  const room = useQuery({ queryKey: key, queryFn: ({ signal }) => api.readRoom(project.id, signal), refetchInterval: 5000 });
  const [body, setBody] = useState('');
  const pending = useRef<{ operationId: string; body: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const canPost = ['owner', 'reviewer'].includes(roleFor(project, user!.id) ?? '');
  const send = useMutation({ mutationFn: () => api.postRoom(project.id, pending.current!), retry: false,
    onSuccess: () => { setBody(''); pending.current = null; void client.invalidateQueries({ queryKey: key }); },
    onSettled: () => { void client.invalidateQueries({ queryKey: key }); },
  });
  const items = room.data?.exchanges ?? [];
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [items.length, items.at(-1)?.state]);
  function submit() {
    if (!body.trim() || send.isPending || !canPost) return;
    if (!pending.current || pending.current.body !== body.trim()) pending.current = { operationId: crypto.randomUUID(), body: body.trim() };
    send.mutate();
  }
  return <section className="plan-chat agent-room-chat" aria-label="Project room">
    <header className="chat-header"><div className="row"><span className="chat-avatar"><Sparkles size={20} /></span><div><h2>Project room</h2><span className="chat-caption">{project.name} · coordinated by Mediator</span></div></div></header>
    <div className="chat-transcript room-transcript" role="log" aria-live="polite" aria-label="Room conversation">
      <ErrorNotice error={room.error} />
      {room.isPending ? <p>Loading conversation…</p> : items.length === 0 && <div className="chat-welcome"><Sparkles size={30} /><h2>Build together.</h2><p>Ask the mediator for a plan, change direction, or check what’s happening.<br />Your agents can join through their MCP connection.</p></div>}
      {items.map(item => <Exchange key={item.id} item={item} project={project} />)}
      {send.isPending && <p role="status">Mediator is thinking…</p>}<div ref={end} />
    </div>
    <div className="chat-bottom"><ErrorNotice error={send.error} />
      <form className="chat-composer" onSubmit={e => { e.preventDefault(); submit(); }}>
        <textarea aria-label="Message mediator" placeholder={canPost ? 'Message Mediator — plan, ask, or change direction…' : 'Your role can read this room.'} maxLength={8000} value={body} disabled={!canPost || send.isPending} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <Button type="submit" className="chat-send" aria-label="Send message" disabled={!canPost || !body.trim() || send.isPending}><ArrowUp size={20} /></Button>
      </form>
      <p className="chat-footnote"><LockKeyhole size={13} /> Human exchanges are visible to project members, never to agents. Latest 100 exchanges.</p>
    </div>
  </section>;
}
