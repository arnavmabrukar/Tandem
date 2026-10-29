import { Layers2 } from 'lucide-react';

export function ConfigurationPage({ errors }: { errors: string[] }) {
  return (
    <main className="sign-in">
      <section className="sign-in-card">
        <span className="brand-mark">
          <Layers2 size={28} />
        </span>
        <p className="eyebrow">TANDEM / SETUP</p>
        <h1>Connect your backend</h1>
        <p>The dashboard needs an API origin and Auth0 settings before it can load your data.</p>
        <div role="alert" className="notice error">
          <ul className="bullets">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
        <ol className="bullets">
          <li>
            Copy <code>apps/web/.env.example</code> to <code>apps/web/.env.local</code> and fill in
            your real public settings.
          </li>
          <li>
            Implement the endpoints in <code>apps/web/API.md</code> in your mediator backend.
          </li>
          <li>Restart Vite, then sign in.</li>
        </ol>
        <p className="muted">
          The frontend contains no sample projects or local data source. Setup instructions are in{' '}
          <code>apps/web/README.md</code>.
        </p>
      </section>
    </main>
  );
}
