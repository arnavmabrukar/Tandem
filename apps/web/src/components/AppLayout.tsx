import {
  Activity,
  Bot,
  CheckCheck,
  ClipboardList,
  FolderCog,
  Layers2,
  LogOut,
  RefreshCw,
  CircleHelp,
} from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSession } from '../auth/session';
import { demoApi } from '../api/client';
import { roleFor, type Project } from '../types/domain';
import { DemoControls } from './DemoControls';
import { Button } from './ui/button';
import { Badge, Timestamp } from './common';

export function AppLayout({
  projects,
  project,
  children,
  refresh,
  refreshing,
  updatedAt,
}: {
  projects: Project[];
  project: Project | null;
  children: ReactNode;
  refresh: () => void;
  refreshing: boolean;
  updatedAt: number;
}) {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = project?.id ?? projects[0]?.id;
  const pending = project?.approvals.filter((a) => a.status === 'pending').length ?? 0;
  const nav = [
    { to: 'activity', text: 'Activity', icon: Activity },
    { to: 'tasks', text: 'Tasks', icon: ClipboardList },
    { to: 'agents', text: 'Agents', icon: Bot },
    { to: 'approvals', text: 'Approvals', icon: CheckCheck },
    { to: 'setup', text: 'Project setup', icon: FolderCog },
    { to: 'connections', text: 'Connection guide', icon: CircleHelp },
  ];
  return (
    <div className="app-shell">
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Layers2 size={23} />
          </span>
          <span>
            Tandem<small>Human dashboard</small>
          </span>
        </div>
        <label className="field project-switcher">
          <span>Project</span>
          <select
            aria-label="Select project"
            value={project?.id ?? ''}
            onChange={(e) => navigate(`/projects/${e.target.value}/activity`)}
          >
            <option value="" disabled>
              Choose project
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="ghost" className="new-project" onClick={() => navigate('/projects/new')}>
          + Create project
        </Button>
        <nav aria-label="Main navigation">
          {id &&
            nav.map(({ to, text, icon: Icon }) => (
              <NavLink key={to} aria-label={text} to={`/projects/${id}/${to}`}>
                <Icon size={18} />
                <span>{text}</span>
                {to === 'approvals' && pending > 0 && (
                  <span className="nav-count" aria-hidden="true">
                    {pending}
                  </span>
                )}
              </NavLink>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <p>
            Independent agents.
            <br />
            Coordinated work.
          </p>
          <div className="user-row">
            <span className="avatar">{user!.name[0]}</span>
            <div>
              <strong>{user!.name}</strong>
              <small>{project ? roleFor(project, user!.id) : 'Demo persona'}</small>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Sign out"
              onClick={() => {
                queryClient.clear();
                demoApi.clearSimulation();
                signOut();
                navigate('/signin');
              }}
            >
              <LogOut size={17} />
            </Button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <div className="row">
            <Badge value="demo" />
            <span>Browser-local data · no services connected</span>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
        <main id="main" tabIndex={-1}>
          {children}
          <footer className="workspace-footer">
            <span>
              Demo snapshot{' '}
              {updatedAt ? <Timestamp value={new Date(updatedAt).toISOString()} /> : 'not loaded'}.
              Refreshes every 15 seconds.
            </span>
            <span>Git holds code. The future mediator holds coordination.</span>
          </footer>
          <DemoControls projectId={project?.id} />
        </main>
      </div>
    </div>
  );
}
