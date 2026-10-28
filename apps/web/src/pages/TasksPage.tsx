import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useSession } from '../auth/session';
import { useAction } from '../hooks/useWorkspace';
import { canEdit, label, roleFor, taskStatuses, type Project } from '../types/domain';
import { Badge, Empty, ErrorNotice, Field, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';

export function TasksPage({ project }: { project: Project }) {
  const { user } = useSession();
  const writable = canEdit(roleFor(project, user!.id));
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const action = useAction(project);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [agentId, setAgentId] = useState('');
  const [paths, setPaths] = useState('');
  const [criteria, setCriteria] = useState('');
  const search = params.get('q') ?? '';
  const status = params.get('status') ?? 'all';
  const owner = params.get('agent') ?? 'all';
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }
  const tasks = project.tasks.filter(
    (task) =>
      `${task.title} ${task.description}`.toLowerCase().includes(search.toLowerCase()) &&
      (status === 'all' ||
        (status === 'attention'
          ? ['blocked', 'conflict'].includes(task.status)
          : task.status === status)) &&
      (owner === 'all' ||
        (owner === 'unassigned' ? task.agentId === null : task.agentId === owner)),
  );
  const lines = (value: string) =>
    value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Receipt, acceptance, work progress and human review stay separate."
        action={
          <Button
            disabled={!writable}
            onClick={() => {
              action.reset();
              setOpen(true);
            }}
          >
            <Plus size={17} />
            New task
          </Button>
        }
      />
      <section className="panel">
        <div className="filters">
          <Field label="Search tasks">
            <input
              type="search"
              placeholder="Search tasks…"
              value={search}
              onChange={(e) => filter('q', e.target.value)}
            />
          </Field>
          <Field label="Task status">
            <select value={status} onChange={(e) => filter('status', e.target.value)}>
              <option value="all">All statuses</option>
              <option value="attention">Needs attention</option>
              {taskStatuses.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assigned agent">
            <select value={owner} onChange={(e) => filter('agent', e.target.value)}>
              <option value="all">All agents</option>
              <option value="unassigned">Unassigned</option>
              {project.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="ghost" onClick={() => setParams({})}>
            Clear filters
          </Button>
        </div>
        <p className="muted results-count">
          {tasks.length} of {project.tasks.length} tasks
        </p>
        {tasks.length === 0 ? (
          <Empty title="No matching tasks">Try different filters or create the first task.</Empty>
        ) : (
          <div className="task-grid">
            {tasks.map((task) => (
              <Link
                className="task-card"
                to={`/projects/${project.id}/tasks/${task.id}`}
                key={task.id}
              >
                <div className="row between">
                  <Badge value={task.status} />
                  <small>v{task.version}</small>
                </div>
                <h2>{task.title}</h2>
                <p>{task.progress}</p>
                <div className="task-meta">
                  <span>
                    {project.agents.find((a) => a.id === task.agentId)?.name ?? 'Unassigned'}
                  </span>
                  <span>Receipt: {task.receipt}</span>
                  <span>Acceptance: {task.acceptance}</span>
                  <span>
                    {
                      project.claims.filter((c) => c.taskId === task.id && c.state !== 'released')
                        .length
                    }{' '}
                    file reservations
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
      <Modal
        open={open}
        onOpenChange={(v) => {
          if (!action.isPending) setOpen(v);
        }}
        title="Create a demo task"
        description="This adds a local task and draft scope. It does not route work or send an agent a message."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const result = await action.mutateAsync({
                type: 'create-task',
                title,
                description,
                agentId: agentId || null,
                paths: lines(paths),
                criteria: lines(criteria),
              });
              setOpen(false);
              navigate(`/projects/${project.id}/tasks/${result.entityId}`);
            } catch {
              /* Error stays next to the form. */
            }
          }}
        >
          <Field label="Task title">
            <input
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Description">
            <textarea
              required
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="Proposed agent">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Unassigned</option>
              {project.agents
                .filter((a) => a.grant === 'active')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="File scope"
            hint="One exact repository-relative path per line. These are proposed paths, not acquired claims."
          >
            <textarea
              value={paths}
              maxLength={4000}
              onChange={(e) => setPaths(e.target.value)}
              placeholder="apps/web/src/pages/ActivityPage.tsx"
            />
          </Field>
          <Field label="Acceptance criteria" hint="One criterion per line.">
            <textarea
              value={criteria}
              maxLength={4000}
              onChange={(e) => setCriteria(e.target.value)}
            />
          </Field>
          <ErrorNotice error={action.error} />
          <div className="row end">
            <Button variant="outline" disabled={action.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={action.isPending}>
              {action.isPending ? 'Creating…' : 'Create task'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
