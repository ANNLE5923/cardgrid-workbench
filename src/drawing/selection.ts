import type {Definition} from '../workspace/index.ts';

export type DefinitionFilter = Readonly<{categoryId?:string|null;minimum?:boolean}>;

/** Candidate selection is read-only. Acceptance remains a separate workspace command. */
export function suggestDefinition(
  definitions:readonly Definition[],
  filter:DefinitionFilter,
  random:()=>number=()=>crypto.getRandomValues(new Uint32Array(1))[0],
):Definition|null {
  const eligible=definitions.filter(d=>d.enabled
    &&(filter.categoryId===undefined||d.content.categoryId===filter.categoryId)
    &&(!filter.minimum||d.content.minimum));
  if(!eligible.length)return null;
  // Preserve the existing rejection sampler: modulo bias must not favor a candidate.
  const bound=Math.floor(0x100000000/eligible.length)*eligible.length;
  let value:number;
  do{value=random();}while(value>=bound);
  return eligible[value%eligible.length];
}
