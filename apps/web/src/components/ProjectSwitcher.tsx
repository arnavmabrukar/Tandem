import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Search } from 'lucide-react';
import type { Project } from '../types/domain';

// A searchable project picker. Ctrl K (or Cmd K) opens it from anywhere in the dashboard.
export function ProjectSwitcher({
  projects,
  project,
  online,
  onSelect,
}: {
  projects: Project[];
  project: Project | null;
  online: number;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? projects.filter((p) => `${p.name} ${p.repository}`.toLowerCase().includes(q))
      : projects;
  }, [projects, query]);

  function close(returnFocus = true) {
    setOpen(false);
    setQuery('');
    if (returnFocus) trigger.current?.focus();
  }
  function choose(id: string) {
    close(false);
    onSelect(id);
  }

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
        setQuery('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    setActive(Math.max(0, projects.findIndex((p) => p.id === project?.id)));
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (matches[active]) choose(matches[active].id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  return (
    <div className="project-switcher" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="switcher-trigger"
        aria-label={project ? `Project: ${project.name}. Switch project` : 'Choose project'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQuery('');
          setOpen((value) => !value);
        }}
      >
        <span className={`dot ${online > 0 ? 'dot-online' : 'dot-off'}`} aria-hidden="true" />
        <span className="switcher-name">{project?.name ?? 'Choose project'}</span>
        <kbd className="switcher-kbd" aria-hidden="true">
          {mac ? '⌘ K' : 'Ctrl K'}
        </kbd>
      </button>
      {open && (
        <div className="switcher-panel">
          <div className="switcher-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-label="Search projects"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={matches[active] ? `${listId}-${matches[active].id}` : undefined}
              placeholder="Search projects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              autoComplete="off"
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Projects" className="switcher-list">
            {matches.map((p, index) => (
              <li
                key={p.id}
                id={`${listId}-${p.id}`}
                role="option"
                aria-selected={p.id === project?.id}
                className={index === active ? 'switcher-option is-active' : 'switcher-option'}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(p.id)}
              >
                <span className="switcher-option-text">
                  <span className="switcher-option-name">{p.name}</span>
                  {p.repository && p.repository !== p.name && (
                    <small>{p.repository}</small>
                  )}
                </span>
                {p.id === project?.id && <Check size={15} aria-hidden="true" />}
              </li>
            ))}
            {matches.length === 0 && <li className="switcher-empty">No projects match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
