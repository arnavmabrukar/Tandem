import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { demoApi } from '../api/client';
import type { DemoMode } from '../api/demo';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { ErrorNotice, Field } from './common';

export function DemoControls({ projectId }: { projectId?: string }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<DemoMode>('normal');
  const [confirm, setConfirm] = useState<'sample' | 'empty' | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  async function reset() {
    setBusy(true);
    setError(undefined);
    try {
      await demoApi.reset(confirm === 'empty');
      demoApi.setMode('normal');
      setMode('normal');
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
      setConfirm(null);
      setNotice('Demo data reset in this browser.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="demo-controls">
      <summary>
        <FlaskConical size={16} /> Demo controls
      </summary>
      <p className="muted">
        Testing tools for this browser only. They do not act on a backend, repository, or agent.
      </p>
      <div className="demo-actions">
        <Field label="Connection simulation">
          <select
            value={mode}
            onChange={(event) => {
              const next = event.target.value as DemoMode;
              demoApi.setMode(next);
              setMode(next);
              void queryClient.invalidateQueries({ queryKey: ['workspace'] });
            }}
          >
            <option value="normal">Normal</option>
            <option value="slow">Slow (1.8 seconds)</option>
            <option value="offline">Offline</option>
          </select>
        </Field>
        <Button
          variant="outline"
          onClick={() => {
            demoApi.failNext();
            setNotice('The next save will fail before changing data.');
          }}
        >
          Fail next save
        </Button>
        <Button
          variant="outline"
          disabled={!projectId || busy}
          onClick={async () => {
            setError(undefined);
            setBusy(true);
            try {
              await demoApi.changeReviewHead(projectId!);
              await queryClient.invalidateQueries({ queryKey: ['workspace'] });
              setNotice('Changed the demo PR head and invalidated its old review target.');
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Change review head
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setError(undefined);
            setConfirm('sample');
          }}
        >
          Reset sample data
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setError(undefined);
            setConfirm('empty');
          }}
        >
          Load empty data
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
      <ErrorNotice error={!confirm && error} />
      <Modal
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
        title="Replace local demo data?"
        description="This removes your demo projects, tasks, messages and decisions from this browser. The GitHub repository is unaffected."
      >
        <ErrorNotice error={error} />
        <div className="row end">
          <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
            Keep my data
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void reset()}>
            {busy ? 'Resetting…' : 'Replace demo data'}
          </Button>
        </div>
      </Modal>
    </details>
  );
}
