import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session';
import type { Agent, Project } from '../types/domain';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { ErrorNotice, Field } from './common';

export function AgentTokenButton({ project, agent, buttonLabel }: { project: Project; agent: Agent; buttonLabel?: string }) {
  const { api, user } = useSession();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);
  // Prevent double clicks before React finishes updating the disabled button.
  const busy = useRef(false);

  // Display names cannot establish ownership. The API also enforces this rule.
  if (agent.ownerId !== user?.id) return null;

  function close() {
    if (busy.current) return;
    // The secret exists only in this component's memory, never browser storage
    // or React Query's mutation cache. Closing discards our displayed copy.
    setToken('');
    setCopied(false);
    setError(null);
    setOpen(false);
  }

  async function generate() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      // Each explicit attempt is a new issuance. Never automatically retry:
      // the backend cannot replay a raw token if a response was lost.
      const result = await api.issueAgentToken(
        project.id, agent.id, crypto.randomUUID(), project.version,
      );
      setToken(result.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Token issuance failed.'));
    } finally {
      // Refresh even after failure: a lost response may still have committed.
      // Refresh failure must not discard a successfully received credential.
      try { await queries.invalidateQueries({ queryKey: ['workspace'] }); }
      catch { /* Workspace reports its own refresh error; retain the token. */ }
      finally { busy.current = false; setPending(false); }
    }
  }

  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      {buttonLabel ?? (agent.grant === 'active' ? 'Replace token' : 'Generate token')}
    </Button>
    <Modal open={open} onOpenChange={(value) => { if (!value) close(); }}
      title={`Connection token for ${agent.name}`}
      description={token ? 'Copy this token now. You cannot retrieve it after closing this dialog.'
        : 'Generating a token replaces any existing token for this agent. Its existing clients will need the new token.'}>
      {token ? <>
        <Field label="Agent token">
          <textarea readOnly value={token} spellCheck={false} autoComplete="off"
            onFocus={(event) => event.currentTarget.select()} />
        </Field>
        <Button onClick={async () => {
          try { await navigator.clipboard.writeText(token); setCopied(true); setError(null); }
          catch { setError(new Error('Clipboard unavailable. Select and copy the token manually.')); }
        }}>{copied ? 'Copied' : 'Copy token'}</Button>
      </> : <>
        <p>If an attempt times out, refresh the workspace before explicitly generating a replacement.</p>
        <Button disabled={pending} onClick={() => { void generate(); }}>
          {pending ? 'Generating…' : agent.grant === 'active' ? 'Replace token' : 'Generate token'}
        </Button>
      </>}
      <ErrorNotice error={error} />
      <Button variant="outline" disabled={pending} onClick={close}>Close</Button>
    </Modal>
  </>;
}
