import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Check, ExternalLink, Search } from 'lucide-react';
import { useSession } from '../auth/session';
import type { GitHubRepository } from '../types/domain';
import { ErrorNotice, Field } from './common';

// Accepts "owner/repo" or a pasted GitHub URL.
const normalize = (text: string) =>
  text.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '');

function AccessLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="icon-link" href={href} target="_blank" rel="noreferrer">
      <ExternalLink size={14} aria-hidden="true" />
      {children}
    </a>
  );
}

function RepositoryCombobox({ installationId, installUrl, onSelect }: {
  installationId: number;
  installUrl: string;
  onSelect: (repo: GitHubRepository | null) => void;
}) {
  const { api, user } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<GitHubRepository | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const inputId = useId();

  // Load every page so that search covers all repositories, not only the first 30.
  const repos = useInfiniteQuery({
    queryKey: ['github-repos', user?.id, installationId],
    queryFn: ({ pageParam }) => api.githubRepositories(installationId, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, _all, page) => (last.hasMore ? page + 1 : undefined),
  });
  useEffect(() => {
    if (repos.hasNextPage && !repos.isFetchingNextPage && !repos.isFetchNextPageError) void repos.fetchNextPage();
  }, [repos.hasNextPage, repos.isFetchingNextPage, repos.isFetchNextPageError]);

  const items = useMemo(() => repos.data?.pages.flatMap((page) => page.items) ?? [], [repos.data]);
  const matches = useMemo(() => {
    const q = normalize(query);
    // After choosing, reopening shows the whole list rather than only the chosen repository.
    if (!q || selected?.fullName === query) return items;
    return items.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [items, query, selected]);
  const loading = repos.isPending || (repos.hasNextPage && !repos.isFetchNextPageError);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  function choose(repo: GitHubRepository) {
    setSelected(repo);
    setQuery(repo.fullName);
    setOpen(false);
    onSelect(repo);
  }
  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((i) => (event.key === 'ArrowDown' ? Math.min(i + 1, matches.length - 1) : Math.max(i - 1, 0)));
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (matches[active]) choose(matches[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className="field repo-combobox" ref={root}>
      <label htmlFor={inputId}>Repository</label>
      <div className="switcher-search">
        <Search size={15} aria-hidden="true" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          placeholder="Search repositories or paste a GitHub URL"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (selected) {
              setSelected(null);
              onSelect(null);
            }
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKey}
        />
      </div>
      {open && (
        <div className="switcher-panel">
          <ul id={listId} role="listbox" aria-label="Repositories" className="switcher-list">
            {matches.map((repo, index) => (
              <li
                key={repo.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={repo.id === selected?.id}
                className={index === active ? 'switcher-option is-active' : 'switcher-option'}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(repo)}
              >
                <span className="switcher-option-text">
                  <span className="switcher-option-name">{repo.fullName}</span>
                </span>
                {repo.id === selected?.id && <Check size={15} aria-hidden="true" />}
              </li>
            ))}
          </ul>
          {loading && <p className="repo-combobox-note" role="status">Loading repositories…</p>}
          {!loading && matches.length === 0 && !repos.error && (
            <p className="repo-combobox-note">
              {query.trim() ? 'No repositories match.' : 'Tandem can’t see any repositories on this account.'}{' '}
              <AccessLink href={installUrl}>Adjust GitHub access</AccessLink>
            </p>
          )}
        </div>
      )}
      <ErrorNotice error={repos.error} retry={() => void repos.refetch()} />
    </div>
  );
}

export function GitHubRepositoryPicker({ onSelect }: {
  onSelect: (repo: GitHubRepository | null, installationId: number) => void;
}) {
  const { api, user } = useSession();
  const [chosen, setChosen] = useState(0);
  const accounts = useQuery({
    queryKey: ['github-accounts', user?.id],
    queryFn: async () => {
      const first = await api.githubInstallations(1);
      const items = [...first.items];
      for (let page = 2, more = first.hasMore; more; page += 1) {
        const next = await api.githubInstallations(page);
        items.push(...next.items);
        more = next.hasMore;
      }
      return { items, installUrl: first.installUrl };
    },
  });

  if (accounts.isPending) return <p className="muted" role="status">Loading GitHub accounts…</p>;
  if (!accounts.data) return <ErrorNotice error={accounts.error} retry={() => void accounts.refetch()} />;
  const { items, installUrl } = accounts.data;
  if (items.length === 0) {
    return (
      <p className="repo-empty">
        The Tandem GitHub App isn’t installed on your account yet.{' '}
        <AccessLink href={installUrl}>Install it on GitHub</AccessLink>
      </p>
    );
  }
  const installationId = items.some((a) => a.id === chosen) ? chosen : items[0].id;
  return (
    <>
      {items.length > 1 && (
        <Field label="Account or organization">
          <select
            value={installationId}
            onChange={(e) => {
              setChosen(Number(e.target.value));
              onSelect(null, 0);
            }}
          >
            {items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <RepositoryCombobox
        key={installationId}
        installationId={installationId}
        installUrl={installUrl}
        onSelect={(repo) => onSelect(repo, installationId)}
      />
    </>
  );
}
