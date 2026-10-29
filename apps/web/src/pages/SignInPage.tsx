import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Layers2, ArrowRight } from 'lucide-react';
import { useSession } from '../auth/session';
import { safeReturnTo } from '../config';
import { Button } from '../components/ui/button';
import { ErrorNotice } from '../components/common';

export function SignInPage() {
  const { signIn, signOut, authenticated, canSignOut, error, refresh } = useSession();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const returnTo = safeReturnTo(location.state?.returnTo ?? location.pathname + location.search);
  return (
    <main className="sign-in">
      <section className="sign-in-card">
        <span className="brand-mark">
          <Layers2 size={28} />
        </span>
        <p className="eyebrow">TANDEM / HUMAN DASHBOARD</p>
        <h1>{authenticated ? 'Connect to your workspace.' : 'Sign in to Tandem.'}</h1>
        <p className="muted">
          Coordinate independent coding agents using the shared mediator. Your projects and
          permissions come from the backend.
        </p>
        <ErrorNotice error={error} retry={authenticated ? refresh : undefined} />
        <div className="sign-in-actions">
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await signIn(returnTo);
              setBusy(false);
            }}
          >
            {busy ? 'Opening sign-in…' : 'Sign in with Auth0'}
            <ArrowRight size={17} />
          </Button>
          {canSignOut && (
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          )}
        </div>
        <p className="small muted">
          The API must implement <code>GET /api/me</code> and <code>GET /api/workspace</code>. See{' '}
          <code>apps/web/API.md</code> for the complete backend contract.
        </p>
      </section>
    </main>
  );
}
