// A0 synthetic display state. No production model, Host or persistence imports.
export const actionSeeds = [
  ['reading', '阅读《{书名}》', 25, '读完一个小节，留下一句话笔记。', 'book'],
  ['walk', '出去走一走', 20, '离开桌面，走一段熟悉的路。'],
  ['notes', '整理今天的笔记', 15, '把零散记录整理成三个要点。'],
  ['review', '写下今日复盘', 10, '记录一件完成的事与一个调整。'],
  ['stretch', '做一组拉伸', 10, '让肩颈与手腕放松下来。'],
  ['desk', '整理桌面', 15, '收好散落物品，留出下一次工作的空间。'],
  ['focus', '专注推进一个小任务', 25, '明确一个可交付结果，完成后再停下。'],
  ['idea', '记下一个新想法', 5, '写清想法，以及它要解决的问题。'],
  ['water', '休息与补水', 5, '离开屏幕片刻。'],
  ['learn', '学习一个工程概念', 25, '用自己的话解释，并举一个例子。'],
];
export const bookSeeds = [
  ['深度工作', '卡尔·纽波特'], ['原子习惯', '詹姆斯·克利尔'],
  ['设计心理学', '唐纳德·诺曼'], ['人月神话', '弗雷德里克·布鲁克斯'],
  ['程序员修炼之道', '安德鲁·亨特等'], ['重构', '马丁·福勒'],
  ['置身事内', '兰小欢'], ['思考，快与慢', '丹尼尔·卡尼曼'],
  ['悉达多', '赫尔曼·黑塞'], ['小王子', '安托万·德·圣埃克苏佩里'],
];

export function fixtures(count = 10) {
  count = Math.min(count, 100);
  const actions = Array.from({length: count}, (_, i) => {
    const [key, title, minutes, criterion, slot] = actionSeeds[i % actionSeeds.length];
    return {id: `action-${key}-${i}`, kind: 'action', title: title + (i >= 10 ? ` · 样本 ${i + 1}` : ''), minutes, criterion, slot};
  });
  const books = Array.from({length: count}, (_, i) => ({
    id: `book-${i}`, kind: 'book', title: bookSeeds[i % 10][0] + (i >= 10 ? ` · 样本 ${i + 1}` : ''), author: bookSeeds[i % 10][1],
  }));
  return {
    learning: {id: 'learning', name: '阅读与学习', kind: 'collection', caption: '目录 · 2 个牌堆', symbol: '↗', description: '行动与书目各有自己的牌堆。', children: ['actions', 'books']},
    actions: {id: 'actions', name: '日常行动', kind: 'action', caption: `行动 · ${count} 张`, symbol: '↗', description: '短小、具体，可以开始的事情。', cards: actions},
    books: {id: 'books', name: '我的书架', kind: 'book', caption: `书目 · ${count} 张`, symbol: '▤', description: '为阅读行动选择一本书。', cards: books},
    review: {id: 'review', name: '复盘与记录', kind: 'action', caption: '行动 · 3 张', symbol: '✎', description: '把发生的事情留在纸面上。', cards: actions.filter((_, i) => [2, 3, 7].includes(i))},
    rest: {id: 'rest', name: '休息片刻', kind: 'action', caption: '行动 · 3 张', symbol: '○', description: '给自己留一点轻松的空隙。', cards: actions.filter((_, i) => [1, 4, 8].includes(i))},
    empty: {id: 'empty', name: '新的牌堆', kind: 'book', caption: '书目 · 0 张', symbol: '+', description: '从一本想读的书开始。', cards: []},
  };
}

// Shuffle belongs to this disposable sample. Formal unbiased selection is B2.
export function shuffled(ids, random = Math.random) {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function openScene(pool, mode, random = Math.random) {
  const ids = pool.children ?? pool.cards.map(card => card.id);
  return {poolId: pool.id, mode, order: shuffled(ids, random), phase: 'candidate', selectedId: null, angle: 0, slots: {}, drafts: {}, feedback: ''};
}

export function selectCard(scene, id) {
  if (scene.phase !== 'candidate' || !scene.order.includes(id)) return scene;
  return {...scene, selectedId: id, phase: scene.mode === 'draw' ? 'front' : 'revealed', slots: {...scene.drafts?.[id]}, feedback: '', accepted: false};
}

export function revealCard(scene, id) {
  if (scene.phase !== 'front' || scene.selectedId !== id) return scene;
  return {...scene, phase: 'revealed'};
}

export function returnCard(scene) {
  const drafts = {...scene.drafts, ...(scene.selectedId ? {[scene.selectedId]: {...scene.slots}} : {})};
  return {...scene, drafts, selectedId: null, phase: 'candidate', slots: {}, feedback: '', accepted: false};
}

export function motionState({staticMode, sceneCount, topPhase, mode}) {
  if (staticMode) return {matrix: 'paused', sphere: 'paused', speed: 0};
  return {matrix: sceneCount ? 'paused' : 'running', sphere: sceneCount && topPhase === 'candidate' ? 'running' : 'paused', speed: mode === 'draw' ? 0.52 : 0.12};
}

export function spherePoints(count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({length: count}, (_, i) => {
    const y = count === 1 ? 0 : 1 - 2 * (i + 0.5) / count;
    const radius = Math.sqrt(1 - y * y);
    return {x: Math.cos(i * golden) * radius, y, z: Math.sin(i * golden) * radius};
  });
}

export function composedTitle(card, book) {
  return card.slot === 'book' ? card.title.replace('{书名}', book?.title ?? '书名') : card.title;
}
