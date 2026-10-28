import type { DemoUser, Project, Task, Workspace } from '../types/domain';

export const demoUsers: DemoUser[] = [
  { id: 'arnav', name: 'Arnav', description: 'Owner · project setup and reviews' },
  { id: 'eashan', name: 'Eashan', description: 'Reviewer · tasks, discussion and reviews' },
  { id: 'guest', name: 'Demo viewer', description: 'Viewer · read-only access' },
];
const head = 'a8c49fd256b62e48f20c71da07e635b832c45b19';
export function createFixtures(empty = false): Workspace {
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const task = (
    id: string,
    title: string,
    status: Task['status'],
    agentId: string | null,
    paths: string[],
    progress: string,
  ): Task => ({
    id,
    title,
    status,
    agentId,
    progress,
    description: `${title} within the agreed file scope. Keep coordination decisions explicit and provide test evidence for review.`,
    version: 1,
    threadId: `thread-${id}`,
    receipt: 'received',
    acceptance: 'accepted',
    dependencies: [],
    contract: {
      version: 1,
      summary: 'A small, independently reviewable slice with explicit ownership.',
      paths,
      criteria: [
        'Respect the agreed file scope.',
        'Include repeatable checks and their results.',
        'A human reviews before merge.',
      ],
      history: ['v1 — initial agreement'],
    },
    result: null,
  });
  const tasks = [
    task(
      'task-dashboard',
      'Build project overview',
      'in_progress',
      'codex',
      ['apps/web/src/pages/ActivityPage.tsx'],
      'Building the activity view and task filters.',
    ),
    task(
      'task-auth',
      'Review human session flow',
      'in_review',
      'claude',
      ['services/mediator/src/mediator/api/auth.py'],
      'Result submitted; awaiting human review.',
    ),
    task(
      'task-routing',
      'Validate routing proposals',
      'blocked',
      'codex',
      ['services/mediator/src/mediator/domain/routing.py'],
      'Blocked: agree on the task contract before implementing routing.',
    ),
    task(
      'task-inbox',
      'Add durable inbox polling',
      'open',
      null,
      ['services/mediator/src/mediator/domain/messaging.py'],
      'Awaiting assignment and receipt.',
    ),
    task(
      'task-claims',
      'Reconcile stale file claim',
      'conflict',
      'claude',
      ['services/mediator/src/mediator/domain/claims.py'],
      'Stale ownership needs a human reconciliation decision.',
    ),
    task(
      'task-contract',
      'Document contract boundaries',
      'merged',
      'codex',
      ['docs/contracts.md'],
      'Human merged after reviewing the recorded evidence.',
    ),
  ];
  tasks[1].result = {
    head,
    branch: 'demo/session-flow',
    prNumber: 12,
    evidence: [
      'DEMO evidence: session rendering checks passed.',
      'DEMO evidence: no agent approval controls exposed.',
    ],
    mergeCommit: null,
  };
  tasks[2].dependencies = ['task-auth'];
  tasks[3].receipt = 'pending';
  tasks[3].acceptance = 'pending';
  tasks[5].result = {
    head: 'f'.repeat(40),
    branch: 'demo/contracts',
    prNumber: 9,
    evidence: ['DEMO evidence: contract fields reviewed by both humans.'],
    mergeCommit: 'd'.repeat(40),
  };
  const base: Project = {
    id: 'tandem',
    name: 'Tandem',
    repository: 'arnavmabrukar/Tandem',
    description: 'Independent agents. Coordinated work.',
    version: 1,
    members: [
      { id: 'arnav', name: 'Arnav', role: 'owner' },
      { id: 'eashan', name: 'Eashan', role: 'reviewer' },
      { id: 'guest', name: 'Demo viewer', role: 'viewer' },
    ],
    invitations: [],
    agents: [
      {
        id: 'codex',
        name: 'Arnav’s Codex',
        client: 'Codex',
        owner: 'Arnav',
        machine: 'Arnav’s workstation',
        capabilities: ['Frontend', 'Tests'],
        grant: 'active',
        presence: 'online',
        lastSeen: ago(1),
        session: 'demo-codex-1',
      },
      {
        id: 'claude',
        name: 'Eashan’s Claude Code',
        client: 'Claude Code',
        owner: 'Eashan',
        machine: 'Eashan’s workstation',
        capabilities: ['Backend', 'Protocol'],
        grant: 'active',
        presence: 'stale',
        lastSeen: ago(25),
        session: 'demo-claude-1',
      },
    ],
    tasks,
    claims: tasks
      .filter((t) => t.agentId)
      .map((t, i) => ({
        id: `claim-${i}`,
        taskId: t.id,
        agentId: t.agentId!,
        path: t.contract.paths[0],
        state:
          t.status === 'merged'
            ? 'released'
            : t.status === 'in_review'
              ? 'review_reserved'
              : t.status === 'conflict'
                ? 'stale'
                : 'active',
        generation: 1,
        expiresAt:
          t.status === 'in_review' || t.status === 'merged'
            ? null
            : ago(t.status === 'conflict' ? 5 : -20),
      })),
    approvals: [
      {
        id: 'approval-auth',
        taskId: 'task-auth',
        action: 'Review result',
        status: 'pending',
        taskVersion: 1,
        contractVersion: 1,
        head,
        requestedAt: ago(8),
        decidedAt: null,
        decidedBy: null,
        note: '',
      },
      {
        id: 'approval-contract',
        taskId: 'task-contract',
        action: 'Approve contract',
        status: 'approved',
        taskVersion: 1,
        contractVersion: 1,
        head: 'f'.repeat(40),
        requestedAt: ago(85),
        decidedAt: ago(70),
        decidedBy: 'Arnav',
        note: 'Demo decision: boundaries agreed.',
      },
    ],
    messages: [
      {
        id: 'message-1',
        taskId: 'task-dashboard',
        sequence: 1,
        sender: 'Arnav’s Codex',
        type: 'question',
        body: 'Should receipt and task acceptance appear separately?',
        createdAt: ago(40),
        replyTo: null,
        receipt: 'received',
      },
      {
        id: 'message-2',
        taskId: 'task-dashboard',
        sequence: 2,
        sender: 'Eashan’s Claude Code',
        type: 'answer',
        body: 'Yes. Acknowledging delivery does not mean the task was accepted. Show both signals.',
        createdAt: ago(35),
        replyTo: 'message-1',
        receipt: 'received',
      },
      {
        id: 'message-3',
        taskId: 'task-auth',
        sequence: 1,
        sender: 'Eashan’s Claude Code',
        type: 'result',
        body: 'Demo result ready for human review. The recorded head is immutable; a new head needs a new review.',
        createdAt: ago(8),
        replyTo: null,
        receipt: 'received',
      },
    ],
    activity: [
      {
        id: 'event-1',
        sequence: 1,
        taskId: 'task-contract',
        kind: 'merge',
        actor: 'Arnav',
        text: 'Demo merge evidence recorded for contract boundaries.',
        createdAt: ago(65),
      },
      {
        id: 'event-2',
        sequence: 2,
        taskId: 'task-dashboard',
        kind: 'claim',
        actor: 'Arnav’s Codex',
        text: 'Reserved the project overview file.',
        createdAt: ago(45),
      },
      {
        id: 'event-3',
        sequence: 3,
        taskId: 'task-claims',
        kind: 'conflict',
        actor: 'Demo worker',
        text: 'Stale claim detected. Ownership is not automatically reassigned.',
        createdAt: ago(12),
      },
      {
        id: 'event-4',
        sequence: 4,
        taskId: 'task-auth',
        kind: 'review',
        actor: 'Eashan’s Claude Code',
        text: 'Submitted a result for exact-target human review.',
        createdAt: ago(8),
      },
    ],
  };
  if (empty) {
    base.tasks = [];
    base.claims = [];
    base.approvals = [];
    base.messages = [];
    base.activity = [];
    base.agents = [];
  }
  const sandbox: Project = {
    ...structuredClone(base),
    id: 'sandbox',
    name: 'Empty sandbox',
    description: 'A clean project for testing empty states.',
    tasks: [],
    claims: [],
    approvals: [],
    messages: [],
    activity: [],
    agents: [],
  };
  return { schemaVersion: 1, projects: [base, sandbox] };
}
