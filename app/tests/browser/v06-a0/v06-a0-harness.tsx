// v0.6 A0 体验样稿总装：隔离合成数据，不连接个人 IndexedDB，所有“保存/写入/打出”均为模拟。
// 四个场景（工坊矩阵 / 决策翻牌 / 三槽合成 / 时间线日记）共用右下角同一份手牌，
// 走通“吃什么、读什么、练什么、只存网址清单”。供 B 线正式接入，不代表 P0 接口已冻结。
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkshopMatrixSample} from '../../../src/workshop/ui/v06-sample/WorkshopMatrixSample.tsx';
import {SynthesisBenchSample} from '../../../src/workshop/ui/v06-sample/SynthesisBenchSample.tsx';
import type {SynthesisMaterial, SynthesisProduct} from '../../../src/workshop/ui/v06-sample/synthesis-types.ts';
import {DecisionMatrixSample} from '../../../src/decision/ui/DecisionMatrixSample.tsx';
import type {SampleAnswer, SampleQuestionId} from '../../../src/decision/ui/sample-data.ts';
import type {SampleEntry} from '../../../src/workshop/ui/v06-sample/sample-data.ts';
import {TimelineJournalSample} from '../../../src/journal/ui/TimelineJournalSample.tsx';
import {HandDockSample} from './HandDockSample.tsx';
import type {DockCard, DockCardKind} from './HandDockSample.tsx';
import './harness.css';
import '../../../src/app/style.css';

type Scene = 'workshop' | 'decision' | 'synthesis' | 'journal';

let counter = 0;
const nextId = () => `inst-${++counter}`;

const SCENE_TABS: readonly Readonly<{id: Scene; label: string}>[] = [
  {id: 'workshop', label: '工坊矩阵'},
  {id: 'decision', label: '决策翻牌'},
  {id: 'synthesis', label: '三槽合成'},
  {id: 'journal', label: '时间线日记'},
];
const QUESTION_TABS: readonly Readonly<{id: SampleQuestionId; label: string}>[] = [
  {id: 'eat', label: '吃什么'},
  {id: 'read', label: '读什么'},
  {id: 'train', label: '练什么'},
];

// 手牌中的本次素材 → 合成台素材；样稿给吃饭/番茄鸡蛋面附加展示字段。
const toMaterials = (cards: readonly DockCard[]): SynthesisMaterial[] =>
  cards.filter(c => c.kind !== 'product').map(c => {
    const base = {
      instanceId: c.instanceId, kind: c.kind as 'action' | 'answer',
      name: c.name, source: c.source,
    };
    if (c.kind === 'action' && c.name === '吃饭')
      return {...base, fields: [{key: '餐次', value: '午餐'}, {key: '地点', value: '家'}]};
    if (c.kind === 'answer' && c.name === '番茄鸡蛋面')
      return {...base, fields: [{key: '口味', value: '清淡'}]};
    return base;
  });

function Harness() {
  const [scene, setScene] = useState<Scene>('workshop');
  const [questionId, setQuestionId] = useState<SampleQuestionId>('eat');
  const [cards, setCards] = useState<readonly DockCard[]>([]);
  const [isToday, setIsToday] = useState(false);
  const [log, setLog] = useState<readonly string[]>([]);
  const [resetKey, setResetKey] = useState(0);

  const appendLog = (line: string) =>
    setLog(prev => [`${line}（样稿模拟）`, ...prev].slice(0, 30));

  const pushCards = (entries: ReadonlyArray<Omit<DockCard, 'instanceId'>>) =>
    setCards(prev => [...prev, ...entries.map(e => ({...e, instanceId: nextId()}))]);

  const onTakeAction = (entry: SampleEntry) => {
    pushCards([{
      kind: 'action' as DockCardKind, name: entry.name,
      source: '工坊 · 常用行动（原卡本次副本）', detail: entry.detail,
    }]);
    appendLog(`直接拿牌：${entry.name}`);
  };

  const onAcceptAnswer = (answer: SampleAnswer, withAction: boolean) => {
    const additions: Array<Omit<DockCard, 'instanceId'>> = [{
      kind: 'answer', name: answer.name, detail: answer.detail,
      source: `决策「${answer.question}」· ${answer.source}`,
    }];
    if (withAction) additions.push({
      kind: 'action', name: answer.actionName,
      source: '工坊 · 常用行动（原卡本次副本）',
    });
    pushCards(additions);
    appendLog(withAction
      ? `接受答案并拿行动牌：${answer.actionName} · ${answer.name}`
      : `只取答案：${answer.name}`);
  };

  const onPrepareSamples = () => {
    setCards(prev => {
      const next = [...prev];
      if (!next.some(c => c.kind === 'action' && c.name === '吃饭'))
        next.push({instanceId: nextId(), kind: 'action', name: '吃饭',
          source: '工坊 · 常用行动（原卡本次副本）'});
      if (!next.some(c => c.kind === 'answer' && c.name === '番茄鸡蛋面'))
        next.push({instanceId: nextId(), kind: 'answer', name: '番茄鸡蛋面',
          source: '决策「这餐吃什么？」· 餐食清单'});
      return next;
    });
    appendLog('准备样稿素材：吃饭 ＋ 番茄鸡蛋面');
    setScene('synthesis');
  };

  const onCommit = (product: SynthesisProduct) => {
    setCards(prev => [
      ...prev.filter(c => !product.consumed.includes(c.instanceId)),
      {
        instanceId: nextId(), kind: 'product', name: product.name, source: product.source,
        detail: product.fields.map(f => `${f.key}=${f.value}`).join(' · '),
      },
    ]);
    appendLog(`确认合成：${product.name}`);
  };

  const onOpenUrl = (url: string, title: string) =>
    appendLog(`从清单打开网址：${title} ${url}`);
  const onPlay = (card: DockCard) => appendLog(`打出牌：${card.name}`);

  const resetAll = () => {
    setCards([]); setLog([]); setIsToday(false);
    setQuestionId('eat'); setScene('workshop'); setResetKey(k => k + 1);
  };

  return (
    <div className="app paper comfortable" style={{display: 'block', minHeight: '100vh'}}>
      <main className="action-shell">
        <div className="v06-banner" role="note">
          <strong>v0.6 A0 体验样稿</strong>
          <span>隔离合成数据 · 未连接个人 IndexedDB · 所有保存／写入／打出均为模拟，不代表正式功能已实现</span>
        </div>

        <div className="v06-tabrow">
          <div className="segmented v06-segmented" role="tablist" aria-label="样稿场景">
            {SCENE_TABS.map(tab =>
              <button key={tab.id} type="button" role="tab"
                aria-pressed={scene === tab.id}
                onClick={() => setScene(tab.id)}>{tab.label}</button>)}
          </div>
          <button type="button" onClick={resetAll}>重置样稿</button>
        </div>

        {scene === 'decision' ? (
          <div className="segmented v06-segmented v06-questions" aria-label="决策领域">
            {QUESTION_TABS.map(tab =>
              <button key={tab.id} type="button" aria-pressed={questionId === tab.id}
                onClick={() => setQuestionId(tab.id)}>{tab.label}</button>)}
          </div>
        ) : null}

        <section className="v06-scene" key={`${scene}-${resetKey}`}>
          {scene === 'workshop'
            ? <WorkshopMatrixSample onTakeAction={onTakeAction} onOpenUrl={onOpenUrl} /> : null}
          {scene === 'decision'
            ? <DecisionMatrixSample questionId={questionId} onAcceptAnswer={onAcceptAnswer} /> : null}
          {scene === 'synthesis'
            ? <SynthesisBenchSample materials={toMaterials(cards)}
                onCommit={onCommit} onPrepareSamples={onPrepareSamples} /> : null}
          {scene === 'journal'
            ? <TimelineJournalSample /> : null}
        </section>

        <details className="v06-log panel">
          <summary>维护日志样稿（模拟 · 折叠查看，当前 {log.length} 条）</summary>
          {log.length === 0
            ? <p className="muted">暂无操作记录。试试在工坊拿牌、从清单打开网址或打出手牌。</p>
            : <ul>
                {log.map((line, i) => <li key={i}>{line}</li>)}
              </ul>}
        </details>
      </main>

      <HandDockSample cards={cards} isToday={isToday}
        onTodayModeChange={setIsToday} onPlay={onPlay} />
    </div>
  );
}

const el = document.createElement('div');
document.body.appendChild(el);
createRoot(el).render(<Harness />);
