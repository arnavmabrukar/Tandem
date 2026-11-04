import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Activity,
  Bot,
  ChevronsUpDown,
  ListChecks,
  FolderCog,
  LogOut,
  RefreshCw,
  CircleHelp,
  Settings,
} from 'lucide-react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from '../auth/session';
import { configuration } from '../config';
import { initials, label, roleFor, type Project } from '../types/domain';
import { Button } from './ui/button';
import { BrandMark } from './BrandMark';
import { Badge, Timestamp } from './common';

export function AppLayout({
  projects,
  project,
  children,
  refresh,
  refreshing,
  updatedAt,
  connectionState,
}: {
  projects: Project[];
  project: Project | null;
  children: ReactNode;
  refresh: () => void;
  refreshing: boolean;
  updatedAt: number;
  connectionState: 'loading' | 'connected' | 'unavailable';
}) {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const id = project?.id ?? projects[0]?.id;
  const pending = project?.approvals.filter((a) => a.status === 'pending').length ?? 0;
  const nav = [
    { to: 'activity', text: 'Activity', icon: Activity },
    { to: 'workflow', text: 'Workflow', icon: ListChecks },
    { to: 'agents', text: 'Agents', icon: Bot },
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
          <BrandMark />
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
          {/* Keep this outside the project-specific navigation condition. */}
          <NavLink to="/invitations">
            <span>Invitations</span>
          </NavLink>
          {id &&
            nav.map(({ to, text, icon: Icon }) => (
              <NavLink key={to} aria-label={text} to={`/projects/${id}/${to}`}
                className={({ isActive }) => isActive || (to === 'workflow' && location.pathname.startsWith(`/projects/${id}/tasks/`)) ? 'active' : undefined}>
                <Icon size={18} />
                <span>{text}</span>
                {to === 'workflow' && pending > 0 && (
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
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="account-trigger" aria-label="Account menu">
                <span className="avatar" aria-hidden="true">
                  {initials(user!.name)}
                </span>
                <span className="account-name">
                  <strong>{user!.name}</strong>
                  <small>
                    {project ? label(roleFor(project, user!.id) ?? 'member') : 'Signed in'}
                  </small>
                </span>
                <ChevronsUpDown size={15} aria-hidden="true" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="account-menu"
                  side="top"
                  align="start"
                  sideOffset={6}
                >
                  <DropdownMenu.Item
                    className="account-menu-item"
                    onSelect={() => navigate('/settings')}
                  >
                    <Settings size={16} aria-hidden="true" />
                    Settings
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="account-menu-separator" />
                  <DropdownMenu.Item
                    className="account-menu-item account-menu-danger"
                    onSelect={() => void signOut()}
                  >
                    <LogOut size={16} aria-hidden="true" />
                    Log out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <div className="row">
            <Badge value={connectionState} />
            <span>{configuration.config?.apiBaseUrl}</span>
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
              Last successful API refresh{' '}
              {updatedAt ? <Timestamp value={new Date(updatedAt).toISOString()} /> : 'not loaded'}.
              Refreshes every 15 seconds.
            </span>
            <span>Git holds code. The mediator holds coordination.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
