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
  Mail,
  Plus,
  Settings,
} from 'lucide-react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from '../auth/session';
import { initials, label, roleFor, type Project } from '../types/domain';
import { Button } from './ui/button';
import { BrandMark } from './BrandMark';
import { ProjectSwitcher } from './ProjectSwitcher';
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
  const creating = location.pathname === '/projects/new';
  const id = creating ? undefined : (project?.id ?? projects[0]?.id);
  const pendingApprovals = project?.approvals.filter((a) => a.status === 'pending') ?? [];
  const pending = pendingApprovals.length;
  // Contract approvals live in the Scope stage and result reviews in Review, as on the Activity page.
  const approvalStage = pendingApprovals.some((a) => a.action === 'Approve contract')
    ? 'scope'
    : 'review';
  const attention =
    project?.tasks.filter((t) => t.status === 'blocked' || t.status === 'conflict').length ?? 0;
  const online =
    project?.agents.filter((a) => a.grant === 'active' && a.presence === 'online').length ?? 0;
  const stale =
    project?.agents.filter((a) => a.grant === 'active' && a.presence === 'stale').length ?? 0;
  const pageName = (() => {
    const path = location.pathname;
    if (path === '/invitations') return 'Invitations';
    if (path === '/settings') return 'Settings';
    if (path === '/projects/new') return 'New project';
    const section = path.split('/')[3];
    const names: Record<string, string> = {
      activity: 'Activity',
      workflow: 'Workflow',
      tasks: 'Workflow',
      plans: 'Workflow',
      approvals: 'Workflow',
      agents: 'Agents',
      setup: 'Project setup',
      connections: 'Connection guide',
    };
    return names[section] ?? '';
  })();
  const accountPage = ['/invitations', '/settings'].includes(location.pathname);
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
      <aside className="sidebar" aria-label="Project sidebar">
        <div className="brand">
          <BrandMark />
          <span>
            Tandem
            {project && (
              <small className="brand-project" title={project.name}>
                {project.name}
              </small>
            )}
          </span>
        </div>
        <ProjectSwitcher
          projects={projects}
          project={project}
          online={online}
          onSelect={(projectId) => navigate(`/projects/${projectId}/activity`)}
        />
        <nav aria-label="Main navigation">
          {id &&
            nav.map(({ to, text, icon: Icon }) => (
              <NavLink key={to} aria-label={to === 'workflow' && pending > 0 ? `${text}, ${pending} pending ${pending === 1 ? 'approval' : 'approvals'}` : text} to={`/projects/${id}/${to}`}
                className={({ isActive }) => isActive || (to === 'workflow' && location.pathname.startsWith(`/projects/${id}/tasks/`)) ? 'active' : undefined}>
                <Icon size={18} />
                <span>{text}</span>
                {to === 'workflow' && pending > 0 && (
                  <span className="nav-count">{pending}</span>
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
          <nav aria-label="Account" className="account-nav">
            {/* Keep this outside the project-specific navigation condition. */}
            <NavLink to="/invitations">
              <Mail size={18} />
              <span>Invitations</span>
            </NavLink>
          </nav>
          <Button variant="outline" className="create-project" onClick={() => navigate('/projects/new')}>
            <Plus size={16} aria-hidden="true" />
            Create project
          </Button>
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
        <header className="topbar">
          <nav className="crumbs" aria-label="Breadcrumb">
            {accountPage ? (
              <span>Account</span>
            ) : !project ? (
              <span>Projects</span>
            ) : (
              <span className="crumb-project" title={project.name}>
                {project.name}
              </span>
            )}
            {pageName && (
              <>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
                <strong aria-current="page">{pageName}</strong>
              </>
            )}
          </nav>
          <div className="topbar-right">
            {id && (
              <div className="needs-you" role="group" aria-label="Needs you">
                {pending > 0 && (
                  <Link
                    className="chip chip-attention"
                    to={`/projects/${id}/workflow?stage=${approvalStage}`}
                  >
                    {pending} {pending === 1 ? 'approval' : 'approvals'} pending
                  </Link>
                )}
                {attention > 0 && (
                  <Link
                    className="chip chip-attention"
                    to={`/projects/${id}/workflow?stage=execute&status=attention`}
                  >
                    {attention} {attention === 1 ? 'task needs' : 'tasks need'} attention
                  </Link>
                )}
                <Link className="chip chip-plain" to={`/projects/${id}/agents`}>
                  <span
                    className={`dot ${online > 0 ? 'dot-online' : 'dot-off'}`}
                    aria-hidden="true"
                  />
                  {online} online{stale > 0 ? ` · ${stale} stale` : ''}
                </Link>
              </div>
            )}
            <div className="freshness" title="The workspace refreshes every 15 seconds.">
              <Badge value={connectionState} />
              <span>
                {connectionState === 'unavailable' && updatedAt ? 'Snapshot from ' : 'Updated '}
                {updatedAt ? <Timestamp value={new Date(updatedAt).toISOString()} /> : 'not loaded'}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
