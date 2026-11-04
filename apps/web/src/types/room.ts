import { z } from 'zod';
import { planProposalSchema, planRevisionSchema } from './plans';
export const roomExchangeSchema = z.object({
  id: z.string(), operationId: z.string(), senderUserId: z.string().nullable(), sender: z.string(), kind: z.enum(['human', 'agent']), body: z.string(),
  senderAgentId: z.string().nullable().optional(),
  state: z.enum(['pending', 'complete', 'failed']), createdAt: z.string(),
  // Complete + null response is a standalone agent post, not a pending mediator reply.
  response: z.object({ reply: z.string(), model: z.string().optional(), proposal: planProposalSchema.nullable(), cancelTaskIds: z.array(z.string()), saved: planRevisionSchema.optional(),
    workerRequest: z.object({ id: z.string(), taskId: z.string(), agentId: z.string(), message: z.string().optional() }).optional() }).nullable(),
});
export type RoomExchange = z.infer<typeof roomExchangeSchema>;
export const roomSchema = z.object({ exchanges: z.array(roomExchangeSchema), mediatorModel: z.string().optional() });
export type Room = z.infer<typeof roomSchema>;
