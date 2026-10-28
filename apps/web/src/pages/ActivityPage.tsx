import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Bot, CheckCheck, ClipboardList, TriangleAlert } from 'lucide-react';
import type { Project } from '../types/domain';
import { PageHeader, Badge, Empty, Timestamp, Field } from '../components/common';
import { Button } from '../components/ui/button';

export function ActivityPage({ project }: { project: Project }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const pending = project.approvals.filter((a) => a.status === 'pending').length;
  const attention = project.tasks.filter((t) => ['blocked', 'conflict'].includes(t.status));
  const events = [...project.activity]
    .reverse()
    .filter(
      (a) =>
        (filter === 'all' || a.kind === filter) &&
        `${a.text} ${a.actor}`.toLowerCase().includes(search.toLowerCase()),
    );
  const stats = [
    {
      title: 'Active tasks',
      count: project.tasks.filter((t) => !['merged', 'cancelled'].includes(t.status)).length,
      icon: ClipboardList,
      to: 'tasks',
      hint: 'Assignments and progress',
    },
    {
      title: 'Awaiting review',
      count: pending,
      icon: CheckCheck,
      to: 'approvals',
      hint: 'Human decisions needed',
    },
    {
      title: 'Needs attention',
      count: attention.length,
      icon: TriangleAlert,
      to: 'tasks?status=attention',
      hint: 'Blocked or conflicting work',
    },
    {
      title: 'Agent records',
      count: project.agents.length,
      icon: Bot,
      to: 'agents',
      hint: 'Demo connection signals',
    },
  ];
  return (
    <>
      <PageHeader
        title="Activity"
        description={`${project.name} · ${project.description || 'Shared project coordination'}`}
        action={
          <Button asChild variant="outline">
            <Link to={`/projects/${project.id}/tasks`}>
              View tasks <ArrowUpRight size={16} />
            </Link>
          </Button>
        }
      />
      <div className="stats-grid">
        {stats.map(({ title, count, icon: Icon, to, hint }) => (
          <Link className="stat-card" to={`/projects/${project.id}/${to}`} key={title}>
            <div className="row between">
              <span>{title}</span>
              <Icon size={18} />
            </div>
            <strong>{count}</strong>
            <small>{hint}</small>
          </Link>
        ))}
      </div>
      {attention.length > 0 && (
        <section className="panel attention">
          <div className="section-heading">
            <h2>Needs a closer look</h2>
            <Badge value="attention" />
          </div>
          {attention.map((task) => (
            <Link
              key={task.id}
              className="attention-row"
              to={`/projects/${project.id}/tasks/${task.id}`}
            >
              <div>
                <strong>{task.title}</strong>
                <p>{task.progress}</p>
              </div>
              <Badge value={task.status} />
            </Link>
          ))}
        </section>
      )}
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Project timeline</h2>
            <p className="muted">
              Recorded demo events, newest first. No background agent activity is running.
            </p>
          </div>
          <span className="muted">{events.length} events</span>
        </div>
        <div className="filters">
          <Field label="Search activity">
            <input
              type="search"
              placeholder="Event or actor…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Event type">
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All events</option>
              {[...new Set(project.activity.map((a) => a.kind))].sort().map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
          </Field>
        </div>
        {events.length === 0 ? (
          <Empty title="No activity to show">
            Create a task or clear your filters to get started.
          </Empty>
        ) : (
          <ol className="timeline">
            {events.map((event) => (
              <li key={event.id}>
                <span className="timeline-dot" />
                <div>
                  <div className="row wrap">
                    <strong>{event.actor}</strong>
                    <Badge value={event.kind} />
                    <small>#{event.sequence}</small>
                  </div>
                  <p>{event.text}</p>
                  <div className="row wrap muted">
                    <Timestamp value={event.createdAt} />
                    {event.taskId && (
                      <Link to={`/projects/${project.id}/tasks/${event.taskId}`}>Open task →</Link>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
