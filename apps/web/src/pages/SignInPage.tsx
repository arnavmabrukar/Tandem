import { useState } from 'react';
import { Layers2, ArrowRight } from 'lucide-react';
import { demoUsers } from '../api/fixtures';
import { useSession } from '../auth/session';
import { Button } from '../components/ui/button';
import { Field } from '../components/common';

export function SignInPage() {
  const { signIn } = useSession();
  const [id, setId] = useState(demoUsers[0].id);
  return (
    <main className="sign-in">
      <section className="sign-in-card">
        <span className="brand-mark">
          <Layers2 size={28} />
        </span>
        <p className="eyebrow">TANDEM / FRONTEND DEMO</p>
        <h1>
          One place to see
          <br />
          the work together.
        </h1>
        <p className="muted">
          A simple dashboard for humans coordinating independent coding agents across separate
          machines.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            signIn(id);
          }}
        >
          <Field label="Demo persona">
            <select value={id} onChange={(e) => setId(e.target.value)}>
              {demoUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} — {user.description}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">
            Enter demo <ArrowRight size={17} />
          </Button>
        </form>
        <div className="notice">
          <div>
            <strong>No account or credentials needed.</strong>
            <p>
              This is a local testing session. Real sign-in needs Auth0 and a backend membership
              check; neither is connected.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
