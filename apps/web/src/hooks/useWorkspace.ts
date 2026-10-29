import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import type { Command, MutationRequest, Project } from '../types/domain';

export function useWorkspace() {
  const { user, api } = useSession();
  return useQuery({
    queryKey: ['workspace', user?.id],
    queryFn: ({ signal }) => api.load(signal),
    enabled: !!user,
    refetchInterval: 15_000,
    retry: false,
  });
}
export function useAction(project: Project | null) {
  const { user, api } = useSession();
  const queryClient = useQueryClient();
  const pending = useRef<{ key: string; request: MutationRequest; uncertain: boolean } | null>(
    null,
  );
  return useMutation({
    mutationFn: async (command: Command) => {
      const key = JSON.stringify({ command, projectId: project?.id, userId: user?.id });
      if (pending.current?.uncertain && pending.current.key !== key) {
        // Confirm the earlier save with its original key before accepting different intent.
        await api.execute(pending.current.request);
        pending.current = null;
        await queryClient.invalidateQueries({ queryKey: ['workspace'] });
        throw new ApiError(
          'reconciled',
          'The previous save was confirmed. Review the refreshed data, then submit your new changes.',
        );
      }
      if (!pending.current || pending.current.key !== key)
        pending.current = {
          key,
          request: {
            command,
            projectId: project?.id ?? null,
            expectedVersion: project?.version ?? null,
            operationId: crypto.randomUUID(),
          },
          uncertain: false,
        };
      return api.execute(pending.current.request);
    },
    onSuccess: async () => {
      pending.current = null;
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: async (error) => {
      if (pending.current && error instanceof ApiError && error.outcomeUnknown)
        pending.current.uncertain = true;
      if (
        error instanceof ApiError &&
        ['conflict', 'invalid', 'forbidden', 'unauthorized'].includes(error.code)
      ) {
        pending.current = null;
        await queryClient.invalidateQueries({ queryKey: ['workspace'] });
      }
    },
    retry: false,
  });
}
