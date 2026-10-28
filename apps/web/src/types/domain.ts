import { z } from 'zod';

// Frontend demo projections, NOT an agreed mediator wire protocol.
export const taskStatuses = [
  'open',
  'claimed',
  'in_progress',
  'in_review',
  'approved',
  'merged',
  'blocked',
  'conflict',
  'cancelled',
] as const;
export const roles = ['owner', 'reviewer', 'viewer'] as const;
export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(taskStatuses),
  agentId: z.string().nullable(),
  version: z.number().int(),
  threadId: z.string(),
  receipt: z.enum(['pending', 'received']),
  acceptance: z.enum(['pending', 'accepted', 'declined']),
  progress: z.string(),
  dependencies: z.array(z.string()),
  contract: z.object({
    version: z.number().int(),
    summary: z.string(),
    paths: z.array(z.string()),
    criteria: z.array(z.string()),
    history: z.array(z.string()),
  }),
  result: z
    .object({
      head: z.string(),
      branch: z.string(),
      prNumber: z.number().int(),
      evidence: z.array(z.string()),
      mergeCommit: z.string().nullable(),
    })
    .nullable(),
});
export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  client: z.enum(['Codex', 'Claude Code', 'Other']),
  owner: z.string(),
  machine: z.string(),
  capabilities: z.array(z.string()),
  grant: z.enum(['pending', 'active', 'revoked']),
  presence: z.enum(['online', 'stale', 'offline']),
  lastSeen: z.string().nullable(),
  session: z.string().nullable(),
});
export const approvalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  action: z.enum(['Review result', 'Approve contract']),
  status: z.enum(['pending', 'approved', 'rejected', 'stale']),
  taskVersion: z.number().int(),
  contractVersion: z.number().int(),
  head: z.string().nullable(),
  requestedAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  note: z.string(),
});
export const messageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sequence: z.number().int(),
  sender: z.string(),
  type: z.enum(['question', 'answer', 'status', 'result', 'human_note']),
  body: z.string(),
  createdAt: z.string(),
  replyTo: z.string().nullable(),
  receipt: z.enum(['pending', 'received']),
});
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repository: z.string(),
  description: z.string(),
  version: z.number().int(),
  members: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(roles) })),
  invitations: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      role: z.enum(roles),
      status: z.enum(['pending', 'revoked']),
    }),
  ),
  agents: z.array(agentSchema),
  tasks: z.array(taskSchema),
  approvals: z.array(approvalSchema),
  messages: z.array(messageSchema),
  claims: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      agentId: z.string(),
      path: z.string(),
      state: z.enum(['active', 'stale', 'review_reserved', 'released']),
      generation: z.number().int(),
      expiresAt: z.string().nullable(),
    }),
  ),
  activity: z.array(
    z.object({
      id: z.string(),
      sequence: z.number().int(),
      taskId: z.string().nullable(),
      kind: z.string(),
      actor: z.string(),
      text: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export const workspaceSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(projectSchema),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Role = (typeof roles)[number];
export interface DemoUser {
  id: string;
  name: string;
  description: string;
}

export type Command =
  | { type: 'create-project'; name: string; repository: string; description: string }
  | { type: 'update-project'; name: string; repository: string; description: string }
  | { type: 'invite'; email: string; role: Role }
  | { type: 'revoke-invite'; invitationId: string }
  | {
      type: 'add-agent';
      name: string;
      client: Agent['client'];
      owner: string;
      machine: string;
      capabilities: string[];
    }
  | { type: 'revoke-agent'; agentId: string }
  | {
      type: 'create-task';
      title: string;
      description: string;
      agentId: string | null;
      paths: string[];
      criteria: string[];
    }
  | { type: 'cancel-task'; taskId: string }
  | { type: 'send-message'; taskId: string; body: string; replyTo: string | null }
  | {
      type: 'decide';
      approvalId: string;
      decision: 'approved' | 'rejected';
      note: string;
      target: { taskVersion: number; contractVersion: number; head: string | null };
    };

export interface MutationRequest {
  actorId: string;
  projectId: string | null;
  expectedVersion: number | null;
  operationId: string;
  command: Command;
}
export interface MutationResult {
  projectId: string;
  entityId?: string;
}
export interface DashboardApi {
  load(actorId: string): Promise<Workspace>;
  execute(request: MutationRequest): Promise<MutationResult>;
}
export const label = (value: string) =>
  value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
export const roleFor = (project: Project, userId: string) =>
  project.members.find((m) => m.id === userId)?.role;
export const canEdit = (role: Role | undefined) => role === 'owner' || role === 'reviewer';
export const currentApproval = (approval: Approval, task: Task) =>
  approval.taskVersion === task.version &&
  approval.contractVersion === task.contract.version &&
  approval.head === (task.result?.head ?? null);
