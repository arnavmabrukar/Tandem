import { describe, expect, it } from 'vitest';
import { agentRoster, ago, needsYou, pipelineOf, rankProjects, recentEvents } from '../src/pages/overview';
import { testProject, testTask } from './support/data';
import type { Project } from '../src/types/domain';

const task = (id: string, status: ReturnType<typeof testTask>['status']) => ({ ...testTask(), id, status });
const project = (over: Partial<Project>): Project => ({ ...testProject(), ...over });

describe('pipelineOf', () => {
  it('groups statuses and leaves cancelled work out', () => {
    const counts = pipelineOf([
      task('a', 'open'),
      task('b', 'claimed'),
      task('c', 'in_progress'),
      task('d', 'in_review'),
      task('e', 'approved'),
      task('f', 'blocked'),
      task('g', 'conflict'),
      task('h', 'merged'),
      task('i', 'cancelled'),
    ]);
    expect(counts).toEqual({ open: 1, working: 2, review: 2, attention: 2, merged: 1 });
  });
});

describe('rankProjects', () => {
  it('puts projects that need a person first, then working, then idle', () => {
    const idle = project({ id: 'idle', name: 'idle', tasks: [], approvals: [] });
    const working = project({ id: 'working', name: 'working', tasks: [task('t', 'in_progress')], approvals: [] });
    const needs = project({ id: 'needs', name: 'needs', tasks: [task('t', 'blocked')], approvals: [] });
    expect(rankProjects([idle, working, needs]).map((s) => s.project.id)).toEqual(['needs', 'working', 'idle']);
  });
  it('counts a pending approval as needing a person', () => {
    expect(rankProjects([project({})])[0].state).toBe('attention');
  });
});

describe('needsYou', () => {
  it('lists pending approvals and blocked work, never decided approvals', () => {
    const base = testProject();
    const decided = { ...base.approvals[0], id: 'approval-2', status: 'approved' as const };
    const items = needsYou([project({ approvals: [base.approvals[0], decided], tasks: [task('task-1', 'blocked')] })]);
    expect(items.map((i) => i.kind).sort()).toEqual(['Blocked', 'Review result']);
  });
});

describe('agentRoster and recentEvents', () => {
  it('ignores revoked agents and orders online first', () => {
    const agent = (id: string, presence: 'online' | 'stale' | 'offline', grant: 'active' | 'revoked') => ({
      id, name: id, client: 'Codex' as const, owner: 'o', machine: 'm', capabilities: [],
      grant, presence, lastSeen: null, session: null,
    });
    const roster = agentRoster([project({ agents: [agent('a', 'offline', 'active'), agent('b', 'online', 'active'), agent('c', 'online', 'revoked')] })]);
    expect(roster.rows.map((r) => r.agent.id)).toEqual(['b', 'a']);
    expect(roster.online).toBe(1);
  });
  it('merges events across projects newest first', () => {
    const ev = (id: string, createdAt: string) => ({ id, sequence: 1, taskId: null, kind: 'k', actor: 'a', text: id, createdAt });
    const rows = recentEvents(
      [project({ id: 'p1', activity: [ev('old', '2026-10-01T00:00:00Z')] }), project({ id: 'p2', activity: [ev('new', '2026-10-02T00:00:00Z')] })],
      5,
    );
    expect(rows.map((r) => r.event.id)).toEqual(['new', 'old']);
  });
});

describe('ago', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  it('speaks plainly about missing and recent times', () => {
    expect(ago(null, now)).toBe('No activity yet');
    expect(ago('2026-11-04T11:59:40Z', now)).toBe('Just now');
    expect(ago('2026-11-04T11:53:00Z', now)).toMatch(/7/);
  });
});
