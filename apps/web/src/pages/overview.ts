import type { Project, Task } from '../types/domain';

// Pure derivations for the Overview page. Everything here comes from the workspace snapshot the
// server returned; nothing is estimated, seeded or invented.

export const pipelineStages = [
  { key: 'open', text: 'Open' },
  { key: 'working', text: 'In progress' },
  { key: 'review', text: 'In review' },
  { key: 'attention', text: 'Needs attention' },
  { key: 'merged', text: 'Merged' },
] as const;
export type PipelineKey = (typeof pipelineStages)[number]['key'];
export type Pipeline = Record<PipelineKey, number>;

export function stageOf(task: Task): PipelineKey | null {
  switch (task.status) {
    case 'open':
      return 'open';
    case 'claimed':
    case 'in_progress':
      return 'working';
    case 'in_review':
    case 'approved':
      return 'review';
    case 'blocked':
    case 'conflict':
      return 'attention';
    case 'merged':
      return 'merged';
    default:
      return null; // Cancelled work isn't part of the pipeline.
  }
}

export function pipelineOf(tasks: Task[]): Pipeline {
  const counts: Pipeline = { open: 0, working: 0, review: 0, attention: 0, merged: 0 };
  for (const task of tasks) {
    const stage = stageOf(task);
    if (stage) counts[stage] += 1;
  }
  return counts;
}

const time = (value: string) => {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

export type ProjectSummary = {
  project: Project;
  pipeline: Pipeline;
  pendingApprovals: number;
  attention: number;
  working: number;
  online: number;
  stale: number;
  lastEvent: Project['activity'][number] | null;
  state: 'attention' | 'working' | 'idle';
};

export function summarize(project: Project): ProjectSummary {
  const pipeline = pipelineOf(project.tasks);
  const pendingApprovals = project.approvals.filter((a) => a.status === 'pending').length;
  const live = project.agents.filter((a) => a.grant === 'active');
  const lastEvent = project.activity.reduce<ProjectSummary['lastEvent']>(
    (latest, event) => (!latest || time(event.createdAt) >= time(latest.createdAt) ? event : latest),
    null,
  );
  const attention = pipeline.attention;
  const state =
    pendingApprovals > 0 || attention > 0 ? 'attention' : pipeline.working > 0 ? 'working' : 'idle';
  return {
    project,
    pipeline,
    pendingApprovals,
    attention,
    working: pipeline.working,
    online: live.filter((a) => a.presence === 'online').length,
    stale: live.filter((a) => a.presence === 'stale').length,
    lastEvent,
    state,
  };
}

/** Projects that need a person first, then the ones with work moving, then the most recently active. */
export function rankProjects(projects: Project[]): ProjectSummary[] {
  const rank = { attention: 0, working: 1, idle: 2 } as const;
  return projects
    .map(summarize)
    .sort(
      (a, b) =>
        rank[a.state] - rank[b.state] ||
        time(b.lastEvent?.createdAt ?? '') - time(a.lastEvent?.createdAt ?? '') ||
        a.project.name.localeCompare(b.project.name),
    );
}

export type NeedsYou = {
  key: string;
  project: Project;
  task: Task | null;
  kind: 'Review result' | 'Approve contract' | 'Blocked' | 'Conflict';
  title: string;
  to: string;
};

export function needsYou(projects: Project[]): NeedsYou[] {
  const items: NeedsYou[] = [];
  for (const project of projects) {
    for (const approval of project.approvals) {
      if (approval.status !== 'pending') continue;
      const task = project.tasks.find((t) => t.id === approval.taskId) ?? null;
      items.push({
        key: `approval:${project.id}:${approval.id}`,
        project,
        task,
        kind: approval.action,
        title: task?.title ?? 'Task no longer listed',
        to: `/projects/${project.id}/workflow?stage=${approval.action === 'Approve contract' ? 'scope' : 'review'}`,
      });
    }
    for (const task of project.tasks) {
      if (task.status !== 'blocked' && task.status !== 'conflict') continue;
      items.push({
        key: `task:${project.id}:${task.id}`,
        project,
        task,
        kind: task.status === 'blocked' ? 'Blocked' : 'Conflict',
        title: task.title,
        to: `/projects/${project.id}/tasks/${task.id}`,
      });
    }
  }
  return items;
}

export function agentRoster(projects: Project[]) {
  const rank = { online: 0, stale: 1, offline: 2 } as const;
  const rows = projects.flatMap((project) =>
    project.agents
      .filter((agent) => agent.grant === 'active')
      .map((agent) => ({ agent, project })),
  );
  rows.sort(
    (a, b) =>
      rank[a.agent.presence] - rank[b.agent.presence] ||
      time(b.agent.lastSeen ?? '') - time(a.agent.lastSeen ?? ''),
  );
  const count = (presence: 'online' | 'stale' | 'offline') =>
    rows.filter((r) => r.agent.presence === presence).length;
  return { rows, online: count('online'), stale: count('stale'), offline: count('offline') };
}

export function recentEvents(projects: Project[], limit: number) {
  return projects
    .flatMap((project) => project.activity.map((event) => ({ event, project })))
    .sort((a, b) => time(b.event.createdAt) - time(a.event.createdAt) || b.event.sequence - a.event.sequence)
    .slice(0, limit);
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'narrow' });
/** "7m ago" for recent times and a short date once it is older than a week. */
export function ago(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'No activity yet';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return 'Time not recorded';
  const diff = now - ms;
  if (diff < 60_000) return 'Just now';
  if (diff > 7 * 86_400_000)
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const [unit, size] = units.find(([, s]) => diff >= s) ?? units[units.length - 1];
  return relative.format(-Math.floor(diff / size), unit);
}
