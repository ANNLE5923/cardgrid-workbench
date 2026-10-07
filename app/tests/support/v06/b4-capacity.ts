/** Synthetic normal-size month/year model. Strict validation + formal restore test, not personal data. */
import type {DataV5,V06History} from '../../../src/workspace/contracts-v06.ts';
import {recordRange} from '../../../src/daily/time.ts';
export function scaleData(seed:DataV5,days:number):DataV5 {
  const data=structuredClone(seed) as any,text='合成感想容量验证。'.repeat(20),content=seed.actionCards[0].content;
  const append=(date:string,at:string,type:string,kind:string,id:string,before:any,after:any)=>{
    const commandId=`scale-${data.planner.history.length}`;
    data.planner.history.push({id:commandId,commandId,at,date,type,entity:{kind,id},before,after} as V06History);
    data.commandReceipts.push({commandId,type,payloadFingerprint:'a'.repeat(64),resultRefs:[{kind,id}]});
  };
  for(let day=0;day<days;day++){
    const date=new Date(Date.UTC(2020,0,1+day)).toISOString().slice(0,10),at=`${date}T00:12:00Z`;
    for(let n=0;n<4;n++){
      const id=`scale-note-${day}-${n}`,before={id,version:1,kind:'reflection',date,zone:'Asia/Shanghai',recordedAt:at,createdAt:at,updatedAt:at,text};
      const after={...before,version:2,text:text+'修改',updatedAt:`${date}T01:12:00Z`};data.journalNotes.push(after);
      append(date,at,'SaveJournalNote','journal-note',id,null,before);append(date,after.updatedAt,'SaveJournalNote','journal-note',id,before,after);
    }
    for(let n=0;n<6;n++){
      const id=`scale-instance-${day}-${n}`,instance={id,version:1,definition:null,creationSnapshot:content,currentContent:content,source:{kind:'manual'},createdAt:at,targetDate:date,state:'open',occurrenceId:null,makeupOf:null};
      const start=new Date(`${date}T02:00:00Z`);start.setUTCHours(2+n);const range=recordRange({startAt:start.toISOString(),endAt:new Date(+start+1800000).toISOString(),zone:'Asia/Shanghai'});
      const fact={id:`scale-fact-${day}-${n}`,instanceId:id,contentSnapshot:content,actualRange:range,plannedSnapshot:null,confirmedAt:range.endAt,source:{kind:'manual'}};
      data.planner.instances.push(instance);data.planner.facts.push(fact);append(date,at,'ScaleFixtureInstance','instance',id,null,instance);append(date,fact.confirmedAt,'ScaleFixtureFact','fact',fact.id,null,fact);
    }
  }return data;
}
