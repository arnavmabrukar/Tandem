import { z } from 'zod';

const taskSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000),
  contractSummary: z.string().trim().min(1).max(2000),
  paths: z.array(z.string().max(1000)).max(100),
  criteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(100),
  dependencies: z.array(z.string()).max(49),
});
export const planProposalSchema = z.object({
  goal: z.string().trim().min(1).max(10000),
  summary: z.string().trim().min(1).max(4000),
  tasks: z.array(taskSchema).min(1).max(50),
}).superRefine((plan, ctx) => {
  const keys = new Set(plan.tasks.map(t => t.key));
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (keys.size !== plan.tasks.length) invalid('Task keys must be unique.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(plan.tasks.map(t => [t.key, t]));
  function visit(key: string): boolean {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const dep of byKey.get(key)?.dependencies ?? []) {
      if (!keys.has(dep) || !visit(dep)) return false;
    }
    visiting.delete(key); visited.add(key); return true;
  }
  if (plan.tasks.some(t => !visit(t.key))) invalid('Dependencies must reference other tasks without creating a cycle.');
  for (const task of plan.tasks) {
    if (new Set(task.dependencies).size !== task.dependencies.length) invalid('Duplicate dependencies are not allowed.');
    for (const path of task.paths) {
      if (!path || path !== path.trim() || /[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => ['', '.', '..'].includes(p)))
        invalid('Use repository-relative paths, without empty segments or parent traversal.');
    }
  }
  if (JSON.stringify(plan).includes('\\u0000')) invalid('Text cannot contain NUL characters.');
});
export type PlanProposal = z.infer<typeof planProposalSchema>;
export const savedPlanSchema = z.object({
  projectId: z.string().uuid(), projectVersion: z.number().int().positive(),
  planId: z.string().uuid(), planVersion: z.number().int().positive(),
});
export const planRevisionSchema = savedPlanSchema.extend({
  approvedPlanVersion: z.number().int().positive().nullable().default(null),
  createdBy: z.string().uuid(), createdAt: z.string(), proposal: planProposalSchema,
});
export type PlanRevision = z.infer<typeof planRevisionSchema>;
export type SavePlanRequest = {
  operationId: string; expectedVersion: number; proposal: PlanProposal;
  expectedPlanVersion?: number;
};
export type ApprovePlanRequest = { operationId: string; expectedVersion: number; expectedPlanVersion: number; note: string; startNow?: boolean };
export const approvedPlanSchema = savedPlanSchema.extend({ taskIds: z.record(z.string(), z.string().uuid()) });
