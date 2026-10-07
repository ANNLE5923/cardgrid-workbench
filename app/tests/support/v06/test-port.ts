/** Read-only fixture adapter for interface/UI tests. No Host/IDB/ZIP/file API. */
import type {CatalogV06, JournalTimeline, UnifiedHandItem, V06BusinessPort, V06Result} from '../../../src/workspace/v06.ts';
import {validateV06CommandInput, validateV06PortStamp, V06ContractError} from '../../../src/workspace/v06.ts';
import type {Token} from '../../../src/workspace/contracts.ts';
import {testCapacity} from './fixtures.ts';

const pending = (): V06Result<never> => ({ok:false,code:'CONTRACT_NOT_IMPLEMENTED',message:'P0 测试适配器不执行业务写入',retry:'none'});
export function createV06TestPort(seed: Readonly<{token:Token; catalog:CatalogV06; hand:readonly UnifiedHandItem[]; journal:JournalTimeline}>): V06BusinessPort {
  const data=structuredClone(seed);
  const stamp={contractVersion:'v06-p0-1',backend:'test-adapter',release:'draft'} as const;
  validateV06PortStamp(stamp);
  const stale=(token:Token): V06Result<never> | null => token.epoch!==data.token.epoch
    ? {ok:false,code:'WORKSPACE_REPLACED',message:'测试工作区已替换',retry:'reload'}
    : token.revision!==data.token.revision ? {ok:false,code:'REVISION_CONFLICT',message:'测试快照版本已变化',retry:'reload'} : null;
  return {
    stamp,capacityPolicy:structuredClone(testCapacity),
    async readCatalog({token}) {const error=stale(token); return error??{ok:true,value:{access:'live',token:structuredClone(data.token),data:structuredClone(data.catalog)}};},
    async readDeck({token,deckId}) {
      const error=stale(token); if(error)return error;
      const deck=data.catalog.decks.find(d=>d.id===deckId); if(!deck)return {ok:false,code:'INVALID_INPUT',message:'测试牌堆不存在',retry:'edit'};
      const members=deck.deckKind==='entry'?data.catalog.catalogEntries:deck.deckKind==='action'?data.catalog.actionCards:data.catalog.decisionCards;
      return {ok:true,value:{access:'live',token:structuredClone(data.token),data:structuredClone({deck,members:deck.memberIds.map(id=>members.find(m=>m.id===id)!).filter(Boolean)})}};
    },
    async readUnifiedHand({token}) {const error=stale(token); return error??{ok:true,value:{access:'live',token:structuredClone(data.token),data:structuredClone(data.hand)}};},
    async readJournalTimeline({date,zone,source}) {
      if(source.kind==='archive')return {ok:false,code:'ARCHIVE_MISSING',message:'此测试适配器未加载归档',retry:'none'};
      const error=stale(source.token); if(error)return error;
      if(date!==data.journal.date||zone!==data.journal.zone)return {ok:true,value:{access:'live',editable:true,token:structuredClone(data.token),data:{date,zone,automatic:[],notes:[],legacyBlocks:[]}}};
      return {ok:true,value:{access:'live',editable:true,token:structuredClone(data.token),data:structuredClone(data.journal)}};
    },
    async readJournalDates({year,month}) {const prefix=`${year}-${String(month).padStart(2,'0')}`;return {ok:true,value:{liveDates:data.journal.date.startsWith(prefix)&&data.journal.notes.some(n=>n.text.trim())?[data.journal.date]:[],archiveDates:[]}};},
    async submit(command) {
      try {validateV06CommandInput(command);} catch(error) {
        if(error instanceof V06ContractError)return {ok:false,code:error.code,field:error.field,message:error.message,retry:'edit'};
        throw error;
      }
      return stale(command.expected)??pending();
    },
    async previewCatalogImport() {return pending();}, async previewDecision() {return pending();},
    async selectDecisionEntry() {return pending();}, async previewSynthesis() {return pending();},
    async previewReference() {return pending();}, async cancelPreview() {return pending();},
  };
}
