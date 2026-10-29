import { AlertCircle, Inbox } from 'lucide-react';
import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';
import { label } from '../types/domain';
import { Button } from './ui/button';
import { ApiError } from '../api/client';

export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{label(value)}</span>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={26} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="notice error">
      <AlertCircle size={18} />
      <div>
        <strong>Couldn’t complete that action</strong>
        <p>
          {error instanceof Error ? error.message : 'An unexpected error occurred. Please refresh.'}
        </p>
        {error instanceof ApiError && error.outcomeUnknown && (
          <p>
            The save may have reached the server. Retry to confirm it with the same operation ID
            before starting a different change.
          </p>
        )}
        {retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </header>
  );
}
export function Field({
  label: title,
  children,
  hint,
}: {
  label: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
  hint?: string;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  return (
    <div className="field">
      <label htmlFor={id}>{title}</label>
      {cloneElement(children, {
        id,
        'aria-describedby': hint ? `${id}-hint` : children.props['aria-describedby'],
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Timestamp({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}
    </time>
  ) : (
    <span>Not recorded</span>
  );
}
