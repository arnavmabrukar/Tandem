import { z } from 'zod';

// Human HTTP API v1 projections. Backend implementation contract: apps/web/API.md.
// These are dashboard projections, not agent MCP envelopes or database models.
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
  assignedAgentId: z.string().nullable().optional(),
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
  ownerId: z.string().uuid().optional(),
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
  repository: z.string(),
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
  autoDelegate: z.boolean().optional(),
  id: z.string(),
  name: z.string(),
  repository: z.string(),
  trackedBranch: z.string().nullable().optional(),
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
export const userSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().nullish(),
  emailVerified: z.boolean().optional(),
  signIns: z.array(z.object({ method: z.string().min(1), current: z.boolean() })).optional(),
});
export type User = z.infer<typeof userSchema>;

export type Command =
  | { type: 'auto-delegate'; enabled: boolean }
  | { type: 'create-project'; name: string; repository: string; description: string; githubRepositoryId: number; githubInstallationId: number; trackedBranch: string }
  | { type: 'delete-project' }
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
      // Optional for existing callers; the backend defaults to an empty list.
      dependencies?: string[];
    }
  | { type: 'assign-task'; taskId: string; agentId: string | null; autoSelect?: boolean }
  | { type: 'cancel-task'; taskId: string }
  | { type: 'review-task'; taskId: string; decision: 'accept' | 'request_changes'; note: string | null }
  | { type: 'release-task'; taskId: string; note: string | null }
  | { type: 'send-message'; taskId: string; body: string; replyTo: string | null }
  | {
      type: 'decide';
      approvalId: string;
      decision: 'approved' | 'rejected';
      note: string;
      target: {
        taskVersion: number;
        contractVersion: number;
        head: string | null;
        repository: string;
        action: Approval['action'];
      };
    };

export interface MutationRequest {
  projectId: string | null;
  expectedVersion: number | null;
  operationId: string;
  command: Command;
}
export interface MutationResult {
  projectId: string;
  projectVersion: number;
  entityId?: string;
}
export const mutationResultSchema = z.object({
  projectId: z.string().min(1),
  projectVersion: z.number().int().positive(),
  entityId: z.string().optional(),
});
export interface GitHubRepository { id: number; name: string; fullName: string; defaultBranch: string; description: string }
export interface DashboardApi {
  connectGitHub(): Promise<{url: string}>;
  completeGitHub(code: string, state: string): Promise<{login: string}>;
  githubInstallations(page: number): Promise<{items: {id: number; name: string}[]; hasMore: boolean; installUrl: string}>;
  githubRepositories(installationId: number, page: number): Promise<{items: GitHubRepository[]; hasMore: boolean}>;
  chatPlan(projectId: string, messages: { role: 'user' | 'assistant'; content: string }[]): Promise<{ reply: string; proposal: import('./plans').PlanProposal | null }>;
  generatePlan(projectId: string, goal: string): Promise<import('./plans').PlanProposal>;
  approvePlan(projectId: string, planId: string, body: import('./plans').ApprovePlanRequest): Promise<import('zod').infer<typeof import('./plans').approvedPlanSchema>>;
  listPlans(projectId: string, signal?: AbortSignal): Promise<import('./plans').PlanRevision[]>;
  savePlan(projectId: string, planId: string | null, body: import('./plans').SavePlanRequest):
    Promise<{ projectId: string; projectVersion: number; planId: string; planVersion: number }>;
  issueAgentToken(projectId: string, agentId: string, operationId: string,
    expectedVersion: number): Promise<{ projectId: string; projectVersion: number; entityId: string; token: string }>;
  getCurrentUser(signal?: AbortSignal): Promise<User>;
  updateProfile(name: string): Promise<{ id: string; name: string }>;
  load(signal?: AbortSignal): Promise<Workspace>;
  execute(request: MutationRequest): Promise<MutationResult>;

  // List invitations for the signed-in user's verified email.
  getPendingInvitations(
    signal?: AbortSignal,
  ): Promise<PendingInvitationsResponse>;

  // The caller supplies an operation ID and reuses it on retries.
  acceptInvitation(
    invitationId: string,
    operationId: string,
  ): Promise<AcceptInvitationResult>;
}
/** Up to two letters for an avatar: "Eashan Patel" is EP, and an email uses its first part. */
export const initials = (name: string) => {
  const words = name.split('@')[0].split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const letter = (word: string) => Array.from(word)[0];
  const last = words.length > 1 ? letter(words[words.length - 1]) : '';
  return (letter(words[0]) + last).toUpperCase();
};
export const label = (value: string) =>
  value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
export const roleFor = (project: Project, userId: string) =>
  project.members.find((m) => m.id === userId)?.role;
export const canEdit = (role: Role | undefined) => role === 'owner' || role === 'reviewer';
export const currentApproval = (approval: Approval, task: Task) =>
  approval.taskVersion === task.version &&
  approval.contractVersion === task.contract.version &&
  approval.head === (task.result?.head ?? null);

// Validate each invitation returned by the recipient endpoint.
export const pendingInvitationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  email: z.string().email(),
  role: z.enum(roles),
  expiresAt: z.string().datetime({ offset: true }),
});

// The backend wraps the invitation list in an object.
export const pendingInvitationsResponseSchema = z.object({
  invitations: z.array(pendingInvitationSchema),
});

// Acceptance must identify the invitation that was accepted.
export const acceptInvitationResultSchema = mutationResultSchema.extend({
  entityId: z.string().uuid(),
});

// Derive TypeScript types from the response validation schemas.
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;
export type PendingInvitationsResponse =
  z.infer<typeof pendingInvitationsResponseSchema>;
export type AcceptInvitationResult =
  z.infer<typeof acceptInvitationResultSchema>;
