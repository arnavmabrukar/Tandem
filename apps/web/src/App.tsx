import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { useSession } from './auth/session';
import { useWorkspace } from './hooks/useWorkspace';
import { AppLayout } from './components/AppLayout';
import { Empty, ErrorNotice } from './components/common';
import { Button } from './components/ui/button';
import { SignInPage } from './pages/SignInPage';
const ActivityPage = lazy(() =>
  import('./pages/ActivityPage').then((m) => ({ default: m.ActivityPage })),
);
const TasksPage = lazy(() => import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })));
const ThreadPage = lazy(() =>
  import('./pages/ThreadPage').then((m) => ({ default: m.ThreadPage })),
);
const ApprovalsPage = lazy(() =>
  import('./pages/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })),
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
        <p>Reload to recover. Your saved demo data stays in this browser.</p>
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
  const projects = query.data?.projects ?? [];
  const project = projects.find((p) => p.id === match?.params.projectId) ?? null;
  useEffect(() => {
    document.title = project ? `${project.name} · Tandem` : 'Tandem — Coordination dashboard';
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
    >
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isError && query.data && (
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
      ) : query.data ? (
        <Suspense
          fallback={
            <div role="status" className="loading">
              Loading view…
            </div>
          }
        >
          <Routes>
            <Route
              path="/"
              element={
                <Navigate
                  to={projects[0] ? `/projects/${projects[0].id}/activity` : '/projects/new'}
                  replace
                />
              }
            />
            <Route path="/projects/new" element={<ProjectSetupPage key="new" project={null} />} />
            <Route
              path="/projects/:projectId"
              element={
                project ? <Navigate to={`/projects/${project.id}/activity`} replace /> : notFound
              }
            />
            <Route
              path="/projects/:projectId/activity"
              element={project ? <ActivityPage key={project.id} project={project} /> : notFound}
            />
            <Route
              path="/projects/:projectId/tasks"
              element={project ? <TasksPage key={project.id} project={project} /> : notFound}
            />
            <Route
              path="/projects/:projectId/tasks/:taskId"
              element={project ? <ThreadPage key={project.id} project={project} /> : notFound}
            />
            <Route
              path="/projects/:projectId/agents"
              element={project ? <ConnectAgentPage key={project.id} project={project} /> : notFound}
            />
            <Route
              path="/projects/:projectId/approvals"
              element={project ? <ApprovalsPage key={project.id} project={project} /> : notFound}
            />
            <Route
              path="/projects/:projectId/setup"
              element={project ? <ProjectSetupPage key={project.id} project={project} /> : notFound}
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
          </Routes>
        </Suspense>
      ) : null}
    </AppLayout>
  );
}
export default function App() {
  const { user } = useSession();
  const location = useLocation();
  const returnTo =
    typeof location.state?.returnTo === 'string' && location.state.returnTo.startsWith('/projects/')
      ? location.state.returnTo
      : '/';
  return (
    <ErrorBoundary>
      <Routes>
        <Route
          path="/signin"
          element={user ? <Navigate to={returnTo} replace /> : <SignInPage />}
        />
        <Route path="*" element={<Dashboard />} />
      </Routes>
    </ErrorBoundary>
  );
}
