import { routingRequestSchema, type RoutingRequest } from './model-routing.js';

export const ROUTING_HEADER='AutoDev-Routing: ';
/** Backward-compatible transport for ChatGPT's frozen pre-routing tool schema.
 * Only an explicit first-line control record is accepted; prose and source
 * content are never searched for model keywords. Keep the original text in
 * the request journal and evidence so replay still binds the submitted body.
 */
export function plannerInput<T extends {requirements:string;routing?:RoutingRequest}>(input:T):T {
  if(!input.requirements.startsWith(ROUTING_HEADER))return input;
  if(input.routing)throw new Error('Use routing OR the first-line AutoDev-Routing header, not both. No dispatch.');
  const newline=input.requirements.indexOf('\n');
  if(newline<0||newline>12000)throw new Error('AutoDev-Routing requires one bounded JSON line followed by the task. No dispatch.');
  let raw:unknown;
  try {raw=JSON.parse(input.requirements.slice(ROUTING_HEADER.length,newline));}
  catch {throw new Error('AutoDev-Routing must contain valid compact JSON. No dispatch.');}
  const parsed=routingRequestSchema.safeParse(raw);
  if(!parsed.success)throw new Error('AutoDev-Routing fields are invalid. No dispatch.');
  return {...input,routing:parsed.data};
}
