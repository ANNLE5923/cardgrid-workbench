/** Compiled by the P0 tsc project; never executed. Negative assertions guard the contract. */
import type {ArchiveView, HandCard, ReferencePlacement, TextOutputState, V06BusinessPort, V06Command} from '../../../src/workspace/v06.ts';
import type {Command, WorkspaceData} from '../../../src/workspace/contracts.ts';
import type {DataV5} from '../../../src/workspace/v06.ts';
declare const command: V06Command;
declare const futureData: DataV5;
declare const answer: Extract<HandCard,{kind:'answer'}>;
declare const history: ArchiveView;
declare const port: V06BusinessPort;
declare const fileState: TextOutputState;
// @ts-expect-error P0 command contract must not widen the production Command union.
const currentCommand: Command = command;
// @ts-expect-error Data5 must not enable current production parsing or saving.
const currentData: WorkspaceData = futureData;
// @ts-expect-error Answers have no executable Content/Instance payload.
answer.actionInstanceId;
// @ts-expect-error History access can never be reported editable.
const editableArchive: ArchiveView = {...history,editable:true};
// @ts-expect-error Point and attached references cannot carry each other's fields.
const badPoint: ReferencePlacement = {id:'r',version:1,answerId:'a',createdAt:'x',changedAt:'x',state:'active',mode:'point',targetInstanceId:'i'};
// @ts-expect-error The archive view offers no mutation endpoint.
port.updateArchive;
// @ts-expect-error Browser handles are private to the file adapter, never UI DTOs.
fileState.key.directoryHandle;
// @ts-expect-error Caller-supplied timestamps cannot spoof the original note time.
port.submit({contractVersion:'v06-p0-1',commandId:'c',expected:{epoch:'e',revision:0},type:'SaveJournalNote',payload:{id:null,expectedVersion:null,date:'2026-10-06',zone:'UTC',text:'x',recordedAt:'y'}});
