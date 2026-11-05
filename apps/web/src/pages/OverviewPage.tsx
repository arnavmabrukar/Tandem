import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, LayoutGrid, List, Plus, Search } from 'lucide-react';
import type { Project } from '../types/domain';
import { label } from '../types/domain';
import { Badge, Empty, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';
import {
  ago,
  agentRoster,
  needsYou,
  pipelineStages,
  rankProjects,
  recentEvents,
  type Pipeline,
  type ProjectSummary,
} from './overview';

const NEEDS_YOU_LIMIT = 6;
const AGENT_LIMIT = 5;
const EVENT_LIMIT = 8;

/** A stacked bar plus numbers. The legend states every count, so color never carries one alone. */
function PipelineBar({ pipeline, compact = false }: { pipeline: Pipeline; compact?: boolean }) {
  const total = pipelineStages.reduce((sum, s) => sum + pipeline[s.key], 0);
  const summary = pipelineStages
    .filter((s) => pipeline[s.key] > 0)
    .map((s) => `${pipeline[s.key]} ${s.text.toLowerCase()}`)
    .join(', ');
  return (
    <div
      className={compact ? 'pipeline-bar is-compact' : 'pipeline-bar'}
      role="img"
      aria-label={total ? `${total} tasks: ${summary}` : 'No tasks yet'}
    >
      {pipelineStages.map(
        (s) =>
          pipeline[s.key] > 0 && (
            <span
              key={s.key}
              className={`pipeline-seg seg-${s.key}`}
              style={{ flexGrow: pipeline[s.key] }}
            />
          ),
      )}
    </div>
  );
}

function ProjectCard({ summary, now }: { summary: ProjectSummary; now: number }) {
  const { project, pipeline, lastEvent, state } = summary;
  const total = pipelineStages.reduce((sum, s) => sum + pipeline[s.key], 0);
  const stateBadge = {
    attention: ['badge badge-attention', 'Needs you'],
    working: ['badge badge-in_progress', 'Working'],
    idle: ['badge', 'Idle'],
  }[state];
  const activeAgents = project.agents.filter((a) => a.grant === 'active').length;
  return (
    <li className="project-card">
      <div className="project-card-head">
        <div className="project-card-title">
          <h3>
            <Link className="project-link" to={`/projects/${project.id}/overview`}>
              {project.name}
            </Link>
          </h3>
          <code>{project.repository || 'No repository linked'}</code>
        </div>
        <span className={stateBadge[0]}>{stateBadge[1]}</span>
      </div>

      <p className="project-last" title={lastEvent?.text}>
        {lastEvent ? lastEvent.text : 'No activity recorded yet'}
        {lastEvent && (
          <small>
            {lastEvent.actor} · {ago(lastEvent.createdAt, now)}
          </small>
        )}
      </p>

      <dl className="signal-row">
        <div>
          <dt>In progress</dt>
          <dd>{summary.working}</dd>
        </div>
        <div>
          <dt>Awaiting you</dt>
          <dd>{summary.pendingApprovals}</dd>
        </div>
        <div>
          <dt>Agents online</dt>
          <dd>
            {summary.online}
            <span className="of"> / {activeAgents}</span>
          </dd>
        </div>
      </dl>

      <div className="project-card-foot">
        <PipelineBar pipeline={pipeline} compact />
        <div className="row between">
          <small className="muted">
            {total === 0
              ? 'No tasks yet'
              : `${pipeline.merged} of ${total} ${total === 1 ? 'task' : 'tasks'} merged`}
          </small>
          {project.trackedBranch && (
            <small className="project-branch" title={`Tracked branch: ${project.trackedBranch}`}>
              <GitBranch size={13} aria-hidden="true" />
              <code>{project.trackedBranch}</code>
            </small>
          )}
        </div>
      </div>
    </li>
  );
}

export function OverviewPage({ projects }: { projects: Project[] }) {
  const [search, setSearch] = useState('');
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const now = Date.now();

  const ranked = useMemo(() => rankProjects(projects), [projects]);
  const needs = useMemo(() => needsYou(projects), [projects]);
  const roster = useMemo(() => agentRoster(projects), [projects]);
  const events = useMemo(() => recentEvents(projects, EVENT_LIMIT), [projects]);
  const pipeline = useMemo(() => {
    const total: Pipeline = { open: 0, working: 0, review: 0, attention: 0, merged: 0 };
    for (const s of ranked) for (const { key } of pipelineStages) total[key] += s.pipeline[key];
    return total;
  }, [ranked]);
  const pipelineTotal = pipelineStages.reduce((sum, s) => sum + pipeline[s.key], 0);

  const visible = ranked.filter(
    (s) =>
      (!onlyNeeds || s.state === 'attention') &&
      `${s.project.name} ${s.project.repository}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every project you can access, and what is waiting on you across them."
        action={
          <Button asChild variant="outline">
            <Link to="/projects/new">
              <Plus size={16} aria-hidden="true" /> Create project
            </Link>
          </Button>
        }
      />
      {projects.length === 0 ? (
        <section className="panel">
          <Empty title="No projects yet">
            <Link to="/projects/new">Create a project</Link> from a GitHub repository, or open{' '}
            <Link to="/invitations">your invitations</Link> to join one.
          </Empty>
        </section>
      ) : (
        <div className="overview">
          <aside className="overview-side" aria-label="Across all projects">
            <section className="panel side-panel" aria-labelledby="ov-needs">
              <div className="section-heading">
                <h2 id="ov-needs">Needs you</h2>
                <span className="muted">{needs.length}</span>
              </div>
              {needs.length === 0 ? (
                <p className="muted">Nothing is waiting on a decision.</p>
              ) : (
                <ul className="side-list">
                  {needs.slice(0, NEEDS_YOU_LIMIT).map((item) => (
                    <li key={item.key}>
                      <Link className="side-row" to={item.to}>
                        <span className="side-row-text">
                          <strong>{item.title}</strong>
                          <small>{item.project.name}</small>
                        </span>
                        <span
                          className={
                            item.kind === 'Conflict' || item.kind === 'Blocked'
                              ? `badge badge-${item.kind.toLowerCase()}`
                              : 'badge badge-pending'
                          }
                        >
                          {item.kind}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {needs.length > NEEDS_YOU_LIMIT && (
                <p className="side-more">
                  {needs.length - NEEDS_YOU_LIMIT} more. Open a project’s Workflow to see them.
                </p>
              )}
            </section>

            <section className="panel side-panel" aria-labelledby="ov-agents">
              <div className="section-heading">
                <h2 id="ov-agents">Agents</h2>
                <span className="muted">{roster.rows.length} active</span>
              </div>
              {roster.rows.length === 0 ? (
                <p className="muted">No agent has an active grant yet.</p>
              ) : (
                <>
                  <dl className="signal-row">
                    <div>
                      <dt>Online</dt>
                      <dd>{roster.online}</dd>
                    </div>
                    <div>
                      <dt>Stale</dt>
                      <dd>{roster.stale}</dd>
                    </div>
                    <div>
                      <dt>Offline</dt>
                      <dd>{roster.offline}</dd>
                    </div>
                  </dl>
                  <ul className="side-list">
                    {roster.rows.slice(0, AGENT_LIMIT).map(({ agent, project }) => (
                      <li key={`${project.id}:${agent.id}`}>
                        <Link className="side-row" to={`/projects/${project.id}/agents`}>
                          <span
                            className={`dot ${agent.presence === 'online' ? 'dot-online' : 'dot-off'}`}
                            aria-hidden="true"
                          />
                          <span className="side-row-text">
                            <strong>{agent.name}</strong>
                            <small>
                              {agent.client} · {project.name}
                            </small>
                          </span>
                          <Badge value={agent.presence} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {roster.rows.length > AGENT_LIMIT && (
                    <p className="side-more">{roster.rows.length - AGENT_LIMIT} more in project Agents pages.</p>
                  )}
                </>
              )}
            </section>

            <section className="panel side-panel" aria-labelledby="ov-pipeline">
              <div className="section-heading">
                <h2 id="ov-pipeline">Task pipeline</h2>
                <span className="muted">{pipelineTotal} tasks</span>
              </div>
              {pipelineTotal === 0 ? (
                <p className="muted">No tasks have been created yet.</p>
              ) : (
                <>
                  <PipelineBar pipeline={pipeline} />
                  <dl className="pipeline-legend">
                    {pipelineStages.map((s) => (
                      <div key={s.key}>
                        <dt>
                          <span className={`pipeline-key seg-${s.key}`} aria-hidden="true" />
                          {s.text}
                        </dt>
                        <dd>{pipeline[s.key]}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </section>

            <section className="panel side-panel" aria-labelledby="ov-activity">
              <div className="section-heading">
                <h2 id="ov-activity">Recent activity</h2>
              </div>
              {events.length === 0 ? (
                <p className="muted">The mediator hasn’t recorded any events yet.</p>
              ) : (
                <ul className="side-list">
                  {events.map(({ event, project }) => (
                    <li key={`${project.id}:${event.id}`}>
                      <Link
                        className="side-row is-event"
                        to={
                          event.taskId
                            ? `/projects/${project.id}/tasks/${event.taskId}`
                            : `/projects/${project.id}/overview`
                        }
                      >
                        <span className="side-row-text">
                          <span className="event-text">{event.text}</span>
                          <small>
                            {event.actor} · {project.name} · {ago(event.createdAt, now)}
                          </small>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>

          <section className="overview-main" aria-labelledby="ov-projects">
            <div className="projects-bar">
              <h2 id="ov-projects">
                Projects <span className="muted">{visible.length}</span>
              </h2>
              <div className="projects-tools">
                <div className="search-field">
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search projects"
                    placeholder="Search projects"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="tool-toggle"
                  aria-pressed={onlyNeeds}
                  onClick={() => setOnlyNeeds((v) => !v)}
                >
                  Needs you only
                </button>
                <div className="view-toggle" role="group" aria-label="Layout">
                  {(
                    [
                      ['grid', LayoutGrid],
                      ['list', List],
                    ] as const
                  ).map(([key, Icon]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={view === key}
                      aria-label={`${label(key)} view`}
                      title={`${label(key)} view`}
                      onClick={() => setView(key)}
                    >
                      <Icon size={16} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {visible.length === 0 ? (
              <section className="panel">
                <Empty title="No projects match">Clear the search or the “Needs you only” filter.</Empty>
              </section>
            ) : (
              <ul className={view === 'list' ? 'project-grid is-list' : 'project-grid'}>
                {visible.map((summary) => (
                  <ProjectCard key={summary.project.id} summary={summary} now={now} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
