import { McpOAuthPage, McpConnectionsPage } from './pages/McpOAuthPage';
import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { useSession } from './auth/session';
import { useWorkspace } from './hooks/useWorkspace';
import { AppLayout } from './components/AppLayout';
import { Empty, ErrorNotice } from './components/common';
import { Button } from './components/ui/button';
import { SignInPage } from './pages/SignInPage';
import { ApiError } from './api/client';
import { safeReturnTo } from './config';

// Keep project screens lazy so the dashboard only downloads the view the user opens.
const ActivityPage = lazy(() =>
  import('./pages/ActivityPage').then((m) => ({ default: m.ActivityPage })),
);
const WorkflowPage = lazy(() => import('./pages/WorkflowPage').then((m) => ({ default: m.WorkflowPage })));
const WorkflowRedirect = lazy(() => import('./pages/WorkflowPage').then((m) => ({ default: m.WorkflowRedirect })));
const ThreadPage = lazy(() =>
  import('./pages/ThreadPage').then((m) => ({ default: m.ThreadPage })),
);
const ConnectAgentPage = lazy(() =>
  import('./pages/ConnectAgentPage').then((m) => ({ default: m.ConnectAgentPage })),
);
const ProjectSetupPage = lazy(() =>
  import('./pages/ProjectSetupPage').then((m) => ({ default: m.ProjectSetupPage })),
);
const ConnectionsPage = lazy(() =>
  import('./pages/ConnectionsPage').then((m) => ({ default: m.ConnectionsPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
// Load the invitation screen when the user opens it.
const InvitationsPage = lazy(() =>
  import('./pages/InvitationsPage').then((m) => ({
    default: m.InvitationsPage,
  })),
);

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Do not log user-entered content. */
  }
  render() {
    return this.state.failed ? (
      <main className="fatal-error">
        <h1>The dashboard couldn’t render.</h1>
        <p>Reload to recover and fetch the latest data from the backend.</p>
        <Button onClick={() => window.location.reload()}>Reload dashboard</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}
function Dashboard() {
  const { user } = useSession();
  const location = useLocation();
  const match = useMatch('/projects/:projectId/*');
  const query = useWorkspace();
  const accessDenied = query.error instanceof ApiError && [401, 403].includes(query.error.status);
  const projects = accessDenied ? [] : (query.data?.projects ?? []);
  const project = projects.find((p) => p.id === match?.params.projectId) ?? null;
  useEffect(() => {
    document.title = project ? `${project.name} · Tandem` : 'Tandem — Coordination dashboard';
    return () => {
      document.title = 'Tandem — Coordination dashboard';
    };
  }, [project?.name]);
  useEffect(() => {
    document.getElementById('main')?.focus();
    window.scrollTo({ top: 0 });
  }, [location.pathname]);
  if (!user)
    return (
      <Navigate to="/signin" state={{ returnTo: location.pathname + location.search }} replace />
    );
  const notFound = (
    <Empty title="Project not found">
      Choose a project you have access to, or <Link to="/projects/new">create a new one</Link>.
    </Empty>
  );
  return (
    <AppLayout
      projects={projects}
      project={project}
      refresh={() => void query.refetch()}
      refreshing={query.isFetching}
      updatedAt={query.dataUpdatedAt}
      connectionState={query.isError ? 'unavailable' : query.data ? 'connected' : 'loading'}
    >
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isError && query.data && !accessDenied && (
        <p role="status" className="notice">
          Showing the last successful snapshot. It may be stale. Saves still need a confirmed
          response.
        </p>
      )}
      {query.isPending ? (
        <div role="status" className="loading">
          <span className="spinner" />
          Loading project snapshot…
        </div>
      ) : (
        <Suspense
          fallback={
            <div role="status" className="loading">
              Loading view…
            </div>
          }
        >
          <Routes>
            {/* Recipient inbox must stay above path="*" or it is unreachable. */}
            <Route
              path="/invitations"
              element={<InvitationsPage key={user.id} />}
            />
            <Route path="/settings" element={<SettingsPage key={user.id} />} />
            <Route path="/projects/new" element={<ProjectSetupPage key="new" project={null} />} />
            {query.data && !accessDenied ? (
              <>
                <Route
                  path="/"
                  element={
                    <Navigate
                      to={
                        projects[0]
                          ? `/projects/${projects[0].id}/activity`
                          : '/invitations'
                      }
                      replace
                    />
                  }
                />
                <Route
                  path="/projects/:projectId"
                  element={
                    project ? (
                      <Navigate to={`/projects/${project.id}/activity`} replace />
                    ) : (
                      notFound
                    )
                  }
                />
                <Route
                  path="/projects/:projectId/activity"
                  element={
                    project ? <ActivityPage key={project.id} project={project} /> : notFound
                  }
                />
                <Route path="/projects/:projectId/workflow"
                  element={project ? <WorkflowPage key={`${user.id}:${project.id}`} project={project} /> : notFound} />
                <Route path="/projects/:projectId/tasks"
                  element={project ? <WorkflowRedirect project={project} stage="execute" /> : notFound} />
                <Route path="/projects/:projectId/plans"
                  element={project ? <WorkflowRedirect project={project} stage="plan" /> : notFound} />
                <Route
                  path="/projects/:projectId/tasks/:taskId"
                  element={project ? <ThreadPage key={project.id} project={project} /> : notFound}
                />
                <Route
                  path="/projects/:projectId/agents"
                  element={
                    project ? <ConnectAgentPage key={project.id} project={project} /> : notFound
                  }
                />
                <Route
                  path="/projects/:projectId/approvals"
                  element={
                    project ? <WorkflowRedirect project={project} stage="approvals" /> : notFound
                  }
                />
                <Route
                  path="/projects/:projectId/setup"
                  element={
                    project ? <ProjectSetupPage key={project.id} project={project} /> : notFound
                  }
                />
                <Route
                  path="/projects/:projectId/connections"
                  element={project ? <ConnectionsPage /> : notFound}
                />
                <Route
                  path="*"
                  element={
                    <Empty title="Page not found">
                      <Link to="/">Return to your project</Link>.
                    </Empty>
                  }
                />
              </>
            ) : (
              <>
                <Route path="/" element={<Navigate to="/invitations" replace />} />
                <Route
                  path="*"
                  element={
                    <Empty title="Workspace unavailable">
                      Open <Link to="/invitations">invitations</Link> or{' '}
                      <Link to="/projects/new">create a project</Link>, then retry the
                      workspace refresh.
                    </Empty>
                  }
                />
              </>
            )}
          </Routes>
        </Suspense>
      )}
    </AppLayout>
  );
}
export default function App() {
  const { user, loading, authenticated, error } = useSession();
  const location = useLocation();
  const returnTo = safeReturnTo(location.state?.returnTo);
  if (loading)
    return (
      <main className="loading" role="status">
        <span className="spinner" />
        Checking your session…
      </main>
    );
  if (!user && (authenticated || error) && !location.pathname.startsWith("/mcp/")) return <SignInPage />;
  return (
    <ErrorBoundary>
      <Routes>
        <Route
          path="/signin"
          element={user ? <Navigate to={returnTo} replace /> : <SignInPage />}
        />
        <Route path="/mcp/authorize/:ticket" element={<McpOAuthPage key={location.pathname} />} />
        <Route path="/mcp/connections" element={<McpConnectionsPage />} />
        <Route path="*" element={<Dashboard />} />
      </Routes>
    </ErrorBoundary>
  );
}
