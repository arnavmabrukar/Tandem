import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth/session';
import { ErrorNotice, Field, PageHeader } from '../components/common';
import { Button } from '../components/ui/button';

export function SettingsPage() {
  const { user, api } = useSession();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(user!.name);
  const name = draft.trim();

  const save = useMutation({
    mutationFn: () => api.updateProfile(name),
    onSuccess: async () => {
      setDraft(name);
      // Names also appear on project members and agents, so reload both from the server.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['session'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
      ]);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name && name !== user!.name) save.mutate();
  };

  const signIns = user!.signIns ?? [];

  return (
    <>
      <PageHeader title="Settings" description="Your profile and how you sign in to Tandem." />

      <section className="panel narrow-panel">
        <h2>Profile</h2>
        <form onSubmit={submit}>
          <Field
            label="Display name"
            hint="Shown to people in your projects. Past activity keeps the name used at the time."
          >
            <input
              value={draft}
              maxLength={80}
              autoComplete="name"
              onChange={(event) => {
                setDraft(event.target.value);
                save.reset();
              }}
            />
          </Field>
          <ErrorNotice error={save.error} />
          <div className="row">
            <Button type="submit" disabled={!name || name === user!.name || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save name'}
            </Button>
            {save.isSuccess && (
              <span role="status" className="settings-saved">
                Name saved
              </span>
            )}
          </div>
        </form>
      </section>

      <section className="panel narrow-panel">
        <h2>Sign-in</h2>
        <dl className="details-grid">
          <dt>Email</dt>
          <dd className="row wrap">
            {user!.email ?? 'No email on this sign-in'}
            {user!.email && (
              <span className={`badge ${user!.emailVerified ? 'badge-approved' : 'badge-pending'}`}>
                {user!.emailVerified ? 'Verified' : 'Not verified'}
              </span>
            )}
          </dd>
        </dl>
        {user!.email && !user!.emailVerified && (
          <p className="notice" role="status">
            Verify this email to combine this account with other sign-ins that use it. Open the
            verification email, then log out and sign in again.
          </p>
        )}
        <h3>Ways you sign in</h3>
        <ul className="member-list">
          {signIns.map((signIn, index) => (
            <li key={`${signIn.method}-${index}`}>
              {signIn.method}
              {signIn.current && <span className="tag">This session</span>}
            </li>
          ))}
        </ul>
        <p className="small muted">
          Sign-ins with the same verified email share one Tandem account, with the same projects and
          agents.
        </p>
      </section>

      <section className="panel narrow-panel">
        <h2>Connected agents</h2>
        <p className="muted">
          See which agent clients can reach your projects, and disconnect them.
        </p>
        <Link to="/mcp/connections">Manage agent connections</Link>
      </section>
    </>
  );
}
