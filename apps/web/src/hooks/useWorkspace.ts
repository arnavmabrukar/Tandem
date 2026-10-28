import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardApi } from '../api/client';
import { DemoError, STORAGE_KEY } from '../api/demo';
import { useSession } from '../auth/session';
import type { Command, MutationRequest, Project } from '../types/domain';

export function useWorkspace() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null)
        void queryClient.invalidateQueries({ queryKey: ['workspace'] });
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [queryClient]);
  return useQuery({
    queryKey: ['workspace', user?.id],
    queryFn: () => dashboardApi.load(user!.id),
    enabled: !!user,
    refetchInterval: 15_000,
    retry: false,
  });
}
export function useAction(project: Project | null) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const pending = useRef<{ key: string; request: MutationRequest } | null>(null);
  return useMutation({
    mutationFn: (command: Command) => {
      const key = JSON.stringify({ command, projectId: project?.id, actorId: user?.id });
      if (!pending.current || pending.current.key !== key)
        pending.current = {
          key,
          request: {
            command,
            projectId: project?.id ?? null,
            actorId: user!.id,
            expectedVersion: project?.version ?? null,
            operationId: crypto.randomUUID(),
          },
        };
      return dashboardApi.execute(pending.current.request);
    },
    onSuccess: async () => {
      pending.current = null;
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: async (error) => {
      if (error instanceof DemoError && ['conflict', 'invalid', 'forbidden'].includes(error.code)) {
        pending.current = null;
        await queryClient.invalidateQueries({ queryKey: ['workspace'] });
      }
    },
    retry: false,
  });
}
