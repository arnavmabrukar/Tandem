import { z } from 'zod';
import { createFixtures, demoUsers } from './fixtures';
import {
  canEdit,
  currentApproval,
  roleFor,
  workspaceSchema,
  type DashboardApi,
  type MutationResult,
  type Project,
  type Workspace,
} from '../types/domain';

export const STORAGE_KEY = 'tandem.frontend-demo.v1';
export class DemoError extends Error {
  constructor(
    public code: 'offline' | 'unavailable' | 'conflict' | 'forbidden' | 'invalid' | 'storage',
    message: string,
  ) {
    super(message);
  }
}
const storedSchema = z.object({
  workspace: workspaceSchema,
  receipts: z.array(
    z.object({
      operationId: z.string(),
      fingerprint: z.string(),
      result: z.object({ projectId: z.string(), entityId: z.string().optional() }),
    }),
  ),
});
type Stored = z.infer<typeof storedSchema>;
export type DemoMode = 'normal' | 'slow' | 'offline';
export interface DemoApi extends DashboardApi {
  setMode(mode: DemoMode): void;
  failNext(): void;
  clearSimulation(): void;
  reset(empty?: boolean): Promise<void>;
  changeReviewHead(projectId: string): Promise<void>;
}
const nonempty = (s: string, name: string, max = 200) => {
  const value = s.trim();
  if (!value || value.length > max)
    throw new DemoError('invalid', `${name} must contain 1–${max} characters.`);
  return value;
};
const repository = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.trim()))
    throw new DemoError('invalid', 'Use a GitHub repository in owner/repository format.');
  return value.trim();
};
const canonicalPath = (value: string) => {
  const path = value.trim();
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((s) => !s || s === '.' || s === '..') ||
    /[*?\[\]]/.test(path)
  )
    throw new DemoError(
      'invalid',
      'Use exact repository-relative paths, without wildcards or .. segments.',
    );
  return path;
};
function addEvent(
  project: Project,
  actor: string,
  kind: string,
  text: string,
  taskId: string | null = null,
) {
  project.activity.push({
    id: crypto.randomUUID(),
    sequence: (project.activity.at(-1)?.sequence ?? 0) + 1,
    taskId,
    actor,
    kind,
    text,
    createdAt: new Date().toISOString(),
  });
}

/** Browser-only test double. Nothing here calls or implements a mediator, auth provider, or agent. */
export function createDemoApi(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  latency = 220,
): DemoApi {
  let mode: DemoMode = 'normal';
  let failure = false;
  const write = (data: Stored) => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      throw new DemoError(
        'storage',
        'Browser storage is unavailable or full. No changes were saved. Free storage or use another browser profile.',
      );
    }
  };
  const read = (): Stored => {
    let raw: string | null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      throw new DemoError(
        'storage',
        'Browser storage is unavailable. Allow local storage to use the demo.',
      );
    }
    if (raw === null) {
      const initial = { workspace: createFixtures(), receipts: [] };
      write(initial);
      return initial;
    }
    try {
      return storedSchema.parse(JSON.parse(raw));
    } catch {
      throw new DemoError(
        'storage',
        'Saved demo data is incompatible or damaged. Use “Reset sample data” in Demo controls to recover.',
      );
    }
  };
  const wait = async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, mode === 'slow' ? Math.max(latency, 1800) : latency),
    );
    if (mode === 'offline')
      throw new DemoError(
        'offline',
        'Demo connection is offline. Switch Demo controls to Normal, then refresh. Your drafts are kept.',
      );
  };
  const lock = async <T>(fn: () => T): Promise<T> => {
    // Only serializes this origin's demo tabs; never a production concurrency guarantee.
    if (typeof navigator !== 'undefined' && navigator.locks)
      return navigator.locks.request(STORAGE_KEY, async () => fn());
    return fn();
  };
  const requireUser = (id: string) => {
    const user = demoUsers.find((u) => u.id === id);
    if (!user) throw new DemoError('forbidden', 'Choose a demo user before continuing.');
    return user;
  };
  return {
    setMode(next) {
      mode = next;
    },
    failNext() {
      failure = true;
    },
    clearSimulation() {
      mode = 'normal';
      failure = false;
    },
    async reset(empty = false) {
      await lock(() => write({ workspace: createFixtures(empty), receipts: [] }));
      failure = false;
    },
    async load(actorId): Promise<Workspace> {
      await wait();
      requireUser(actorId);
      const { workspace } = read();
      return { ...workspace, projects: workspace.projects.filter((p) => roleFor(p, actorId)) };
    },
    async execute(request) {
      await wait();
      if (failure) {
        failure = false;
        throw new DemoError(
          'unavailable',
          'Simulated save failure. Nothing was saved. Retry the same action.',
        );
      }
      return lock(() => {
        const data = read();
        const user = requireUser(request.actorId);
        const command = request.command;
        const project = data.workspace.projects.find((p) => p.id === request.projectId);
        const role = project ? roleFor(project, user.id) : undefined;
        if (command.type !== 'create-project') {
          if (!project || !canEdit(role))
            throw new DemoError('forbidden', 'Your demo role cannot change this project.');
          if (
            ['update-project', 'invite', 'revoke-invite', 'add-agent', 'revoke-agent'].includes(
              command.type,
            ) &&
            role !== 'owner'
          )
            throw new DemoError('forbidden', 'Only the project owner can perform this action.');
        }
        const fingerprint = JSON.stringify({
          actorId: request.actorId,
          projectId: request.projectId,
          expectedVersion: request.expectedVersion,
          command,
        });
        const replay = data.receipts.find((r) => r.operationId === request.operationId);
        if (replay) {
          if (replay.fingerprint !== fingerprint)
            throw new DemoError(
              'conflict',
              'This operation ID was already used for a different action. Refresh before continuing.',
            );
          return replay.result;
        }
        if (
          command.type !== 'create-project' &&
          project &&
          request.expectedVersion !== project.version
        )
          throw new DemoError(
            'conflict',
            'This project changed since you opened it. Refresh and review the latest values before submitting again.',
          );
        const id = crypto.randomUUID();
        const result: MutationResult = {
          projectId: command.type === 'create-project' ? id : project!.id,
          entityId: id,
        };
        if (command.type === 'create-project') {
          data.workspace.projects.push({
            id,
            name: nonempty(command.name, 'Project name', 80),
            repository: repository(command.repository),
            description: command.description.trim().slice(0, 1000),
            version: 1,
            members: [{ id: user.id, name: user.name, role: 'owner' }],
            invitations: [],
            agents: [],
            tasks: [],
            claims: [],
            approvals: [],
            messages: [],
            activity: [],
          });
        } else {
          if (!project) throw new DemoError('invalid', 'Project not found.');
          switch (command.type) {
            case 'update-project':
              project.name = nonempty(command.name, 'Project name', 80);
              project.repository = repository(command.repository);
              project.description = command.description.trim().slice(0, 1000);
              addEvent(project, user.name, 'project', 'Updated demo project details.');
              break;
            case 'invite': {
              const email = z.email().safeParse(command.email.trim());
              if (!email.success) throw new DemoError('invalid', 'Enter a valid email address.');
              if (
                project.invitations.some(
                  (i) =>
                    i.email.toLowerCase() === email.data.toLowerCase() && i.status === 'pending',
                )
              )
                throw new DemoError(
                  'invalid',
                  'A pending demo invitation already exists for this address.',
                );
              project.invitations.push({
                id,
                email: email.data,
                role: command.role,
                status: 'pending',
              });
              addEvent(
                project,
                user.name,
                'project',
                'Created a local invitation record. No email was sent.',
              );
              break;
            }
            case 'revoke-invite': {
              const invite = project.invitations.find((i) => i.id === command.invitationId);
              if (!invite || invite.status !== 'pending')
                throw new DemoError('invalid', 'This invitation is no longer pending.');
              invite.status = 'revoked';
              addEvent(project, user.name, 'project', 'Revoked a demo invitation.');
              break;
            }
            case 'add-agent':
              project.agents.push({
                id,
                name: nonempty(command.name, 'Agent name', 80),
                client: command.client,
                owner: nonempty(command.owner, 'Owner', 80),
                machine: nonempty(command.machine, 'Machine label', 100),
                capabilities: command.capabilities
                  .map((v) => nonempty(v, 'Capability', 80))
                  .slice(0, 12),
                grant: 'pending',
                presence: 'offline',
                lastSeen: null,
                session: null,
              });
              addEvent(
                project,
                user.name,
                'agent',
                'Added a demo agent record; OAuth is not connected.',
              );
              break;
            case 'revoke-agent': {
              const agent = project.agents.find((a) => a.id === command.agentId);
              if (!agent || agent.grant === 'revoked')
                throw new DemoError('invalid', 'This agent grant is unavailable.');
              agent.grant = 'revoked';
              addEvent(
                project,
                user.name,
                'agent',
                `Revoked the demo grant for ${agent.name}. Existing claims still require reconciliation.`,
              );
              break;
            }
            case 'create-task': {
              if (
                command.agentId &&
                !project.agents.some((a) => a.id === command.agentId && a.grant === 'active')
              )
                throw new DemoError('invalid', 'Choose an agent with an active demo grant.');
              project.tasks.push({
                id,
                title: nonempty(command.title, 'Task title', 120),
                description: nonempty(command.description, 'Task description', 4000),
                status: 'open',
                agentId: command.agentId,
                version: 1,
                threadId: `thread-${id}`,
                receipt: 'pending',
                acceptance: 'pending',
                progress: 'Waiting for assignment receipt and acceptance.',
                dependencies: [],
                contract: {
                  version: 1,
                  summary: 'Draft scope for a new task; no agent acceptance yet.',
                  paths: [...new Set(command.paths.map(canonicalPath))],
                  criteria: command.criteria.map((v) => nonempty(v, 'Acceptance criterion', 300)),
                  history: ['v1 — draft task scope'],
                },
                result: null,
              });
              addEvent(project, user.name, 'task', `Created task: ${command.title.trim()}.`, id);
              break;
            }
            case 'cancel-task': {
              const task = project.tasks.find((t) => t.id === command.taskId);
              if (!task || ['merged', 'cancelled'].includes(task.status))
                throw new DemoError('invalid', 'This task cannot be cancelled.');
              task.status = 'cancelled';
              task.version++;
              task.progress = 'Cancelled by a human in the demo. Claims still need reconciliation.';
              project.approvals
                .filter((a) => a.taskId === task.id && a.status !== 'rejected')
                .forEach((a) => {
                  a.status = 'stale';
                });
              addEvent(
                project,
                user.name,
                'task',
                'Cancelled the task; retained claim records for reconciliation.',
                task.id,
              );
              break;
            }
            case 'send-message': {
              if (!project.tasks.some((t) => t.id === command.taskId))
                throw new DemoError('invalid', 'Task not found.');
              if (
                command.replyTo &&
                !project.messages.some(
                  (m) => m.id === command.replyTo && m.taskId === command.taskId,
                )
              )
                throw new DemoError('invalid', 'Reply target does not belong to this thread.');
              const sequence =
                Math.max(
                  0,
                  ...project.messages
                    .filter((m) => m.taskId === command.taskId)
                    .map((m) => m.sequence),
                ) + 1;
              project.messages.push({
                id,
                taskId: command.taskId,
                sequence,
                sender: user.name,
                type: 'human_note',
                body: nonempty(command.body, 'Message', 4000),
                createdAt: new Date().toISOString(),
                replyTo: command.replyTo,
                receipt: 'pending',
              });
              addEvent(
                project,
                user.name,
                'message',
                'Added a human note. Demo agent receipt is pending.',
                command.taskId,
              );
              break;
            }
            case 'decide': {
              const approval = project.approvals.find((a) => a.id === command.approvalId);
              const task = project.tasks.find((t) => t.id === approval?.taskId);
              if (
                !approval ||
                !task ||
                approval.status !== 'pending' ||
                !currentApproval(approval, task) ||
                command.target.taskVersion !== approval.taskVersion ||
                command.target.contractVersion !== approval.contractVersion ||
                command.target.head !== approval.head
              )
                throw new DemoError(
                  'conflict',
                  'The review target changed. Refresh and review the new target; the old target cannot be approved.',
                );
              approval.status = command.decision;
              approval.note = nonempty(command.note, 'Review note', 2000);
              approval.decidedAt = new Date().toISOString();
              approval.decidedBy = user.name;
              // Approval records stay separate from task progress and GitHub merge state.
              addEvent(
                project,
                user.name,
                'approval',
                `${command.decision === 'approved' ? 'Approved' : 'Rejected'} ${approval.action.toLowerCase()} for task v${approval.taskVersion}, contract v${approval.contractVersion}. No GitHub action occurred.`,
                task.id,
              );
              break;
            }
          }
          project.version++;
        }
        data.receipts.push({ operationId: request.operationId, fingerprint, result });
        data.receipts = data.receipts.slice(-100);
        write(data);
        return result;
      });
    },
    async changeReviewHead(projectId) {
      await lock(() => {
        const data = read();
        const project = data.workspace.projects.find((p) => p.id === projectId);
        const approval = project?.approvals.find((a) => a.status === 'pending' && a.head);
        const task = project?.tasks.find((t) => t.id === approval?.taskId);
        if (!project || !approval || !task?.result)
          throw new DemoError(
            'invalid',
            'No pending result review in this project. Reset sample data to try this scenario.',
          );
        approval.status = 'stale';
        task.version++;
        task.result.head = crypto.randomUUID().replaceAll('-', '') + '00000000';
        project.approvals.push({
          ...approval,
          id: crypto.randomUUID(),
          status: 'pending',
          taskVersion: task.version,
          head: task.result.head,
          requestedAt: new Date().toISOString(),
          decidedAt: null,
          decidedBy: null,
          note: '',
        });
        project.version++;
        addEvent(
          project,
          'Demo controls',
          'review',
          'Simulated a new PR head. The previous approval target is stale.',
          task.id,
        );
        write(data);
      });
    },
  };
}
