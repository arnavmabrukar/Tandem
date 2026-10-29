import { z } from 'zod';
import {
  mutationResultSchema,
  userSchema,
  workspaceSchema,
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
    case 'cancel-task':
      return {
        method: 'POST',
        path: `${base}/tasks/${segment(command.taskId)}/cancel`,
        payload: {},
      };
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
    options: { method?: string; body?: object; operationId?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const mutation = !!options.method && options.method !== 'GET';
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
          throw new ApiError(
            code,
            statusMessages[response.status] ??
              `The API could not complete the request (HTTP ${response.status}).`,
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
    getCurrentUser: (signal) => request(endpoints.me, userSchema, { signal }),
    load: (signal) => request(endpoints.workspace, workspaceSchema, { signal }),
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
