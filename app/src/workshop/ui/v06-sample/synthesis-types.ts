// A0 合成样稿类型：隔离样稿专用，P0 冻结后由正式 DTO 取代。
export type SynthesisMaterialKind = 'action' | 'answer';

export type SynthesisField = Readonly<{ key: string; value: string }>;

export type SynthesisMaterial = Readonly<{
  instanceId: string;
  kind: SynthesisMaterialKind;
  name: string;
  source: string;
  fields?: readonly SynthesisField[];
}>;

export type SynthesisProduct = Readonly<{
  name: string;
  source: string;
  fields: readonly SynthesisField[];
  consumed: readonly string[];
}>;
