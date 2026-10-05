import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestDefinition} from '../../../src/drawing/model.ts';
import type {Definition} from '../../../src/workspace/contracts.ts';
import {content} from '../../fixtures/action/independent.ts';

const definition=(id:string,categoryId:string|null,minimum=false,enabled=true):Definition=>({
  id,version:1,enabled,parentDefinitionId:null,source:{kind:'manual'},
  content:{...content(),categoryId,minimum},
});
test('empty/filtered pools do not consume randomness or mutate the source',()=>{
  const data=Object.freeze([Object.freeze(definition('off','a',true,false))]);
  assert.equal(suggestDefinition(data,{},()=>{throw Error('unexpected random');}),null);
  assert.deepEqual(data,[definition('off','a',true,false)]);
});
test('category, minimum and enabled filtering preserve the selected definition identity',()=>{
  const data=[definition('other','b',true),definition('normal','a'),definition('chosen','a',true)];
  const before=structuredClone(data);
  assert.equal(suggestDefinition(data,{categoryId:'a',minimum:true},()=>0),data[2]);
  assert.deepEqual(data,before);
  assert.equal(suggestDefinition([definition('none',null)],{categoryId:null},()=>0)?.id,'none');
});
test('rejection sampling discards the biased upper tail before selection',()=>{
  const data=[definition('a',null),definition('b',null),definition('c',null)];
  const values=[0xffffffff,4];let calls=0;
  assert.equal(suggestDefinition(data,{},()=>values[calls++]),data[1]);
  assert.equal(calls,2);
});
