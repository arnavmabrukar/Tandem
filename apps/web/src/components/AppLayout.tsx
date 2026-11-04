import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Activity,
  Bot,
  ChevronsUpDown,
  ListChecks,
  ChevronDown,
  LogOut,
  RefreshCw,
  LayoutDashboard,
  Mail,
  Moon,
  Plus,
  Settings,
  Sun,
} from 'lucide-react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '../auth/session';
import { useTheme } from '../theme';
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
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const inSettings = location.pathname === '/settings';
  const [settingsOpen, setSettingsOpen] = useState(inSettings);
  useEffect(() => { if (inSettings) setSettingsOpen(true); }, [inSettings]);
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
  const overview = location.pathname === '/dashboard';
  const pageName = (() => {
    const path = location.pathname;
    if (overview) return 'Overview';
    if (path === '/invitations') return 'Invitations';
    if (path === '/settings') return 'Settings';
    if (path === '/settings/user') return 'User settings';
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
  const accountPage = ['/invitations', '/settings', '/settings/user'].includes(location.pathname);
  const nav = [
    { to: 'activity', text: 'Activity', icon: Activity },
    { to: 'workflow', text: 'Workflow', icon: ListChecks },
    { to: 'agents', text: 'Agents', icon: Bot },
  ];
  const settingsLink = (section: string) => `/settings?${new URLSearchParams({ ...(id ? { project: id } : {}), section })}`;
  const defaultSettingsSection = id ? 'setup-details' : 'connection-guide';
  const settingsSections = [
    ...(id ? [{ title: project?.name ?? 'Project', items: [['setup-details', 'Project details'], ['setup-people', 'People & invitations'], ['setup-automation', 'Agents & automation'], ...(project && roleFor(project, user!.id) === 'owner' ? [['setup-danger', 'Danger zone']] : [])] }] : []),
    { title: 'Help', items: [['connection-guide', 'Connection guide']] },
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
          <NavLink to="/dashboard" end>
            <LayoutDashboard size={18} />
            <span>Overview</span>
          </NavLink>
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
          <button className={`settings-nav-toggle${inSettings ? ' active' : ''}`} aria-expanded={settingsOpen} aria-controls="settings-navigation"
            onClick={() => {
              setSettingsOpen(inSettings ? !settingsOpen : true);
              if (!inSettings) navigate(settingsLink(defaultSettingsSection));
            }}>
            <Settings size={18} /><span>Settings</span><ChevronDown size={16} className={settingsOpen ? 'expanded' : ''} />
          </button>
          {settingsOpen && <div id="settings-navigation" className="settings-subnav">
            {settingsSections.map(group => <div key={group.title}>
              <p><strong>{group.title}</strong></p>
              {group.items.map(([section, text]) => {
                const active = inSettings && (new URLSearchParams(location.search).get('section') ?? defaultSettingsSection) === section;
                return <Link key={section} to={settingsLink(section)} className={active ? 'active' : undefined} aria-current={active ? 'location' : undefined}>{text}</Link>;
              })}
            </div>)}
          </div>}
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
                  {project && <small>{label(roleFor(project, user!.id) ?? 'member')}</small>}
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
                    onSelect={() => navigate('/settings/user')}
                  >
                    <Settings size={16} aria-hidden="true" />
                    User settings
                  </DropdownMenu.Item>
                  <div className="theme-row">
                    <span id="theme-label">Theme</span>
                    <DropdownMenu.RadioGroup
                      className="theme-seg"
                      aria-labelledby="theme-label"
                      value={theme}
                      onValueChange={(value) => setTheme(value === 'dark' ? 'dark' : 'light')}
                    >
                      {([['light', Sun], ['dark', Moon]] as const).map(([value, Icon]) => (
                        <DropdownMenu.RadioItem
                          key={value}
                          value={value}
                          className="theme-option"
                          aria-label={value === 'light' ? 'Light theme' : 'Dark theme'}
                          title={value === 'light' ? 'Light' : 'Dark'}
                          // Keep the menu open so the change can be seen and undone.
                          onSelect={(event) => event.preventDefault()}
                        >
                          <Icon size={16} aria-hidden="true" />
                        </DropdownMenu.RadioItem>
                      ))}
                    </DropdownMenu.RadioGroup>
                  </div>
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
            ) : overview ? (
              <span>Workspace</span>
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
            {id && !overview && (
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
