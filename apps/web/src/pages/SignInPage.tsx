import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useSession } from '../auth/session';
import { safeReturnTo } from '../config';
import { Button } from '../components/ui/button';
import { BrandMark } from '../components/BrandMark';
import { ErrorNotice } from '../components/common';

export function SignInPage() {
  const { signIn, signOut, authenticated, canSignOut, error, refresh } = useSession();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const returnTo = safeReturnTo(location.state?.returnTo ?? location.pathname + location.search);
  return (
    <main className="sign-in">
      <section className="sign-in-card sign-in-card-simple">
        <BrandMark />
        <h1>{authenticated ? 'Connect to your workspace.' : 'Sign in to Tandem.'}</h1>
        <p className="muted">Independent agents. Coordinated work.</p>
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
      </section>
    </main>
  );
}
