import {fixtures, openScene, selectCard, revealCard, returnCard, motionState, spherePoints, composedTitle} from './scene.mjs';

const root = document.querySelector('#root');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const narrow = matchMedia('(max-width: 650px)');
const query = new URLSearchParams(location.search);
const state = {
  view: ['today', 'workshop', 'drawing'].includes(query.get('view')) ? query.get('view') : 'workshop',
  count: [10, 100].includes(Number(query.get('count'))) ? Number(query.get('count')) : 10,
  display: ['list', 'sphere'].includes(query.get('display')) ? query.get('display') : 'auto',
  still: query.get('still') === '1', pools: {}, scenes: [], hand: [], archive: false, filter: 'all', notice: '',
};
state.pools = fixtures(state.count);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const top = () => state.scenes.at(-1);
const isStill = () => state.still || reduced.matches || top()?.still === true;
const isList = (scene = top()) => (scene?.display ?? state.display) === 'list' || ((scene?.display ?? state.display) === 'auto' && (narrow.matches || reduced.matches));
const modeForView = () => state.view === 'drawing' ? 'draw' : 'edit';
const motion = () => motionState({staticMode: isStill(), sceneCount: state.scenes.length, topPhase: top()?.phase, mode: top()?.mode ?? modeForView()});
const badge = text => `<span class="tag">${h(text)}</span>`;
const button = (action, text, extra = '') => `<button type="button" data-action="${action}" ${extra}>${text}</button>`;
const bookById = id => state.pools.books.cards.find(book => book.id === id);
const cardIn = scene => state.pools[scene.poolId].cards?.find(card => card.id === scene.selectedId);
const announce = message => {document.querySelector('#announcer').textContent = message;};

function shell() {
  return `<div class="app" ${state.scenes.length || state.archive ? 'inert' : ''}>
    <aside class="sidebar">
      <a class="brand" href="?view=workshop"><span class="brand-mark" aria-hidden="true">C<span>G</span></span><span>CardGrid<small>个人工作台</small></span></a>
      <nav aria-label="样稿导航">
        ${[['today', '01', 'Today · 今日', '开始今天'], ['workshop', '02', '制卡工坊', '管理原卡与牌堆'], ['drawing', '03', '抽卡手牌', '选择，再开始']].map(([view, no, title, sub]) => button('navigate', `<span class="nav-number">${no}</span><span>${title}<small>${sub}</small></span>`, `data-view="${view}" ${view === state.view ? 'aria-current="page"' : ''}`)).join('')}
      </nav>
      <div class="sidebar-note"><span class="eyebrow">A0 / VISUAL STUDY</span><p>工坊与抽卡<br>视觉交互样稿</p><small>全部为合成数据<br>刷新恢复初始样例</small></div>
    </aside>
    <main>
      <div class="sample-banner">${badge('A0 样稿')}<span>只供体验与确认，修改和接受仅保留在当前页面。</span><span class="sample-date">v0.3 · 2026.10.04</span></div>
      <div class="page-content">${state.view === 'today' ? todayPage() : state.view === 'drawing' ? drawingPage() : workshopPage()}</div>
      <div class="preview-controls" aria-label="样稿显示设置">
        <label>展示方式<select id="display"><option value="auto" ${state.display === 'auto' ? 'selected' : ''}>自动（窄屏 / 减少动态用列表）</option><option value="sphere" ${state.display === 'sphere' ? 'selected' : ''}>球面</option><option value="list" ${state.display === 'list' ? 'selected' : ''}>列表</option></select></label>
        <label class="check"><input id="still" type="checkbox" ${isStill() ? 'checked' : ''} ${reduced.matches ? 'disabled' : ''}>${reduced.matches ? '系统减少动态：静止' : '静止 / 停止运动'}</label>
        <label>样本密度<select id="count">${[10, 100].map(n => `<option value="${n}" ${n === state.count ? 'selected' : ''}>${n} 张</option>`).join('')}</select></label>
      </div>
    </main>
  </div>`;
}

function pageTitle(en, title, subtitle, commands = '') {
  return `<header class="page-heading"><div><div class="eyebrow">${en}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-commands">${commands}</div></header>`;
}

function matrix(mode) {
  const pools = Object.values(state.pools).filter(pool => state.filter === 'all' || pool.kind === state.filter);
  return `<div id="matrix" class="matrix-grid" data-motion="${motion().matrix}" aria-label="${mode === 'edit' ? '工坊牌堆矩阵' : '抽取牌堆矩阵'}">
    ${pools.map((pool, i) => `<button class="deck-tile" type="button" data-action="open-pool" data-pool="${pool.id}" style="--phase:${i * -0.7}s" aria-label="进入${h(pool.name)}">
      <span class="deck-art" aria-hidden="true"><span class="deck-paper paper-third"></span><span class="deck-paper paper-second"></span><span class="deck-paper paper-top ${pool.kind}"><span class="paper-caption">${pool.kind === 'collection' ? 'COLLECTION' : pool.kind === 'book' ? 'BOOK POOL' : 'ACTION POOL'}</span><span class="paper-symbol">${pool.symbol}</span><span class="paper-name">${h(pool.name)}</span><span class="paper-line"></span></span></span>
      <span class="deck-text"><strong>${h(pool.name)}</strong><span>${h(pool.caption)}</span></span><span class="deck-arrow" aria-hidden="true">↗</span>
    </button>`).join('')}
  </div>`;
}

function workshopPage() {
  return `${pageTitle('WORKSHOP', '制卡工坊', '把想做的事放进牌堆，慢慢整理成自己的行动库。', button('open-pool', '查看日常行动 ↗', 'data-pool="actions" class="primary"'))}
    <div class="section-heading"><h2>我的牌堆 <span class="muted">/ 06</span></h2><div class="segments" aria-label="牌堆种类">${[['all', '全部'], ['action', '行动'], ['book', '书目']].map(([filter, title]) => button('filter', title, `data-filter="${filter}" aria-pressed="${state.filter === filter}"`)).join('')}</div></div>
    ${matrix('edit')}
    <div class="workshop-foot"><div><span class="eyebrow">EDIT / 整理</span><p>卡面慢转，点开查看或修改原卡。</p><span class="muted">进入一层，上一层就停下来；关闭单卡后归位。</span></div><div class="inline-note"><span class="note-symbol">↳</span><div><strong>牌堆有层级，卡种各自独立</strong><p>试试「阅读与学习」目录，再进入行动或书目牌堆。</p></div></div></div>`;
}

function drawingPage() {
  const groups = new Map();
  for (const entry of state.hand) {
    const group = groups.get(entry.title) ?? []; group.push(entry); groups.set(entry.title, group);
  }
  return `${pageTitle('DRAWING / HAND', '抽卡手牌', '挑一个建议，补齐内容，再决定是否接受。', button('archive', '副本归档 ↗', 'class="quiet"'))}
    <div class="section-heading"><h2>从哪个牌堆开始？</h2>${badge('抽取模式 · 卡背快转')}</div>
    ${matrix('draw')}
    <section class="hand-section" aria-labelledby="hand-title"><div class="section-heading"><h2 id="hand-title" tabindex="-1">样稿手牌 <span class="muted">/ ${state.hand.length.toString().padStart(2, '0')}</span></h2><small>叠牌位置示意 · 正式分组按 C0 合同</small></div>
      ${groups.size ? `<div class="hand-groups">${[...groups].map(([title, entries]) => `<details class="hand-stack"><summary><span class="stack-symbol" aria-hidden="true">▱</span><strong>${h(title)}</strong>${badge('×' + entries.length)}<span class="muted">逐份查看 ↓</span></summary>${entries.map((entry, i) => `<div class="hand-copy" data-instance-id="${entry.id}"><span>第 ${i + 1} 份</span><strong>${h(entry.title)}</strong><span>来源 ${entry.sourceDate}</span><span>${entry.minutes} 分钟 · 未排期</span></div>`).join('')}</details>`).join('')}</div>` : '<div class="hand-empty"><span aria-hidden="true">▱</span><div><strong>接受后，行动会出现在这里</strong><p>先点一张卡让它前置，再点一次翻开。查看与取消都不会增加手牌。</p></div></div>'}
    </section>`;
}

function todayPage() {
  return `${pageTitle('TODAY', 'Today · 今日', '2026 年 10 月 4 日，星期日', button('navigate', '去抽卡 ↗', 'data-view="drawing" class="primary"'))}
    <div class="today-layout"><section class="today-timeline"><div class="section-heading"><h2>今天的时间</h2>${badge('入口位置示意')}</div>${[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map(hour => `<div class="time-row"><span>${hour.toString().padStart(2, '0')}:00</span><div>${hour === 9 ? '<span class="time-block">专注时间 · 合成示例</span>' : hour === 12 ? '<span class="time-block">午间休息 · 合成示例</span>' : ''}</div></div>`).join('')}</section><section class="today-aside"><span class="eyebrow">NEXT ACTION</span><h2>给下一步一点灵感</h2><p>从牌堆里选一个行动，接受后再安排时间。</p>${button('navigate', '打开抽卡手牌', 'data-view="drawing" class="primary"')}<hr><h2>整理自己的行动库</h2><p>原卡、书目与牌堆在工坊维护。</p>${button('navigate', '去制卡工坊', 'data-view="workshop"')}</section></div>`;
}

function sceneView(scene, index) {
  const pool = state.pools[scene.poolId], active = index === state.scenes.length - 1;
  const list = isList(scene);
  const speed = isStill() || !active || scene.phase !== 'candidate' ? 'paused' : 'running';
  const caption = pool.kind === 'collection' ? '目录层 · 选择一个牌堆继续' : scene.mode === 'edit' ? '编辑模式 · 卡面慢转' : '抽取模式 · 卡背快转';
  const entries = scene.order.map((id, i) => ({id, number: i + 1, card: pool.cards?.find(card => card.id === id), child: pool.children ? state.pools[id] : null}));
  const renderCard = ({id, number, card, child}) => {
    const hidden = scene.mode === 'draw' && !child;
    const label = child ? `进入${child.name}` : hidden ? `选择第 ${number} 张卡，前置` : `查看${card.title}`;
    return `<button type="button" class="${list ? 'pick-item' : 'orbit-card'} ${hidden ? 'card-back' : 'card-face'} ${card?.kind ?? 'collection'}" data-action="pick" data-card-id="${id}" data-number="${number}" aria-label="${h(label)}">
      ${hidden ? `<span class="back-glyph" aria-hidden="true">CG</span><span class="card-number">${number.toString().padStart(2, '0')}</span>${list ? '<span>未翻开的卡片</span><span class="muted">选择 → 翻开</span>' : '<span class="back-caption">CARDGRID</span>'}` : `<span class="card-kind">${child ? '目录 / 牌堆' : card.kind === 'book' ? '书目' : '行动'}</span><strong>${h(child?.name ?? card.title)}</strong><small>${child ? h(child.caption) : card.kind === 'book' ? h(card.author) : card.minutes + ' MIN'}</small>`}
    </button>`;
  };
  return `<div class="scene-layer" style="--layer:${30 + index * 20}" ${active ? '' : 'inert'}>
    <section class="scene-panel" role="dialog" aria-modal="${active}" aria-label="${h(pool.name)}牌堆" data-scene-index="${index}" data-phase="${scene.phase}" data-still="${isStill()}">
      <header class="scene-header"><div><div class="breadcrumbs">${button('close-all', '所有牌堆', 'class="quiet"')}<span>/</span>${state.scenes.slice(0, index + 1).map((s, i) => `<span>${h(state.pools[s.poolId].name)}</span>`).join('<span>/</span>')}</div><h2>${h(pool.name)} ${badge(pool.kind === 'collection' ? '目录' : scene.order.length + ' 张')}</h2><p>${caption}</p></div>${button('close-scene', index ? '返回上一层' : '返回牌堆', 'class="scene-close"')}</header>
      <div class="scene-toolbar"><span>${list ? '逐张列表' : '球面展开'}${isStill() ? ' · 静止' : ''}</span><div>${!Number.isInteger(scene.slotTarget) ? `<div class="segments" aria-label="当前牌堆模式">${button('scene-mode', '编辑', `data-mode="edit" aria-pressed="${scene.mode === 'edit'}"`)}${button('scene-mode', '抽取', `data-mode="draw" aria-pressed="${scene.mode === 'draw'}"`)}</div>` : badge('填写书名')}${button('toggle-display', list ? '切换球面' : '切换列表', 'class="quiet"')}${button('toggle-still', isStill() ? '静止中' : '停止运动', `class="quiet" aria-pressed="${isStill()}" ${reduced.matches ? 'disabled' : ''}`)}</div></div>
      <div class="scene-stage ${list ? 'list-stage' : 'sphere-stage'} ${scene.phase !== 'candidate' ? 'has-selection' : ''}" data-motion="${speed}">
        ${!scene.order.length ? '<div class="empty-pool"><span aria-hidden="true">+</span><h3>这个牌堆还没有书目</h3><p>空池不选卡，也不随机。编辑表单将在 A2 推进。</p></div>' : ''}
        <div class="${list ? 'card-list' : 'sphere-surface'}" ${scene.phase !== 'candidate' ? 'inert' : ''} data-order="${scene.order.join(',')}">${!list ? '<div class="sphere-ring ring-one" aria-hidden="true"></div><div class="sphere-ring ring-two" aria-hidden="true"></div>' : ''}${entries.map(renderCard).join('')}</div>
        ${scene.phase === 'front' ? `<div class="front-dock"><div class="front-explainer">已选中第 ${scene.order.indexOf(scene.selectedId) + 1} 张 · 球面暂停</div>${button('reveal', `<span class="card-number">${String(scene.order.indexOf(scene.selectedId) + 1).padStart(2, '0')}</span><span class="back-glyph" aria-hidden="true">CG</span><span class="back-caption">CARDGRID</span><strong>再次点击翻开</strong>`, `class="front-card card-back" data-card-id="${scene.selectedId}" style="--origin-x:${scene.frontOrigin?.x ?? 0}px;--origin-y:${scene.frontOrigin?.y ?? 0}px;--origin-scale:${scene.frontOrigin?.scale ?? .5}" aria-label="翻开已前置的卡片"`)}${button('return-card', '收回这张卡', 'class="quiet"')}</div>` : ''}
      </div>
      <footer class="scene-footer"><span class="state-dot ${speed}"></span><span>${scene.phase === 'front' ? '这张卡已经前置；翻开它不会重新选卡。' : scene.phase === 'revealed' ? '正在查看单卡，球面与背景矩阵已暂停。' : pool.kind === 'collection' ? '进入下层后，本层暂停；返回时恢复原来的位置。' : scene.mode === 'draw' ? '第一次：点卡停转并前置。第二次：点击前置卡翻开。' : '点卡进入详情；关闭后回到原位置。'}</span><span class="keyboard-hint">Tab 选择 · Enter 打开 · Esc 返回</span></footer>
      ${scene.phase === 'revealed' ? detailView(scene, pool, index) : ''}
    </section>
  </div>`;
}

function detailView(scene, pool, index) {
  const card = cardIn(scene), book = bookById(scene.slots.book);
  if (!card) return '';
  const title = scene.mode === 'draw' ? composedTitle(card, book) : card.title;
  return `<div class="detail-backdrop"><section class="detail-panel ${card.kind}" role="dialog" aria-modal="true" aria-label="${scene.mode === 'edit' ? '编辑原卡' : '已翻开的卡片'}" data-detail-index="${index}" data-card-id="${card.id}">
    <header><div class="eyebrow">${card.kind === 'book' ? 'BOOK / 书目词条' : scene.mode === 'edit' ? 'ORIGINAL / 行动原卡' : 'ACTION / 行动副本'}</div>${button('return-card', '收回卡片', 'class="quiet"')}</header>
    <div class="detail-title"><span class="detail-symbol" aria-hidden="true">${card.kind === 'book' ? '▤' : '↗'}</span><h3>${h(title)}</h3>${card.kind === 'action' ? badge(card.minutes + ' 分钟') : `<p>${h(card.author)}</p>`}</div>
    ${scene.mode === 'edit' ? `<form id="edit-form"><label>${card.kind === 'book' ? '书名' : '行动名称'}<input name="title" value="${h(card.title)}" required maxlength="120"></label>${card.kind === 'book' ? `<label>作者<input name="author" value="${h(card.author)}" maxlength="120"></label>` : `<label>预设时长（分钟）<input name="minutes" type="number" min="5" max="1440" step="5" value="${card.minutes}" required></label><label>完成标准<textarea name="criterion" rows="2" maxlength="300">${h(card.criterion)}</textarea></label>`}<p class="muted">这里仅试改样稿卡面；正式字段以 C0 为准，表单与保存由后续任务接入。</p><button class="primary" type="submit">保留样稿修改</button></form>` : `${card.kind === 'action' ? `<div class="criterion"><span class="eyebrow">完成标准</span><p>${h(card.criterion)}</p></div>` : '<p class="detail-note">书目只用来填写行动中的书名。</p>'}
      ${card.slot ? `<div class="slot-field"><label for="book-choice">填写书名 <span class="muted">来自「我的书架」</span></label><select id="book-choice"><option value="" disabled ${!book ? 'selected' : ''}>请选择书名…</option><option value="random">随机</option>${state.pools.books.cards.map(b => `<option value="${b.id}" ${book?.id === b.id ? 'selected' : ''}>${h(b.title)}</option>`).join('')}</select>${button('slot-sphere', '用球面选一本 ↗', 'class="quiet"')}<p class="slot-help">选择「随机」会立即填入一本书；重新打开详情不会重抽。</p><small class="muted">本例演示必填书名；可空预留位遵循 C0 合同。</small></div>` : ''}
      <div class="source-line">${card.kind === 'action' ? '<span>来源日期</span><strong>2026-10-04</strong><span>未排期</span>' : '<span>来源牌堆</span><strong>我的书架</strong>'}</div>
      ${card.kind === 'book' ? Number.isInteger(scene.slotTarget) ? button('use-book', '使用这本书', 'class="primary wide"') : '<p class="muted">可从阅读行动的预留位进入这里，选好后返回完整行动。</p>' : button('accept', '接受到样稿手牌', `class="primary wide" ${card.slot && !book ? 'disabled' : ''}`)}
      ${scene.accepted ? button('view-hand', '查看样稿手牌 →', 'class="quiet wide"') : ''}`}
    ${scene.feedback ? `<p class="detail-feedback" role="status">${h(scene.feedback)}</p>` : ''}
  </section></div>`;
}

function archiveView() {
  return `<div class="scene-layer archive-layer"><section class="archive-panel" role="dialog" aria-modal="true" aria-label="副本归档样例"><header><div><div class="eyebrow">ARCHIVE / 从属入口</div><h2>副本归档</h2></div>${button('close-archive', '返回手牌')}</header><p class="muted">只读样例，用于确认入口位置。真实归档尚未接入。</p><article class="archive-row"><div>${badge('每日副本到期')}<span>2026-10-03</span></div><h3>阅读《深度工作》</h3><dl><dt>来源日期</dt><dd>2026-09-26</dd><dt>来源原卡</dt><dd>阅读《{书名}》 · 示例版本 1</dd><dt>处理示例</dt><dd>活动副本移出，未完成排期撤销。</dd><dt>历史记录</dt><dd>已有完成事实与批注继续保留。</dd></dl></article></section></div>`;
}

function scope() {
  return root.querySelector('[data-detail-index="' + (state.scenes.length - 1) + '"]') ?? root.querySelector('[data-scene-index="' + (state.scenes.length - 1) + '"]') ?? root.querySelector('.archive-panel') ?? root;
}
function focusables(container) {
  return [...container.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea,[tabindex="0"]')].filter(el => !el.closest('[inert]') && el.getClientRects().length);
}
function render(focusSelector) {
  const oldId = document.activeElement?.id;
  root.innerHTML = shell() + state.scenes.map(sceneView).join('') + (state.archive ? archiveView() : '');
  positionSpheres();
  const container = scope();
  const target = (focusSelector ? container.querySelector(focusSelector) : oldId ? container.querySelector('#' + oldId) : null) ?? (state.scenes.length || state.archive ? focusables(container)[0] : null);
  target?.focus({preventScroll: true});
}

function enter(poolId, options = {}) {
  const scene = {...openScene(state.pools[poolId], options.mode ?? top()?.mode ?? modeForView()), ...options};
  if (narrow.matches && options.display === 'sphere') scene.still = true;
  state.scenes.push(scene);
  render(isList() ? '.pick-item' : '.orbit-card');
  announce(`进入${state.pools[poolId].name}，${scene.mode === 'draw' ? '抽取' : '编辑'}模式。`);
}
function closeScene() {
  const scene = state.scenes.pop();
  render(scene?.returnSelector);
  announce('已返回，当前选择保持原样。');
}
function closeAll() {
  const first = state.scenes[0]; state.scenes = []; render(first?.returnSelector);
}
function replaceTop(scene) {state.scenes[state.scenes.length - 1] = scene;}

root.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled || control.closest('[inert]')) return;
  if ((state.scenes.length || state.archive) && !scope().contains(control)) return;
  const action = control.dataset.action;
  const scene = top();
  switch (action) {
    case 'navigate': state.view = control.dataset.view; state.filter = 'all'; render(`[data-view="${state.view}"]`); break;
    case 'filter': state.filter = control.dataset.filter; render(`[data-filter="${state.filter}"]`); break;
    case 'open-pool': enter(control.dataset.pool, {returnSelector: `[data-action="open-pool"][data-pool="${control.dataset.pool}"]`}); break;
    case 'close-scene': closeScene(); break;
    case 'close-all': closeAll(); break;
    case 'scene-mode': {
      const pool = state.pools[scene.poolId];
      replaceTop({...openScene(pool, control.dataset.mode), returnSelector: scene.returnSelector, angle: scene.angle});
      render(`[data-mode="${control.dataset.mode}"]`); announce('模式已切换，本次进入重新洗位置。'); break;
    }
    case 'pick': {
      const id = control.dataset.cardId;
      if (state.pools[scene.poolId].children) {enter(id, {returnSelector: `[data-card-id="${id}"]`}); break;}
      const cardRect = control.getBoundingClientRect(), stageRect = control.closest('.scene-stage').getBoundingClientRect();
      const frontOrigin = {x: cardRect.x + cardRect.width / 2 - stageRect.x - stageRect.width / 2, y: cardRect.y + cardRect.height / 2 - stageRect.y - stageRect.height / 2, scale: cardRect.width / 164};
      replaceTop({...selectCard(scene, id), frontOrigin}); render(scene.mode === 'draw' ? '.front-card' : '[data-action="return-card"]');
      announce(scene.mode === 'draw' ? '已前置同一张卡，球面暂停。再次点击翻开。' : '已打开原卡，球面暂停。'); break;
    }
    case 'reveal': replaceTop(revealCard(scene, control.dataset.cardId)); render('[data-action="return-card"]'); announce('已翻开选中的同一张卡。'); break;
    case 'return-card': {const id = scene.selectedId; replaceTop(returnCard(scene)); render(`[data-card-id="${id}"]`); announce('卡片已归位。'); break;}
    case 'toggle-display': top().display = isList() ? 'sphere' : 'list'; if (narrow.matches && top().display === 'sphere') top().still = true; render('[data-action="toggle-display"]'); break;
    case 'toggle-still': if (!reduced.matches) {state.still = !isStill(); delete top().still;} render('[data-action="toggle-still"]'); break;
    case 'slot-sphere': enter('books', {mode: 'draw', display: 'sphere', slotTarget: state.scenes.length - 1, returnSelector: '[data-action="slot-sphere"]'}); break;
    case 'use-book': {
      const book = cardIn(scene), parent = state.scenes[scene.slotTarget];
      parent.slots.book = book.id; parent.feedback = `已填入《${book.title}》。`;
      state.scenes.pop(); render('[data-action="slot-sphere"]'); announce(parent.feedback); break;
    }
    case 'accept': {
      const card = cardIn(scene), book = bookById(scene.slots.book);
      if (!card || card.kind !== 'action' || (card.slot && !book)) break;
      state.hand.push({id: `sample-hand-${state.hand.length + 1}`, cardId: card.id, bookId: book?.id, title: composedTitle(card, book), minutes: card.minutes, sourceDate: '2026-10-04'});
      scene.accepted = true; scene.feedback = `样稿手牌增加了 1 份，共 ${state.hand.length} 份。`;
      render('[data-action="accept"]'); announce(scene.feedback); break;
    }
    case 'view-hand': state.scenes = []; state.view = 'drawing'; render(); root.querySelector('#hand-title')?.focus(); break;
    case 'archive': state.archive = true; render('[data-action="close-archive"]'); break;
    case 'close-archive': state.archive = false; render('[data-action="archive"]'); break;
  }
});

root.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'display') {state.display = target.value; render('#display');}
  if (target.id === 'still') {state.still = target.checked; render('#still');}
  if (target.id === 'count') {
    state.count = Number(target.value); state.pools = fixtures(state.count); state.scenes = []; state.hand = [];
    render('#count'); announce('已切换合成样本密度，样稿回到初始状态。');
  }
  if (target.id === 'book-choice') {
    const books = state.pools.books.cards;
    const book = target.value === 'random' ? books[Math.floor(Math.random() * books.length)] : bookById(target.value);
    if (!book) return;
    top().slots.book = book.id; top().feedback = `已填入《${book.title}》。`;
    render('#book-choice'); announce(top().feedback);
  }
});

root.addEventListener('submit', event => {
  if (event.target.id !== 'edit-form') return;
  event.preventDefault(); const form = event.target;
  if (!form.reportValidity()) return;
  const fields = new FormData(form), card = cardIn(top());
  const title = String(fields.get('title')).trim();
  if (!title) {form.elements.title.setCustomValidity('请填写名称。'); form.reportValidity(); form.elements.title.setCustomValidity(''); return;}
  if (card.slot && !title.includes('{书名}')) {top().feedback = '这个组合样例请保留 {书名} 预留位；模板编辑由 A2 推进。'; render(); return;}
  card.title = title;
  if (card.kind === 'book') card.author = String(fields.get('author')).trim();
  else {card.minutes = Number(fields.get('minutes')); card.criterion = String(fields.get('criterion')).trim();}
  top().feedback = '样稿修改已保留，仅在当前页面有效。'; render('input[name="title"]'); announce(top().feedback);
});

document.addEventListener('keydown', event => {
  if (!state.scenes.length && !state.archive) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (state.archive) {state.archive = false; render('[data-action="archive"]');}
    else if (top().phase !== 'candidate') {const id = top().selectedId; replaceTop(returnCard(top())); render(`[data-card-id="${id}"]`);}
    else closeScene();
  }
  if (event.key === 'Tab') {
    const nodes = focusables(scope());
    const index = nodes.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) {event.preventDefault(); nodes.at(-1)?.focus();}
    else if (!event.shiftKey && (index === -1 || index === nodes.length - 1)) {event.preventDefault(); nodes[0]?.focus();}
  }
});

function positionSpheres() {
  root.querySelectorAll('.sphere-surface').forEach(surface => {
    const scene = state.scenes[Number(surface.closest('[data-scene-index]').dataset.sceneIndex)];
    const stage = surface.parentElement;
    const radiusX = Math.max(90, Math.min(245, stage.clientWidth * 0.32));
    const radiusY = Math.max(90, Math.min(150, stage.clientHeight * 0.30));
    const cards = surface.querySelectorAll('.orbit-card');
    const points = spherePoints(cards.length);
    cards.forEach((card, i) => {
      const point = points[i];
      const x = point.x * Math.cos(scene.angle) + point.z * Math.sin(scene.angle);
      const z = point.z * Math.cos(scene.angle) - point.x * Math.sin(scene.angle);
      const scale = 0.66 + (z + 1) * 0.20;
      card.style.transform = `translate(-50%, -50%) translate3d(${x * radiusX}px, ${point.y * radiusY}px, 0) scale(${scale})`;
      card.style.zIndex = String(Math.round((z + 1) * 100) + 1);
      card.style.opacity = String(0.50 + (z + 1) * 0.25);
      card.style.visibility = scene.selectedId === card.dataset.cardId ? 'hidden' : 'visible';
    });
  });
}

let previous = 0;
function frame(now) {
  const elapsed = previous ? Math.min((now - previous) / 1000, 0.05) : 0; previous = now;
  const scene = top();
  if (scene && motion().sphere === 'running' && !isList() && !document.hidden) {
    scene.angle += elapsed * motion().speed;
    positionSpheres();
  }
  requestAnimationFrame(frame);
}
reduced.addEventListener('change', () => render());
narrow.addEventListener('change', () => render());
window.addEventListener('resize', positionSpheres);
render(); requestAnimationFrame(frame);
