import { z } from 'zod';
import { planProposalSchema, planRevisionSchema } from './plans';
export const roomExchangeSchema = z.object({
  id: z.string(), operationId: z.string(), senderUserId: z.string().nullable(), sender: z.string(), kind: z.enum(['human', 'agent']), body: z.string(),
  state: z.enum(['pending', 'complete', 'failed']), createdAt: z.string(),
  response: z.object({ reply: z.string(), proposal: planProposalSchema.nullable(), cancelTaskIds: z.array(z.string()), saved: planRevisionSchema.optional() }).nullable(),
});
export type RoomExchange = z.infer<typeof roomExchangeSchema>;
