import { roomExchangeSchema, roomSchema } from '../types/room';
import { z } from 'zod';
import { planProposalSchema, planRevisionSchema, savedPlanSchema, approvedPlanSchema } from '../types/plans';
import {
  mutationResultSchema,
  userSchema,
  workspaceSchema,
  pendingInvitationsResponseSchema,
  acceptInvitationResultSchema,
  type DashboardApi,
  type MutationRequest,
} from '../types/domain';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public outcomeUnknown = false,
  ) {
    super(message);
  }
}
export const endpoints = {
  me: '/api/me',
  workspace: '/api/workspace',
  projects: '/api/projects',

  // recipient invitation list and acceptance routes
  invitations: '/api/invitations',
} as const;

function segment(value: string | null | undefined) {
  if (!value || value === '.' || value === '..')
    throw new ApiError('invalid', 'A valid resource ID is required.');
  return encodeURIComponent(value);
}
export function commandEndpoint(request: MutationRequest): {
  method: string;
  path: string;
  payload: object;
} {
  const { command } = request;
  const { type, ...payload } = command;
  if (type === 'create-project') return { method: 'POST', path: endpoints.projects, payload };
  const base = `${endpoints.projects}/${segment(request.projectId)}`;
  switch (command.type) {
    case 'delete-project':
      return { method: 'POST', path: `${base}/delete`, payload: {} };
    case 'auto-delegate':
      return { method: 'POST', path: `${base}/auto-delegate`, payload: { enabled: command.enabled } };
    case 'update-project':
      return { method: 'PATCH', path: base, payload };
    case 'invite':
      return { method: 'POST', path: `${base}/invitations`, payload };
    case 'revoke-invite':
      return {
        method: 'POST',
        path: `${base}/invitations/${segment(command.invitationId)}/revoke`,
        payload: {},
      };
    case 'add-agent':
      return { method: 'POST', path: `${base}/agents`, payload };
    case 'revoke-agent':
      return {
        method: 'POST',
        path: `${base}/agents/${segment(command.agentId)}/revoke`,
        payload: {},
      };
    case 'create-task':
      return { method: 'POST', path: `${base}/tasks`, payload };
    case 'assign-task':
      return { method: 'POST', path: `${base}/tasks/${segment(command.taskId)}/assignment`,
        payload: { agentId: command.agentId, ...(command.autoSelect ? { autoSelect: true } : {}) } };
    case 'cancel-task':
      return {
        method: 'POST',
        path: `${base}/tasks/${segment(command.taskId)}/cancel`,
        payload: {},
      };
    case 'review-task':
      return { method: 'POST', path: `${base}/tasks/${segment(command.taskId)}/review`,
        payload: { decision: command.decision, note: command.note,
          ...(command.expectedTaskVersion !== undefined ? { expectedTaskVersion: command.expectedTaskVersion } : {}) } };
    case 'release-task':
      return { method: 'POST', path: `${base}/tasks/${segment(command.taskId)}/release`,
        payload: { note: command.note } };
    case 'send-message':
      return {
        method: 'POST',
        path: `${base}/tasks/${segment(command.taskId)}/messages`,
        payload: { body: command.body, replyTo: command.replyTo },
      };
    case 'decide':
      return {
        method: 'POST',
        path: `${base}/approvals/${segment(command.approvalId)}/decisions`,
        payload: { decision: command.decision, note: command.note, target: command.target },
      };
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported command: ${String(exhaustive)}`);
    }
  }
}
const statusMessages: Record<number, string> = {
  400: 'The request was not accepted. Check the entered values.',
  401: 'Your session is no longer authorized. Sign in again.',
  403: 'You do not have permission for this project or action.',
  404: 'The requested resource or API endpoint was not found. Check the backend implementation.',
  409: 'The target changed or this operation conflicts with current state. Refresh and review before submitting again.',
  422: 'The backend rejected the submitted values. Check the form and API contract.',
  429: 'The service is busy. Wait before retrying.',
};
interface ClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | undefined>;
  onUnauthorized?: () => void;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}
/** The application's only data client. Every read and write goes to the configured human API. */
export function createApiClient({
  baseUrl,
  getAccessToken,
  onUnauthorized,
  fetcher = fetch,
  timeoutMs = 15_000,
}: ClientOptions): DashboardApi {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: string; body?: object; operationId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const mutation = !!options.method && options.method !== 'GET';
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? timeoutMs);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new DOMException('Request aborted', 'AbortError'));
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    });
    let dispatched = false;
    try {
      const work = async () => {
        let token: string | undefined;
        try {
          token = await getAccessToken();
        } catch {
          signal.throwIfAborted();
          onUnauthorized?.();
          throw new ApiError(
            'unauthorized',
            'Could not obtain an access token. Sign in again.',
            401,
          );
        }
        signal.throwIfAborted();
        if (!token) {
          onUnauthorized?.();
          throw new ApiError('unauthorized', 'No access token is available. Sign in again.', 401);
        }
        const headers: Record<string, string> = {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        };
        if (options.body) headers['Content-Type'] = 'application/json';
        if (options.operationId) headers['Idempotency-Key'] = options.operationId;
        dispatched = true;
        const response = await fetcher(`${baseUrl}${path}`, {
          method: options.method ?? 'GET',
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        });
        signal.throwIfAborted();
        if (!response.ok) {
          if (response.status === 401) onUnauthorized?.();
          const code =
            response.status === 409
              ? 'conflict'
              : response.status === 401
                ? 'unauthorized'
                : response.status === 403
                  ? 'forbidden'
                  : [400, 422].includes(response.status)
                    ? 'invalid'
                    : 'http_error';
          // Conflict details are written by the backend to be shown to people.
          const detail = response.status === 409
            ? await response.clone().json().then((value: { detail?: unknown }) => value?.detail, () => undefined)
            : undefined;
          throw new ApiError(
            code,
            (typeof detail === 'string' && detail) || (statusMessages[response.status] ??
              `The API could not complete the request (HTTP ${response.status}).`),
            response.status,
            mutation && response.status >= 500,
          );
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new ApiError(
            'invalid_response',
            'The API returned an invalid JSON response. Check the documented response contract.',
            response.status,
            mutation,
          );
        }
        const parsed = schema.safeParse(body);
        if (!parsed.success)
          throw new ApiError(
            'invalid_response',
            'The API response does not match the dashboard contract. Check apps/web/API.md.',
            response.status,
            mutation,
          );
        return parsed.data;
      };
      return await Promise.race([work(), aborted]);
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted)
        throw new ApiError(
          'timeout',
          'The API request timed out. Check the backend connection.',
          0,
          mutation && dispatched,
        );
      throw new ApiError(
        'network',
        'Could not reach the API. Check that the backend is running and allows this frontend origin.',
        0,
        mutation && dispatched,
      );
    } finally {
      clearTimeout(timer);
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }
  return {
    connectGitHub: () => request('/api/github/connect', z.object({url: z.string().url()}), {method: 'POST', body: {}}),
    completeGitHub: (code, state) => request('/api/github/complete', z.object({login: z.string()}), {method: 'POST', body: {code, state}}),
    disconnectGitHub: () => request('/api/github/connection', z.object({connected: z.boolean()}), {method: 'DELETE'}),
    githubConnection: () => request('/api/github/connection', z.object({connected: z.boolean(), login: z.string().nullable(), installUrl: z.string().url().nullable()})),
    githubInstallations: (page) => request(`/api/github/installations?page=${page}`, z.object({items: z.array(z.object({id: z.number(), name: z.string()})), hasMore: z.boolean(), installUrl: z.string().url()})),
    githubRepositories: (id, page) => request(`/api/github/installations/${id}/repositories?page=${page}`, z.object({items: z.array(z.object({id: z.number(), name: z.string(), fullName: z.string(), defaultBranch: z.string(), description: z.string()})), hasMore: z.boolean()})),
    saveRoomDraft: (projectId, exchangeId) => request(`${endpoints.projects}/${segment(projectId)}/room/${segment(exchangeId)}/draft`, planRevisionSchema, { method: 'POST' }),
    readRoom: (projectId, signal) => request(`/api/projects/${segment(projectId)}/room`,
      roomSchema, {signal}),
    clearRoom: (projectId, throughId) => request(`/api/projects/${segment(projectId)}/room`,
      z.object({ cleared: z.boolean() }), { method: 'DELETE', body: { throughId } }),
    postRoom: (projectId, body) => request(`/api/projects/${segment(projectId)}/room`,
      roomExchangeSchema, {method: 'POST', body, operationId: body.operationId, timeoutMs: 135000}),
    chatPlan: (projectId, messages) => request(
      `${endpoints.projects}/${segment(projectId)}/plans/chat`,
      z.object({ reply: z.string(), proposal: planProposalSchema.nullable() }),
      { method: 'POST', body: { messages }, timeoutMs: 135_000 }),
    generatePlan: (projectId, goal) => request(
      `${endpoints.projects}/${segment(projectId)}/plans/generate`, planProposalSchema,
      { method: 'POST', body: { goal }, timeoutMs: 135_000 }),
    approvePlan: (projectId, planId, body) => request(
      `${endpoints.projects}/${segment(projectId)}/plans/${segment(planId)}/approve`,
      approvedPlanSchema, { method: 'POST', operationId: body.operationId, body }),
    listPlans: (projectId, signal) => request(`${endpoints.projects}/${segment(projectId)}/plans`,
      z.array(planRevisionSchema), { signal }),
    savePlan: (projectId, planId, body) => request(
      `${endpoints.projects}/${segment(projectId)}/plans${planId ? `/${segment(planId)}/revisions` : ''}`,
      savedPlanSchema, { method: 'POST', operationId: body.operationId, body }),
    // Keep credential responses out of the generic mutation/query cache.
    issueAgentToken: (projectId, agentId, operationId, expectedVersion) =>
      request(`${endpoints.projects}/${segment(projectId)}/agents/${segment(agentId)}/token`,
        z.object({ projectId: z.string().uuid(), projectVersion: z.number().int().positive(),
          entityId: z.string().min(1), token: z.string().min(1) }),
        { method: 'POST', operationId, body: { operationId, expectedVersion } }),
    getCurrentUser: (signal) => request(endpoints.me, userSchema, { signal }),
    updateProfile: (name) =>
      request(endpoints.me, z.object({ id: z.string().min(1), name: z.string().min(1) }), {
        method: 'PATCH',
        body: { name },
      }),
    load: (signal) => request(endpoints.workspace, workspaceSchema, { signal }),
        // The server determines the recipient from the bearer token.
    // No email address is supplied by the browser.
    getPendingInvitations: (signal) =>
      request(endpoints.invitations, pendingInvitationsResponseSchema, {
        signal,
      }),

    acceptInvitation: (invitationId, operationId) =>
      request(
        `${endpoints.invitations}/${segment(invitationId)}/accept`,
        acceptInvitationResultSchema,
        {
          method: 'POST',

          // The shared request helper adds the Idempotency-Key header.
          operationId,

          // Acceptance requires only the operation ID in the body.
          // The backend determines identity, email, and granted role.
          body: { operationId },
        },
      ),
    async execute(input) {
      const { method, path, payload } = commandEndpoint(input);
      const result = await request(path, mutationResultSchema, {
        method,
        operationId: input.operationId,
        body: {
          operationId: input.operationId,
          expectedVersion: input.expectedVersion,
          ...payload,
        },
      });
      if (input.command.type === 'create-task' && !result.entityId)
        throw new ApiError(
          'invalid_response',
          'The API did not return the created task ID. Check the mutation response contract.',
          200,
          true,
        );
      return result;
    },
  };
}

