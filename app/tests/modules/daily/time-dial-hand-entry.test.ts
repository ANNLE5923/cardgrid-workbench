import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceHandEntry, emptyHandEntry } from '../../../src/daily/schedule/time-dial/interaction.ts';

test('hand edge enters outer and holds until 75 units of upward travel', () => {
  let result = advanceHandEntry({x:200,y:400},{x:200,y:345},540,emptyHandEntry());
  assert.equal(result.hit?.half,'outer'); assert.equal(result.hit?.totalMinute,1260);
  result = advanceHandEntry({x:200,y:345},{x:200,y:332},540,result.state);
  result = advanceHandEntry({x:200,y:332},{x:200,y:294},540,result.state);
  assert.equal(result.state.innerEnabled,false); assert.equal(result.hit?.totalMinute,1260);
  result = advanceHandEntry({x:200,y:294},{x:200,y:270},540,result.state);
  assert.equal(result.state.innerEnabled,true); assert.equal(result.hit?.half,'inner'); assert.equal(result.hit?.totalMinute,540);
});
test('fast edge crossing preserves entry and final inner landing', () => {
  const result=advanceHandEntry({x:200,y:450},{x:200,y:254},540,emptyHandEntry());
  assert.equal(result.state.entered,true); assert.equal(result.state.innerEnabled,true);
  assert.equal(result.hit?.totalMinute,540);
});
test('moving outside the entry boundary does not create a placement', () => {
  const result=advanceHandEntry({x:200,y:450},{x:200,y:390},540,emptyHandEntry());
  assert.equal(result.state.entered,false); assert.equal(result.hit,null);
});
test('entering outer before the threshold uses the late-day seam anchor', () => {
  const result=advanceHandEntry({x:200,y:450},{x:194.25,y:288},1435,emptyHandEntry());
  assert.equal(result.state.innerEnabled,false); assert.equal(result.hit?.half,'outer');
  assert.equal(result.hit?.totalMinute,1440);
});
