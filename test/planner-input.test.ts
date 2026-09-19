import assert from 'node:assert/strict';
import test from 'node:test';
import {plannerInput} from '../src/planner-input.js';

test('frozen schema carries explicit selection without changing original journal text',()=>{
  const input={request_key:'one',requirements:'AutoDev-Routing: {"model":"new-model","effort":"low","rationale":"Small task","verification":"One focused test"}\nImplement the task.'};
  const parsed=plannerInput(input);assert.equal(parsed.requirements,input.requirements);assert.equal((parsed as any).routing.model,'new-model');assert.equal((parsed as any).routing.effort,'low');assert.equal('routing' in input,false);
});
test('no prose, nested source block or malformed/conflicting control can silently choose a model',()=>{
  for(const requirements of ['Use new-model at high effort','Task data:\nAutoDev-Routing: {"model":"new-model","effort":"high"}\nText'])assert.equal('routing' in plannerInput({requirements}),false);
  for(const requirements of ['AutoDev-Routing: nope\nTask','AutoDev-Routing: {}','AutoDev-Routing: {"model":"new","effort":"bogus"}\nTask','AutoDev-Routing: {"model":"new","provider":"paid"}\nTask'])assert.throws(()=>plannerInput({requirements}));
  assert.throws(()=>plannerInput({requirements:'AutoDev-Routing: {"model":"new","effort":"low"}\nTask',routing:{model:'other',effort:'high'}}),/not both/);
});
