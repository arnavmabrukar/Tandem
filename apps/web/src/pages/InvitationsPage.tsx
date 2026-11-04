import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import { Empty, ErrorNotice, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';

export function InvitationsPage() {
  const { user, api } = useSession();
  const queryClient = useQueryClient();

  // Remember the operation ID when an acceptance needs to be retried.
  // This survives re-renders, but not a full page reload.
  const pending = useRef<{
    invitationId: string;
    operationId: string;
  } | null>(null);

  // Show a link to the project after confirmed acceptance.
  const [acceptedProjectId, setAcceptedProjectId] = useState<string | null>(null);

  const invitations = useQuery({
    // Scope cached invitation data to the signed-in user.
    queryKey: ['invitations', user?.id],
    queryFn: ({ signal }) => api.getPendingInvitations(signal),
    enabled: !!user,
    retry: false,

    // Refresh explicitly so background updates don't disrupt an attempt.
    refetchOnWindowFocus: false,
  });

  const acceptance = useMutation({
    mutationFn: async (invitationId: string) => {
      // Resolve an uncertain earlier attempt before accepting another invite.
      if (pending.current && pending.current.invitationId !== invitationId) {
        throw new Error('Retry the previous acceptance before accepting another invitation.');
      }

      if (!pending.current) {
        pending.current = {
          invitationId,
          operationId: crypto.randomUUID(),
        };
      }

      return api.acceptInvitation(
        invitationId,
        pending.current.operationId,
      );
    },

    onSuccess: (result) => {
      // The backend confirmed membership creation.
      pending.current = null;
      setAcceptedProjectId(result.projectId);

      // Refresh both the sidebar's projects and this invitation list.
      // A later read failure must not turn a successful acceptance into failure.
      void queryClient.invalidateQueries({ queryKey: ['workspace', user?.id] });
      void queryClient.invalidateQueries({ queryKey: ['invitations', user?.id] });
    },

    onError: (error) => {
      // Keep the original operation ID if the request may have committed.
      // A definite rejection allows a new attempt after refreshing.
      if (error instanceof ApiError && !error.outcomeUnknown) {
        pending.current = null;
        void queryClient.invalidateQueries({ queryKey: ['invitations', user?.id] });
      }
    },

    // Writes are retried only when the user explicitly requests it.
    retry: false,
  });

  const uncertain =
    acceptance.error instanceof ApiError && acceptance.error.outcomeUnknown;

  // A 403 from this endpoint means the verified-email requirement failed.
  const listError =
    invitations.error instanceof ApiError && invitations.error.status === 403
      ? new Error('Verify your account email, then refresh your invitations.')
      : invitations.error;

  return (
    <>
      <PageHeader
        title="Invitations"
        description="Join projects that invited your verified email address."
        titleAction={
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh invitations"
            title="Refresh invitations"
            disabled={invitations.isFetching || acceptance.isPending || uncertain}
            onClick={() => void invitations.refetch()}
          >
            <RefreshCw size={16} aria-hidden="true" className={invitations.isFetching ? 'spin' : undefined} />
          </button>
        }
      />

      <ErrorNotice error={listError} />

      <ErrorNotice
        error={acceptance.error}
        retry={
          uncertain && acceptance.variables && !acceptance.isPending
            ? () => acceptance.mutate(acceptance.variables!)
            : undefined
        }
      />

      {acceptedProjectId && (
        <p role="status" className="notice">
          Invitation accepted.{' '}
          <Link to={`/projects/${acceptedProjectId}/activity`}>
            Open project
          </Link>
        </p>
      )}

      {invitations.isPending && (
        <p role="status">Loading invitations…</p>
      )}

      {/* Hide cached invitation details when the current read failed. */}
      {!invitations.isError && invitations.data && (
        <>
          {invitations.data.invitations.length === 0 && (
            <Empty title="No pending invitations" />
          )}

          {invitations.data.invitations.map((invitation) => (
            <section className="panel narrow-panel" key={invitation.id}>
              <h2>{invitation.projectName}</h2>
              <p className="muted">GitHub repository: {invitation.repository}</p>
              <p>Invited by {invitation.invitedByName}</p>
              <p>
                Invited as <strong>{invitation.role}</strong> using{' '}
                {invitation.email}.
              </p>
              <p className="muted">
                Expires {new Date(invitation.expiresAt).toLocaleString()}.
              </p>

              <Button
                disabled={acceptance.isPending || uncertain}
                onClick={() => {
                  setAcceptedProjectId(null);
                  acceptance.mutate(invitation.id);
                }}
              >
                {acceptance.isPending &&
                acceptance.variables === invitation.id
                  ? 'Accepting…'
                  : 'Accept invitation'}
              </Button>
            </section>
          ))}
        </>
      )}
    </>
  );
}
