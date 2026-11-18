(function () {
  'use strict';

  /* ---------------- 数据：17 个音及对应手柄键位 ---------------- */
  const NOTES = [
    { midi: 72, name: 'C5',  keys: ['摇杆下+L'] },
    { midi: 73, name: 'C#5', keys: ['下+L'] },
    { midi: 74, name: 'D5',  keys: ['L'] },
    { midi: 75, name: 'D#5', keys: ['上+L', '摇杆下+R'] },
    { midi: 76, name: 'E5',  keys: ['下+R', '摇杆上+L'] },
    { midi: 77, name: 'F5',  keys: ['R'] },
    { midi: 78, name: 'F#5', keys: ['上+R'] },
    { midi: 79, name: 'G5',  keys: ['摇杆上+R', '摇杆下+A'] },
    { midi: 80, name: 'G#5', keys: ['下+A'] },
    { midi: 81, name: 'A5',  keys: ['A', '摇杆下+Y'] },
    { midi: 82, name: 'A#5', keys: ['上+A', '下+Y'] },
    { midi: 83, name: 'B5',  keys: ['Y', '摇杆上+A'] },
    { midi: 84, name: 'C6',  keys: ['上+Y', '摇杆下+X'] },
    { midi: 85, name: 'C#6', keys: ['下+X', '摇杆上+Y'] },
    { midi: 86, name: 'D6',  keys: ['X'] },
    { midi: 87, name: 'D#6', keys: ['上+X'] },
    { midi: 88, name: 'E6',  keys: ['摇杆上+X'] }
  ];

  const byMidi = new Map(NOTES.map(n => [n.midi, n]));
  const ROWS = NOTES.slice().reverse();          // 显示顺序：高音在上
  const ROW_H = 26;
  const COLS_UNIT = 16;                          // 初始 / 每次扩展的列数
  const MAX_HOLD_MS = 6000;                      // 游戏内单次按键最长 6 秒
  // 固件每条 NOTE 的固定开销（实测：静默 64ms 时约 82ms），只从命令按住里扣，时间轴仍按原长度推进
  const HOLD_COMPENSATION_MS = 82;
  // 林克连续发声上限 6 秒，到点必须换气；实测换气 <200ms 就能再按
  const BREATH_LIMIT_MS = 6000;
  const BREATH_GAP_MS = 200;
  const MIN_HOLD_MS = 20;
  const TOTAL_H = ROWS.length * ROW_H;

  const $ = id => document.getElementById(id);
  const keysEl = $('keys');
  const rollEl = $('roll');
  const inner = $('rollInner');
  const rulerEl = $('ruler');
  const listEl = $('list');
  const countEl = $('count');
  const tipEl = $('emptyTip');
  const colTag = $('colTag');
  const toastEl = $('toast');
  const cmdEl = $('cmdview');
  const tbInfoEl = $('tbInfo');

  /* ---------------- 状态 ---------------- */
  let notes = [];               // { id, midi, col, mapping }
  let breaks = [];              // 断句：{ col, midi }，Ctrl+左键 添加/取消
  let cols = COLS_UNIT;         // 当前列数
  let colW = 52;                // 单格宽度（按可视宽度自适应）
  let bpm = 120;                // 每分钟四分音符数
  let gridFactor = 8;           // 每格 = 几分音符（4/8/16/32）
  let defaultLen = 1;           // 新音符默认长度（格）
  let panelTab = 'keys';        // keys | cmd
  let playStart = 0;            // 试听起点（列下标，0 起）
  let uid = 1;
  let choice = new Map();       // midi -> 选中的按法下标
  const undoStack = [];
  let soundOn = true;

  const isBlack = name => name.indexOf('#') > -1;
  const shortMap = m => m.replace('摇杆下', '⇊').replace('摇杆上', '⇈').replace('下', '↓').replace('上', '↑').replace('+', '');
  const currentMapping = n => n.keys[choice.get(n.midi) || 0] || n.keys[0];
  const sortedNotes = () => notes.slice().sort((a, b) => (a.col - b.col) || (a.id - b.id));

  /* ---------------- 时间与命令 ---------------- */
  const stepMs = () => (60000 / bpm) * (4 / gridFactor);
  const maxLenCells = () => Math.max(1, Math.floor(MAX_HOLD_MS / stepMs()));
  const noteHoldMs = len => Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, Math.round(len * stepMs())));

  // "摇杆下+L" → { button:'L', stick:-2 }
  function keyToCmd(label) {
    const s = String(label);
    if (s.indexOf('摇杆下+') === 0) return { button: s.slice(4), stick: -2 };
    if (s.indexOf('摇杆上+') === 0) return { button: s.slice(4), stick: 2 };
    if (s.indexOf('下+') === 0) return { button: s.slice(2), stick: -1 };
    if (s.indexOf('上+') === 0) return { button: s.slice(2), stick: 1 };
    return { button: s, stick: 0 };
  }

  function buildCommands() {
    const ordered = sortedNotes();
    const step = stepMs();
    const out = [];
    let cursor = 0;
    let shift = 0;          // 换气插入导致的时间顺延
    let continuous = 0;     // 自上次换气以来的连续发声时长
    let breaths = 0;
    let lastOnset = 0;
    let lastHold = 0;
    ordered.forEach((n, i) => {
      const naturalOnset = n.col * step;
      const nextNatural = i + 1 < ordered.length ? ordered[i + 1].col * step : null;
      // 按住时长 = 拉的格子长度（上限 6s，且不会盖住下一个音）
      let musical = noteHoldMs(n.len || 1);
      if (nextNatural !== null) musical = Math.min(musical, Math.max(MIN_HOLD_MS, Math.round(nextNatural - naturalOnset)));

      let onset = naturalOnset + shift;
      // 连续发声快到 6 秒上限时，先给林克留一段换气
      if (continuous > 0 && continuous + musical > BREATH_LIMIT_MS) {
        shift += BREATH_GAP_MS;
        onset += BREATH_GAP_MS;
        continuous = 0;
        breaths += 1;
      }
      // 谱面本身的空隙够长，也视为换过气
      if (onset - cursor >= BREATH_GAP_MS) continuous = 0;

      const hold = Math.max(10, musical - HOLD_COMPENSATION_MS);
      const gap = Math.round(onset - cursor);
      if (gap > 0) out.push({ type: 'wait', text: gap + 'ms' });
      const c = keyToCmd(n.mapping);
      out.push({ type: 'note', text: 'NOTE ' + c.button + ' ' + c.stick + ' ' + hold });
      cursor = onset + musical;
      continuous += musical;
      lastOnset = onset;
      lastHold = musical;
    });
    return { lines: out, step: step, duration: ordered.length ? lastOnset + lastHold : 0, breaths: breaths };
  }

  function fmtSec(ms) {
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
  }

  function renderCmd() {
    const built = buildCommands();
    const sorted = sortedNotes();
    if (!sorted.length) {
      cmdEl.innerHTML = '<span class="c"># 还没有音符\n# 在钢琴卷格子上点一下开始</span>';
      if (tbInfoEl) tbInfoEl.textContent = '每格 ' + Math.round(built.step) + 'ms';
      return;
    }
    const head = '<span class="c"># ' + bpm + ' BPM · 每格 1/' + gridFactor + ' 音符 = ' + Math.round(built.step) +
      'ms · 单音最长 ' + fmtSec(MAX_HOLD_MS) + ' · 全长 ' + fmtSec(built.duration) + '</span>\n';
    const body = built.lines.map(l => l.type === 'wait'
      ? '<span class="w">' + l.text + '</span>'
      : l.text).join('\n');
    cmdEl.innerHTML = head + body;
  }

  /* ---------------- 声音 ---------------- */
  let ac = null;
  function ensureAC() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(midi, durSec) {
    if (!soundOn) return;
    try {
      const ctx = ensureAC();
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const t0 = ctx.currentTime + 0.01;
      const dur = Math.max(0.08, Math.min(1.2, durSec || 0.9));

      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, t0);
      out.gain.exponentialRampToValueAtTime(0.2, t0 + 0.035);
      out.gain.exponentialRampToValueAtTime(0.1, t0 + 0.25);
      out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(6500, f * 6);
      lp.Q.value = 0.5;
      out.connect(lp);
      lp.connect(ctx.destination);

      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = f;

      const o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = f * 2;
      const g2 = ctx.createGain();
      g2.gain.value = 0.14;

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.2;
      const lfoG = ctx.createGain();
      lfoG.gain.value = f * 0.0042;
      lfo.connect(lfoG);
      lfoG.connect(o1.frequency);

      o1.connect(out);
      o2.connect(g2);
      g2.connect(out);
      [o1, o2, lfo].forEach(o => { o.start(t0); o.stop(t0 + dur + 0.05); });
    } catch (e) { /* 忽略音频异常 */ }
  }

  /* ---------------- 构建琴键 ---------------- */
  const keyEls = new Map();
  ROWS.forEach(n => {
    const el = document.createElement('div');
    el.className = 'key ' + (isBlack(n.name) ? 'black' : 'white');
    el.dataset.midi = n.midi;

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = n.name;

    const kp = document.createElement('span');
    kp.className = 'kp';
    kp.textContent = n.keys[0];

    el.appendChild(nm);
    el.appendChild(kp);

    if (n.keys.length > 1) {
      const d = document.createElement('span');
      d.className = 'dual';
      d.textContent = '2';
      d.title = '有两种按法：' + n.keys.join(' / ');
      el.appendChild(d);
    }

    el.title = '单击试听 ' + n.name;
    el.addEventListener('click', () => previewNote(n.midi));
    keysEl.appendChild(el);
    keyEls.set(n.midi, el);
  });

  /* ---------------- 卷背景 ---------------- */
  ROWS.forEach((n, i) => {
    if (isBlack(n.name)) {
      const b = document.createElement('div');
      b.className = 'band';
      b.style.top = (i * ROW_H) + 'px';
      b.style.height = ROW_H + 'px';
      inner.appendChild(b);
    }
  });

  function applyGrid() {
    // 每 1/4 拍画一条红线（每格 16 分时 = 4 格一条）
    const beatCells = Math.max(1, gridFactor / 4);
    const beatW = beatCells * colW;
    inner.style.backgroundImage =
      'repeating-linear-gradient(to right, transparent 0 ' + (beatW - 1) + 'px, rgba(232,196,106,.45) ' + (beatW - 1) + 'px ' + beatW + 'px),' +
      'repeating-linear-gradient(to right, transparent 0 ' + (colW - 1) + 'px, rgba(255,255,255,.065) ' + (colW - 1) + 'px ' + colW + 'px),' +
      'repeating-linear-gradient(to bottom, transparent 0 ' + (ROW_H - 1) + 'px, rgba(255,255,255,.05) ' + (ROW_H - 1) + 'px ' + ROW_H + 'px)';
  }

  function computeColW() {
    // 让初始 16 格正好铺满可视宽度；窗口太宽时限制最大格宽，避免块过大
    const w = (rollEl.clientWidth || 880) - 2;
    const raw = Math.min(84, Math.max(44, w / COLS_UNIT));
    colW = Math.round(raw * 100) / 100;
  }

  /* 试听起点指示条 */
  const cursorBand = document.createElement('div');
  cursorBand.className = 'cursorBand';
  inner.appendChild(cursorBand);

  /* 悬停预览块 */
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.style.height = (ROW_H - 5) + 'px';
  inner.appendChild(ghost);

  /* ---------------- 核心操作 ---------------- */
  function snapshot() {
    undoStack.push({
      notes: notes.map(n => ({ id: n.id, midi: n.midi, col: n.col, len: n.len, mapping: n.mapping })),
      breaks: breaks.map(b => ({ col: b.col, midi: b.midi })),
      cols: cols
    });
    if (undoStack.length > 120) undoStack.shift();
  }

  function previewNote(midi) {
    tone(midi);
    flashKey(midi);
  }

  function addAt(midi, col) {
    if (col < 0 || col >= cols) return false;
    if (notes.some(n => n.midi === midi && n.col === col)) {   // 这一格已有音符
      tone(midi);
      return false;
    }
    snapshot();
    const id = uid++;
    const len = Math.min(Math.max(1, defaultLen), maxLenCells());
    notes.push({ id: id, midi: midi, col: col, len: len, mapping: currentMapping(byMidi.get(midi)) });
    if (col === cols - 1) {                                    // 写在第 16 列 → 再生成 16 格
      cols += COLS_UNIT;
      toast('已扩展到 ' + cols + ' 格');
    }
    tone(midi);
    flashKey(midi);
    render({ popId: id });
    revealCol(col);
    return true;
  }

  function selectCol(col) {
    playStart = Math.max(0, Math.min(col, cols - 1));
    render();
  }

  function flashKey(midi) {
    const el = keyEls.get(midi);
    if (!el) return;
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 170);
  }

  function removeById(id) {
    const i = notes.findIndex(n => n.id === id);
    if (i < 0) return;
    snapshot();
    notes.splice(i, 1);
    render();
  }

  // 断句：同一列只保留一个；再按一次取消
  function toggleBreak(col, midi) {
    const i = breaks.findIndex(b => b.col === col);
    snapshot();
    if (i >= 0) {
      breaks.splice(i, 1);
      toast('已取消第 ' + (col + 1) + ' 格的断句');
    } else {
      breaks.push({ col: col, midi: midi });
      toast('第 ' + (col + 1) + ' 格断开（仅按键谱从这里换句）');
    }
    render();
  }

  function toggleMapping(id) {
    const s = notes.find(x => x.id === id);
    if (!s) return;
    const n = byMidi.get(s.midi);
    if (n.keys.length < 2) return;
    const next = n.keys.find(k => k !== s.mapping) || n.keys[0];
    snapshot();
    s.mapping = next;
    choice.set(s.midi, n.keys.indexOf(next));
    render();
  }

  function revealCol(col) {
    requestAnimationFrame(() => {
      const x = col * colW;
      const left = rollEl.scrollLeft;
      const right = left + rollEl.clientWidth;
      if (x + colW > right) rollEl.scrollLeft = x + colW - rollEl.clientWidth + 10;
      else if (x < left) rollEl.scrollLeft = Math.max(0, x - 10);
    });
  }

  /* ---------------- 渲染 ---------------- */
  function render(opts) {
    opts = opts || {};
    const prevScroll = listEl.scrollTop;

    // 琴键上的当前按法
    ROWS.forEach(n => {
      const el = keyEls.get(n.midi);
      if (el) el.querySelector('.kp').textContent = currentMapping(n);
    });

    applyGrid();

    if (playStart >= cols) playStart = Math.max(0, cols - 1);
    if (playStart < 0) playStart = 0;

    // 列号标尺
    rulerEl.innerHTML = '';
    for (let c = 0; c < cols; c++) {
      const t = document.createElement('div');
      t.className = 'tick' + ((c + 1) % 4 === 0 ? ' beat' : '') + (c === playStart ? ' cur' : '');
      t.style.left = (c * colW) + 'px';
      t.style.width = colW + 'px';
      t.textContent = c + 1;
      t.title = '选中第 ' + (c + 1) + ' 列，试听从这里开始';
      t.addEventListener('click', () => selectCol(c));
      rulerEl.appendChild(t);
    }
    rulerEl.style.width = (cols * colW) + 'px';

    // 试听起点竖条
    cursorBand.style.left = (playStart * colW) + 'px';
    cursorBand.style.width = colW + 'px';
    cursorBand.classList.add('on');

    // 钢琴卷：按格子坐标落块
    Array.prototype.forEach.call(inner.querySelectorAll('.blk'), el => el.remove());
    const ordered = sortedNotes();
    ordered.forEach((s, i) => {
      const n = byMidi.get(s.midi);
      const row = ROWS.indexOf(n);
      const b = document.createElement('div');
      b.className = 'blk' + (s.id === opts.popId ? ' pop' : '');
      b.dataset.i = i;
      b.dataset.id = s.id;
      b.dataset.len = s.len || 1;
      b.style.left = (s.col * colW + 2) + 'px';
      b.style.top = (row * ROW_H + 3) + 'px';
      b.style.width = Math.max(8, (s.len || 1) * colW - 6) + 'px';
      b.style.height = (ROW_H - 5) + 'px';
      const h = 190 - (s.midi - 72) * 9;
      b.style.background = 'linear-gradient(180deg,hsl(' + h + ',72%,66%),hsl(' + h + ',62%,48%))';
      b.title = '第 ' + (s.col + 1) + ' 格 · ' + n.name + ' · ' + s.mapping +
        ' · 长 ' + (s.len || 1) + ' 格(' + noteHoldMs(s.len || 1) + 'ms)' + '（拖右边缘改长短，右键删除）';
      b.innerHTML = '<span>' + n.name + '</span><span class="t">' + shortMap(s.mapping) + '</span>';
      b.addEventListener('click', () => {
        if (suppressClick) return;
        tone(s.midi);
        flashKey(s.midi);
      });
      b.addEventListener('contextmenu', ev => { ev.preventDefault(); removeById(s.id); });
      inner.appendChild(b);
    });

    // 断句方块（白色小方块，标记这句话在这里断开）
    Array.prototype.forEach.call(inner.querySelectorAll('.brk'), el => el.remove());
    breaks.forEach(b => {
      const n = byMidi.get(b.midi);
      const row = n ? ROWS.indexOf(n) : -1;
      if (row < 0) return;
      const el = document.createElement('div');
      el.className = 'brk';
      el.style.left = (b.col * colW + 2) + 'px';
      el.style.top = (row * ROW_H + 3) + 'px';
      el.style.width = Math.max(8, colW - 6) + 'px';
      el.style.height = (ROW_H - 5) + 'px';
      el.title = '第 ' + (b.col + 1) + ' 格断句 · Ctrl+左键 取消';
      inner.appendChild(el);
    });

    inner.style.width = (cols * colW) + 'px';
    tipEl.style.display = notes.length ? 'none' : '';
    updatePlayLabel();

    // 输出面板（按格子从左到右排）
    countEl.textContent = notes.length + ' 个音';
    colTag.textContent = cols + ' 格 · 左键写 · 右键删 · 滚轮左右滚';
    if (!ordered.length) {
      listEl.innerHTML = '<div class="listEmpty">还没有音符<br /><span>在钢琴卷格子上点一下</span></div>';
    } else {
      listEl.innerHTML = ordered.map((s, i) => {
        const n = byMidi.get(s.midi);
        const dual = n.keys.length > 1;
        const other = dual ? n.keys.filter(k => k !== s.mapping).join(' / ') : '';
        return '<div class="item" data-id="' + s.id + '">' +
          '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' +
          '<span class="nm">' + n.name + '</span>' +
          '<button class="mapBtn' + (dual ? ' dual' : '') + '" data-act="map" title="' +
            (dual ? '点击切换另一种按法：' + other : '该音只有一种按法') + '">' +
            s.mapping + (dual ? '<i>⇄</i>' : '') +
          '</button>' +
          '<button class="del" data-act="del" title="删除这个音">×</button>' +
        '</div>';
      }).join('');
      listEl.scrollTop = prevScroll;
    }

    // 命令视图与节奏信息
    renderCmd();
    const step = stepMs();
    const total = notes.length ? (Math.max.apply(null, notes.map(n => n.col)) + 1) * step : 0;
    tbInfoEl.textContent = '每格 ' + Math.round(step) + 'ms · ' +
      (notes.length ? '全长 ' + fmtSec(total) : '未写音符');
  }

  /* ---------------- 钢琴卷交互 ---------------- */
  function cellAt(e) {
    const r = inner.getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left) / colW);
    const row = Math.floor((e.clientY - r.top) / ROW_H);
    if (row < 0 || row >= ROWS.length || col < 0 || col >= cols) return null;
    return { row: row, col: col };
  }

  inner.addEventListener('mousemove', e => {
    if (e.target.closest('.blk')) { ghost.classList.remove('on'); return; }
    const c = cellAt(e);
    if (!c) { ghost.classList.remove('on'); return; }
    ghost.style.left = (c.col * colW + 2) + 'px';
    ghost.style.top = (c.row * ROW_H + 3) + 'px';
    ghost.style.width = Math.max(8, defaultLen * colW - 6) + 'px';
    ghost.classList.add('on');
  });

  inner.addEventListener('mouseleave', () => ghost.classList.remove('on'));

  /* ---------------- 拖动右边缘改音长 ---------------- */
  let drag = null;
  let suppressClick = false;

  function onDragMove(e) {
    if (!drag) return;
    const deltaCells = Math.round((e.clientX - drag.startX) / colW);
    const next = Math.max(1, Math.min(drag.startLen + deltaCells, maxLenCells()));
    if (next === drag.len) return;
    drag.len = next;
    const s = notes.find(n => n.id === drag.id);
    if (!s) return;
    s.len = next;
    const blk = inner.querySelector('.blk[data-id="' + s.id + '"]');
    if (blk) {
      blk.style.width = Math.max(8, next * colW - 6) + 'px';
      blk.dataset.len = next;
    }
    renderCmd();
  }

  function onDragEnd() {
    if (!drag) return;
    drag = null;
    suppressClick = true;
    window.setTimeout(() => { suppressClick = false; }, 60);
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    render();
  }

  inner.addEventListener('mousedown', e => {
    const blk = e.target.closest('.blk');
    if (!blk) return;
    const rect = blk.getBoundingClientRect();
    if (e.clientX < rect.right - 7) return;      // 只有右边缘 7px 才拖动
    const s = notes.find(n => n.id === Number(blk.dataset.id));
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    snapshot();
    drag = { id: s.id, startX: e.clientX, startLen: s.len || 1, len: s.len || 1 };
    document.body.style.cursor = 'ew-resize';
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  });

  inner.addEventListener('click', e => {
    // Ctrl / ⌘ + 左键：在任意音高上加断句（不会写音符，也不影响演奏）
    if (e.ctrlKey || e.metaKey) {
      const c = cellAt(e);
      if (c) toggleBreak(c.col, ROWS[c.row].midi);
      return;
    }
    if (e.target.closest('.blk')) return;          // 音符块自己处理
    const c = cellAt(e);
    if (!c) return;
    addAt(ROWS[c.row].midi, c.col);                // 只写音符，不改选中列
    ghost.classList.remove('on');
  });

  // 卷内右键：有断句就取消断句（优先），否则交给音符块自己删音符
  inner.addEventListener('contextmenu', e => {
    const c = cellAt(e);
    if (c) {
      const i = breaks.findIndex(b => b.col === c.col);
      if (i >= 0) {
        e.preventDefault();
        e.stopPropagation();
        snapshot();
        breaks.splice(i, 1);
        render();
        toast('已取消第 ' + (c.col + 1) + ' 格的断句');
        return;
      }
    }
    e.preventDefault();
  }, true);

  // 滚轮：上下滚 → 左右滚；滚到两端时把滚动交还给页面
  rollEl.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) return;                        // 保留 Ctrl+滚轮 缩放
    const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? rollEl.clientWidth : 1);
    const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!raw) return;
    const before = rollEl.scrollLeft;
    rollEl.scrollLeft = before + raw * unit;
    if (rollEl.scrollLeft !== before) e.preventDefault();
  }, { passive: false });

  /* ---------------- 面板交互 ---------------- */
  listEl.addEventListener('click', e => {
    const item = e.target.closest('.item');
    if (!item) return;
    const id = Number(item.dataset.id);
    if (e.target.closest('.del')) { removeById(id); return; }
    if (e.target.closest('.mapBtn')) { toggleMapping(id); return; }
    // 点击条目本身也定位/闪烁一下对应琴键
    const s = notes.find(x => x.id === id);
    if (s) flashKey(s.midi);
  });

  /* ---------------- 工具栏 ---------------- */
  $('btnSound').addEventListener('click', function () {
    soundOn = !soundOn;
    this.classList.toggle('on', soundOn);
    this.textContent = soundOn ? '🔊 声音' : '🔇 静音';
    if (soundOn) tone(81);
  });

  $('btnUndo').addEventListener('click', () => {
    if (!undoStack.length) { toast('没有可撤销的操作'); return; }
    const st = undoStack.pop();
    notes = st.notes;
    if (Array.isArray(st.breaks)) breaks = st.breaks;
    cols = st.cols;
    render();
  });

  $('btnClear').addEventListener('click', () => {
    if (!notes.length && !breaks.length) { toast('已经是空的了'); return; }
    stopPlay();
    snapshot();
    notes = [];
    breaks = [];
    cols = COLS_UNIT;
    playStart = 0;
    render();
  });

  $('btnCopy').addEventListener('click', () => {
    if (!notes.length) { toast('还没有音符'); return; }
    const ordered = sortedNotes();
    const text = ordered.map(s => s.mapping + ((s.len || 1) > 1 ? '×' + s.len : '')).join(' → ');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制 ' + ordered.length + ' 个键位'),
        () => fallbackCopy(text, ordered.length)
      );
    } else {
      fallbackCopy(text, ordered.length);
    }
  });

  function fallbackCopy(text, n) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制 ' + n + ' 个键位'); }
    catch (e) { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }

  /* ---------------- 节奏控制 ---------------- */
  const bpmEl = $('bpm');
  const gridEl = $('grid');
  const lenEl = $('lenSel');

  function syncTimingInputs() {
    bpmEl.value = bpm;
    gridEl.value = String(gridFactor);
    if (lenEl) lenEl.value = String(defaultLen);
  }

  function applyTiming() {
    const b = parseInt(bpmEl.value, 10);
    if (isFinite(b) && b >= 30 && b <= 300) bpm = b;
    gridFactor = parseInt(gridEl.value, 10) || 16;
    defaultLen = parseInt(lenEl.value, 10) || 1;
    render();
  }

  bpmEl.addEventListener('input', applyTiming);
  bpmEl.addEventListener('change', applyTiming);
  gridEl.addEventListener('change', applyTiming);
  if (lenEl) lenEl.addEventListener('change', applyTiming);

  $('panelTabs').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    panelTab = btn.dataset.tab;
    Array.prototype.forEach.call(document.querySelectorAll('#panelTabs .seg-btn'),
      b => b.classList.toggle('on', b === btn));
    listEl.hidden = panelTab !== 'keys';
    cmdEl.hidden = panelTab !== 'cmd';
  });

  $('btnCopyCmd').addEventListener('click', () => {
    const built = buildCommands();
    if (!built.lines.length) { toast('还没有音符'); return; }
    const text = built.lines.map(l => l.text).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制 ' + built.lines.length + ' 行命令'),
        () => fallbackCopy(text, built.lines.length)
      );
    } else {
      fallbackCopy(text, built.lines.length);
    }
  });

  /* ---------------- 试听 ---------------- */
  let playTimers = [];
  let playing = false;

  function updatePlayLabel() {
    const btn = $('btnPlay');
    if (playing) return;
    if (playStart > 0) {
      btn.textContent = '▶ 从第 ' + (playStart + 1) + ' 列试听';
      btn.title = '从第 ' + (playStart + 1) + ' 列开始播放';
    } else {
      btn.textContent = '▶ 试听';
      btn.title = '从头播放';
    }
  }

  function stopPlay() {
    playTimers.forEach(clearTimeout);
    playTimers = [];
    playing = false;
    document.querySelectorAll('.blk.playing').forEach(el => el.classList.remove('playing'));
    updatePlayLabel();
  }

  // 回到第 1 列（从头试听）
  function goHome() {
    if (playing) stopPlay();
    playStart = 0;
    render();
    rollEl.scrollLeft = 0;
  }

  $('btnHome').addEventListener('click', goHome);

  document.addEventListener('keydown', e => {
    if (e.key !== 'Home') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (modal.classList.contains('on')) return;
    e.preventDefault();
    goHome();
  });

  $('btnPlay').addEventListener('click', () => {
    if (playing) { stopPlay(); return; }
    if (!notes.length) { toast('还没有音符'); return; }
    const list = sortedNotes().filter(n => n.col >= playStart);
    if (!list.length) { toast('第 ' + (playStart + 1) + ' 列起没有音符'); return; }

    const step = stepMs();
    const t0 = playStart * step;
    playing = true;
    $('btnPlay').textContent = '■ 停止';

    list.forEach(n => {
      const delay = Math.max(0, n.col * step - t0);
      playTimers.push(setTimeout(() => {
        tone(n.midi, Math.max(0.15, noteHoldMs(n.len || 1) / 1000));
        flashKey(n.midi);
        document.querySelectorAll('.blk.playing').forEach(el => el.classList.remove('playing'));
        const blk = inner.querySelector('.blk[data-id="' + n.id + '"]');
        if (blk) {
          blk.classList.add('playing');
          if (rollEl.scrollWidth > rollEl.clientWidth) {
            const x = blk.offsetLeft;
            rollEl.scrollTo({ left: Math.max(0, x - rollEl.clientWidth / 2), behavior: 'smooth' });
          }
        }
      }, delay));
    });

    const endAt = (list[list.length - 1].col * step + noteHoldMs(list[list.length - 1].len || 1)) - t0;
    playTimers.push(setTimeout(stopPlay, endAt + 250));
  });

  /* ---------------- 粘贴 / 导入 / 导出 ---------------- */
  const MAP_TO_MIDI = new Map();
  const NAME_TO_MIDI = new Map();
  NOTES.forEach(n => {
    n.keys.forEach(k => MAP_TO_MIDI.set(k, n.midi));
    NAME_TO_MIDI.set(n.name.toUpperCase(), n.midi);
  });

  function dedupe(list) {
    const seen = Object.create(null), out = [];
    list.forEach(p => {
      const k = p.midi + ':' + p.col;
      if (seen[k]) return;
      seen[k] = 1;
      out.push(p);
    });
    return out;
  }

  function parseSequence(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return { ok: false, error: '还没有内容' };

    // ① JSON（导出的文件）
    if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { return { ok: false, error: 'JSON 解析失败，检查一下括号和引号' }; }
      const list = Array.isArray(obj) ? obj : (obj && obj.notes);
      if (!Array.isArray(list)) return { ok: false, error: 'JSON 里没有 notes 数组' };
      const out = [];
      list.forEach(it => {
        const midi = Number(it && it.midi);
        const col = Number(it && it.col);
        if (!byMidi.has(midi) || !isFinite(col) || col < 0) return;
        const n = byMidi.get(midi);
        const keys = (it && typeof it.keys === 'string' && n.keys.indexOf(it.keys) >= 0) ? it.keys : currentMapping(n);
        out.push({ midi: midi, col: Math.floor(col), len: Math.max(1, Math.floor(Number(it && it.len) || 1)), mapping: keys });
      });
      if (!out.length) return { ok: false, error: 'JSON 里没有可用音符（音高需在 C5–E6 之间）' };
      const maxCol = Math.max.apply(null, out.map(o => o.col));
      const rawBreaks = Array.isArray(obj && obj.breaks) ? obj.breaks : [];
      const parsedBreaks = rawBreaks
        .filter(b => b && isFinite(Number(b.col)) && Number(b.col) >= 0)
        .map(b => ({ col: Math.floor(Number(b.col)), midi: Number(b.midi) || 81 }));

      return {
        ok: true, kind: 'json', notes: dedupe(out),
        cols: Math.max(COLS_UNIT, Number(obj && obj.cols) || 0, maxCol + 1),
        timing: (obj && obj.timing && typeof obj.timing === 'object') ? obj.timing : null,
        breaks: parsedBreaks
      };
    }

    // ② 文本：键位链 / 音名，用箭头、换行、空格、逗号、分号分隔
    const normalized = raw.replace(/\s*\+\s*/g, '+');
    const tokens = normalized.split(/→|⇒|->|=>|＞|>|\n|,|，|;|；|\||\s+/).filter(Boolean);
    if (!tokens.length) return { ok: false, error: '没有识别到内容' };
    const out = [], bad = [];
    tokens.forEach(t => {
      let word = t, len = 1;
      const m = /^(.*?)[×xX*](\d{1,3})$/.exec(t);
      if (m) { word = m[1]; len = Math.min(64, Math.max(1, parseInt(m[2], 10))); }
      let midi = MAP_TO_MIDI.get(word);
      if (midi === undefined) midi = NAME_TO_MIDI.get(word.toUpperCase());
      if (midi === undefined) { bad.push(t); return; }
      out.push({ midi: midi, col: out.length, len: len, mapping: currentMapping(byMidi.get(midi)) });
    });
    if (bad.length) {
      return { ok: false, error: '无法识别：' + bad.slice(0, 3).join('、') + (bad.length > 3 ? ' 等 ' + bad.length + ' 个' : '') };
    }
    return { ok: true, kind: 'text', notes: dedupe(out), cols: Math.max(COLS_UNIT, out.length) };
  }

  function applyImport(parsed, append) {
    snapshot();
    const base = (append && notes.length) ? Math.max.apply(null, notes.map(n => n.col)) + 1 : 0;
    const list = parsed.notes.map(p => ({
      id: uid++, midi: p.midi, col: p.col + base,
      len: Math.max(1, Math.min(p.len || 1, 512)),
      mapping: p.mapping
    }));
    notes = append ? notes.concat(list) : list;

    if (Array.isArray(parsed.breaks)) {
      const shifted = parsed.breaks.map(b => ({ col: b.col + base, midi: b.midi }));
      breaks = append
        ? breaks.concat(shifted.filter(b => !breaks.some(x => x.col === b.col)))
        : shifted;
    } else if (!append) {
      breaks = [];
    }

    const maxEnd = notes.length ? Math.max.apply(null, notes.map(n => n.col + (n.len || 1))) : 0;
    const need = Math.ceil(maxEnd / COLS_UNIT) * COLS_UNIT;
    let target = Math.max(COLS_UNIT, need);
    if (append) target = Math.max(target, cols);
    else if (parsed.cols) target = Math.max(target, Math.ceil(parsed.cols / COLS_UNIT) * COLS_UNIT);
    cols = target;
    playStart = 0;

    if (parsed.timing) {
      const t = parsed.timing;
      if (isFinite(t.bpm)) bpm = Math.min(300, Math.max(30, Number(t.bpm)));
      if ([4, 8, 16, 32].indexOf(Number(t.gridFactor)) >= 0) gridFactor = Number(t.gridFactor);
      if (isFinite(t.defaultLen)) defaultLen = Math.min(16, Math.max(1, Number(t.defaultLen)));
      syncTimingInputs();
    }

    render();
    if (maxEnd > 0) revealCol(Math.max(0, maxEnd - 1));

    // 如果此刻正停在「仅按键谱」页，导入后立刻同步
    const buttonsView = document.querySelector('.view[data-view="buttons"]');
    if (buttonsView && !buttonsView.hidden) renderKeys();
  }

  const modal = $('modal');
  const modalText = $('modalText');
  const modalInfo = $('modalInfo');
  const modalOk = $('modalOk');
  const modalAppend = $('modalAppend');
  const modalTitle = $('modalTitle');
  let pending = null;

  function updatePreview() {
    const parsed = parseSequence(modalText.value);
    pending = parsed.ok ? parsed : null;
    modalOk.disabled = !parsed.ok;
    modalOk.textContent = modalAppend.checked ? '导入并追加' : '导入并替换';

    if (!modalText.value.trim()) {
      modalInfo.className = 'modalInfo';
      modalInfo.textContent = '支持键位链（摇杆下+L → L → …）、音名（C5 D5 E5）或导出的 JSON 文件 · 打开后按 Ctrl+V 粘贴';
      return;
    }
    if (!parsed.ok) {
      modalInfo.className = 'modalInfo err';
      modalInfo.textContent = '✗ ' + parsed.error;
      return;
    }
    const span = Math.max.apply(null, parsed.notes.map(n => n.col)) + 1;
    modalInfo.className = 'modalInfo ok';
    modalInfo.textContent = '✓ 识别到 ' + parsed.notes.length + ' 个音，占用 ' + span + ' 格';
  }

  function openModal(text, title) {
    modalTitle.textContent = title || '粘贴序列';
    modalText.value = text || '';
    modalAppend.checked = false;
    modal.classList.add('on');
    updatePreview();
    setTimeout(() => modalText.focus(), 30);
  }

  function closeModal() {
    modal.classList.remove('on');
    pending = null;
  }

  modalText.addEventListener('input', updatePreview);
  modalAppend.addEventListener('change', updatePreview);
  $('modalClose').addEventListener('click', closeModal);
  $('modalCancel').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  document.addEventListener('keydown', e => {
    if (!modal.classList.contains('on')) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !modalOk.disabled) { e.preventDefault(); modalOk.click(); }
  });

  modalOk.addEventListener('click', () => {
    if (!pending || !pending.ok) return;
    const n = pending.notes.length;
    applyImport(pending, modalAppend.checked);
    closeModal();
    toast('已导入 ' + n + ' 个音');
  });

  $('btnPaste').addEventListener('click', () => {
    openModal('', '粘贴序列');
  });

  /* ---------------- MIDI 导入 ---------------- */
  function parseMidiBuffer(buffer) {
    const dv = new DataView(buffer);
    let pos = 0;
    const u8 = () => dv.getUint8(pos++);
    const u16 = () => { const v = dv.getUint16(pos); pos += 2; return v; };
    const u32 = () => { const v = dv.getUint32(pos); pos += 4; return v; };
    const str4 = () => { let s = ''; for (let i = 0; i < 4; i++) s += String.fromCharCode(u8()); return s; };
    const varLen = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

    if (str4() !== 'MThd') throw new Error('不是 MIDI 文件');
    const hlen = u32();
    u16();                       // format
    const ntracks = u16();
    const division = u16();
    pos = 8 + hlen;

    const notes = [];
    let tempoUs = 500000;

    for (let t = 0; t < ntracks && pos + 8 <= dv.byteLength; t++) {
      if (str4() !== 'MTrk') break;
      const len = u32();
      const end = pos + len;
      let tick = 0;
      let running = 0;
      const open = new Map();

      while (pos < end) {
        tick += varLen();
        let status = dv.getUint8(pos);
        if (status & 0x80) { pos += 1; if (status < 0xF0) running = status; }
        else { status = running; }

        const type = status & 0xF0;
        if (status === 0xFF) {
          const meta = u8();
          const mlen = varLen();
          if (meta === 0x51 && mlen === 3) {
            tempoUs = (dv.getUint8(pos) << 16) | (dv.getUint8(pos + 1) << 8) | dv.getUint8(pos + 2);
          }
          pos += mlen;
        } else if (status === 0xF0 || status === 0xF7) {
          pos += varLen();
        } else if (type === 0x90 || type === 0x80) {
          const pitch = dv.getUint8(pos);
          const vel = dv.getUint8(pos + 1);
          pos += 2;
          if (type === 0x90 && vel > 0) {
            if (!open.has(pitch)) open.set(pitch, tick);
          } else {
            const st = open.get(pitch);
            if (st !== undefined) { notes.push({ start: st, end: tick, pitch: pitch }); open.delete(pitch); }
          }
        } else if (type === 0xC0 || type === 0xD0) {
          pos += 1;
        } else {
          pos += 2;
        }
      }
      open.forEach((st, pitch) => notes.push({ start: st, end: tick, pitch: pitch }));
      pos = end;
    }
    return { notes: notes, division: division, tempoUs: tempoUs };
  }

  function importMidi(buffer) {
    const parsed = parseMidiBuffer(buffer);
    if (!parsed.notes.length) { toast('MIDI 里没有音符'); return; }

    const division = parsed.division || 480;
    const ticksPerCell = Math.max(1, Math.round(division * 4 / gridFactor));
    const bpmFromMidi = Math.round(60000000 / parsed.tempoUs);

    // 整曲移八度到 C5–E6
    const pitches = parsed.notes.map(n => n.pitch);
    let minP = Math.min.apply(null, pitches);
    let maxP = Math.max.apply(null, pitches);
    let shift = 0;
    if (maxP > 88) shift = -12 * Math.ceil((maxP - 88) / 12);
    if (minP + shift < 72) shift += 12 * Math.ceil((72 - (minP + shift)) / 12);

    const cells = new Map();     // col -> { midi, len }，同列取最高音
    parsed.notes.forEach(n => {
      let p = n.pitch + shift;
      while (p < 72) p += 12;
      while (p > 88) p -= 12;
      if (p < 72 || p > 88) return;
      const col = Math.max(0, Math.round(n.start / ticksPerCell));
      const len = Math.max(1, Math.min(64, Math.round((n.end - n.start) / ticksPerCell)));
      const prev = cells.get(col);
      if (!prev || p > prev.midi) cells.set(col, { midi: p, len: len });
    });

    if (!cells.size) { toast('没有落在 C5–E6 之间的音'); return; }

    snapshot();
    const colsList = Array.from(cells.keys());
    const maxCol = Math.max.apply(null, colsList);
    notes = colsList.sort((a, b) => a - b).map(col => {
      const v = cells.get(col);
      return { id: uid++, midi: v.midi, col: col, len: v.len, mapping: currentMapping(byMidi.get(v.midi)) };
    });
    cols = Math.max(COLS_UNIT, Math.ceil((maxCol + 1) / COLS_UNIT) * COLS_UNIT);
    playStart = 0;
    if (isFinite(bpmFromMidi) && bpmFromMidi >= 30 && bpmFromMidi <= 300) {
      bpm = bpmFromMidi;
      syncTimingInputs();
    }
    render();
    toast('已导入 ' + notes.length + ' 个音 · ' + bpm + ' BPM');
  }

  $('btnImport').addEventListener('click', () => $('fileInput').click());

  $('fileInput').addEventListener('change', () => {
    const input = $('fileInput');
    const f = input.files && input.files[0];
    if (!f) return;

    if (/\.midi?$/i.test(f.name)) {
      const reader = new FileReader();
      reader.onload = () => {
        try { importMidi(reader.result); }
        catch (e) { toast('MIDI 解析失败：' + e.message); }
      };
      reader.onerror = () => toast('文件读取失败');
      reader.readAsArrayBuffer(f);
    } else {
      const reader = new FileReader();
      reader.onload = () => openModal(String(reader.result || ''), '导入「' + f.name + '」');
      reader.onerror = () => toast('文件读取失败');
      reader.readAsText(f, 'utf-8');
    }
    input.value = '';
  });

  function stamp() {
    const d = new Date();
    const p = v => String(v).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  $('btnExport').addEventListener('click', () => {
    if (!notes.length) { toast('还没有音符可以导出'); return; }
    const ordered = sortedNotes();
    const data = {
      app: 'oot-ocarina-arranger',
      version: 1,
      cols: cols,
      count: ordered.length,
      timing: { bpm: bpm, gridFactor: gridFactor, defaultLen: defaultLen },
      breaks: breaks.map(b => ({ col: b.col, midi: b.midi })),
      notes: ordered.map(n => ({ col: n.col, len: n.len || 1, midi: n.midi, name: byMidi.get(n.midi).name, keys: n.mapping }))
    };
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '时之笛乐谱_' + stamp() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
      toast('已导出 ' + ordered.length + ' 个音');
    } catch (err) {
      toast('导出失败：' + err.message);
    }
  });

  /* ---------------- 电脑键盘 ---------------- */
  const KB = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', ';'];
  document.addEventListener('keydown', e => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (modal.classList.contains('on')) return;
    const k = (e.key || '').toLowerCase();
    const idx = KB.indexOf(k);
    if (idx >= 0) {
      e.preventDefault();
      previewNote(NOTES[idx].midi);
    }
  });

  /* ---------------- 提示 ---------------- */
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  /* ---------------- 自适应 ---------------- */
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { computeColW(); render(); }, 120);
  });

  computeColW();
  syncTimingInputs();
  render();
  // 供测试 / 控制台调用
  /* ---------------- 顶部页签 ---------------- */
  const tabbar = document.getElementById('tabbar');
  const viewEls = Array.prototype.slice.call(document.querySelectorAll('.view'));
  function showView(name) {
    viewEls.forEach(v => { v.hidden = v.dataset.view !== name; });
    if (tabbar) {
      Array.prototype.forEach.call(tabbar.querySelectorAll('.tabBtn'),
        b => b.classList.toggle('on', b.dataset.view === name));
    }
    if (name === 'device') refreshPorts();
    if (name === 'flash') { loadFirmwareInfo(); refreshFwPorts(); }
    if (name === 'buttons') renderKeys();
    if (name === 'scores' && !scoreLoaded) loadScores(false);
    if (name === 'about') loadAbout();
  }
  if (tabbar) {
    tabbar.addEventListener('click', e => {
      const btn = e.target.closest('.tabBtn');
      if (btn) {
        if (btn.dataset.view !== 'buttons') stopKeysPlay();
        showView(btn.dataset.view);
      }
    });
  }

  /* ---------------- 设备页 ---------------- */
  const devPort = document.getElementById('devPort');
  const devLog = document.getElementById('devLog');
  const devStatus = document.getElementById('devStatus');

  function devLogLine(text) {
    if (!devLog) return;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    devLog.textContent += '[' + time + '] ' + text + '\n';
    devLog.scrollTop = devLog.scrollHeight;
  }

  async function devApi(path, options) {
    const res = await fetch(path, options);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    if (!res.ok) throw new Error((data && (data.error || data.raw)) || ('HTTP ' + res.status));
    return data;
  }

  async function refreshPorts() {
    if (!devPort) return;
    try {
      const data = await devApi('/api/ports');
      const ports = (data && data.ports) || [];
      const current = devPort.value;
      devPort.innerHTML = ports.length
        ? ports.map(p => '<option value="' + p.path + '">' + p.label + '</option>').join('')
        : '<option value="">未检测到串口</option>';
      if (current && ports.some(p => p.path === current)) devPort.value = current;
      if (devStatus) {
        devStatus.textContent = ports.length ? '就绪' : '未检测到串口';
        devStatus.classList.toggle('on', ports.length > 0);
      }
    } catch (e) {
      devLogLine('读取串口失败：' + e.message);
    }
  }

  // 把串口底层报错翻成人话，优先让人去查线材
  function friendlySerialError(message) {
    const text = String(message || '');

    if (/File not found|ENOENT|cannot find the file/i.test(text)) {
      return '打不开串口：系统里已经没有这个设备了。\n' +
        '最常见是 USB 线松动 / 接触不良（也可能是只供电不传数据的线、或经过 hub 掉线）。\n' +
        '请先检查线和接口——换口、换线、拔插一遍，再点「刷新」重新选端口。';
    }

    if (/Access denied|Access is denied|EBUSY|being used by another process|Permission denied|PermissionError|Resource temporarily unavailable/i.test(text)) {
      return '串口被别的程序占用了：先点「断开」，或关掉 PlatformIO 监视器 / 串口助手之类的程序，再试一次。';
    }

    if (/Timed out|timeout|ACK/i.test(text)) {
      return '开发板没有回应：确认固件在运行、波特率 115200；不行就拔插板子再试。';
    }

    return text;
  }

  async function sendDeviceCommand(cmd) {
    const port = devPort && devPort.value;
    if (!port) { devLogLine('请先选择串口'); return; }
    devLogLine('> ' + cmd);
    try {
      const data = await devApi('/api/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commands: [cmd], target: 'serial', portPath: port,
          baudRate: 115200, ackTimeoutMs: 1500, retries: 1
        })
      });
      (data.lines || []).forEach(l => devLogLine('< ' + l));
      if (data.error) devLogLine('! ' + data.error);
      if (devStatus) { devStatus.textContent = '已连接 ' + port; devStatus.classList.add('on'); }
    } catch (e) {
      devLogLine('! ' + friendlySerialError(e.message));
    }
  }

  if (document.getElementById('devRefresh')) {
    document.getElementById('devRefresh').addEventListener('click', refreshPorts);
  }
  if (document.getElementById('devSend')) {
    document.getElementById('devSend').addEventListener('click', () => {
      const box = document.getElementById('devCmd');
      const cmd = box ? box.value.trim() : '';
      if (cmd) sendDeviceCommand(cmd);
    });
  }
  if (document.getElementById('devClearLog')) {
    document.getElementById('devClearLog').addEventListener('click', () => { if (devLog) devLog.textContent = ''; });
  }
  if (document.getElementById('devConnect')) {
    document.getElementById('devConnect').addEventListener('click', () => sendDeviceCommand('I'));
  }
  if (document.getElementById('devBtConnect')) {
    document.getElementById('devBtConnect').addEventListener('click', () => sendDeviceCommand('BT CONNECT'));
  }
  if (document.getElementById('devResetBt')) {
    document.getElementById('devResetBt').addEventListener('click', () => sendDeviceCommand('BT RESET'));
  }
  if (document.getElementById('devDisconnect')) {
    document.getElementById('devDisconnect').addEventListener('click', async () => {
      try {
        // 先通知开发板断开与主机的蓝牙链路，再关串口，
        // 否则软件关了但主机上仍挂着这个手柄。
        const portSel = document.getElementById('devPort');
        const portPath = portSel ? portSel.value : '';
        if (portPath) {
          try {
            await devApi('/api/execute', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                commands: ['BT DISCONNECT'],
                target: 'serial',
                portPath,
                baudRate: 115200,
                ackTimeoutMs: 3000,
                retries: 0
              })
            });
            devLogLine('已通知开发板断开主机');
          } catch (e) {
            devLogLine('断开主机失败（继续释放串口）：' + friendlySerialError(e.message));
          }
        }

        await devApi('/api/serial-session/disconnect', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true })  // 忙时也强制断开，确保释放串口
        });
        devLogLine('已断开串口');
        if (devStatus) { devStatus.textContent = '未连接'; devStatus.classList.remove('on'); }
      } catch (e) { devLogLine('断开失败：' + friendlySerialError(e.message)); }
    });
  }
  let performing = false;

  function setPerforming(value) {
    performing = value;
    ['btnPerform', 'devPlayScore'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = value;
    });
    ['btnStopPerform', 'devStopScore'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !value;
    });
  }

  async function stopPerformance() {
    if (!performing) return;
    try {
      // 强制断开串口会打断正在等待 ACK 的那条命令，演奏随即中止
      await devApi('/api/serial-session/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true })
      });
    } catch (e) { /* 已经停了也无所谓 */ }
    setPerforming(false);
    toast('已停止演奏');
    if (devLog) devLogLine('已停止演奏');
  }

  async function playScoreToDevice() {
    if (performing) return;
    const lines = (window.__ocarina && window.__ocarina.getCommands) ? window.__ocarina.getCommands() : [];
    if (!lines.length) { toast('谱面是空的'); return; }
    const port = devPort && devPort.value;
    if (!port) { toast('请先到「设备与测试」页选择串口'); return; }
    if (devLog) devLogLine('演奏 ' + lines.length + ' 行，共 ' + port + '（静默 64ms / 补偿 82ms）');
    setPerforming(true);
    try {
      const data = await devApi('/api/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commands: ['CFG INPUT 16 64 1800'].concat(lines), target: 'serial', portPath: port,
          baudRate: 115200, ackTimeoutMs: 12000, retries: 0  // 留足一次蓝牙自愈的时间
        })
      });
      (data.lines || []).slice(-12).forEach(l => devLogLine('< ' + l));
      if (data.error) devLogLine('! ' + data.error);
      devLogLine('演奏结束');
    } catch (e) {
      devLogLine('! ' + friendlySerialError(e.message));
    } finally {
      setPerforming(false);
    }
  }

  if (document.getElementById('devPlayScore')) {
    document.getElementById('devPlayScore').addEventListener('click', playScoreToDevice);
  }
  if (document.getElementById('btnPerform')) {
    document.getElementById('btnPerform').addEventListener('click', playScoreToDevice);
  }
  ['btnStopPerform', 'devStopScore'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', stopPerformance);
  });

  ['devPads', 'devNotes'].forEach(id => {
    const grid = document.getElementById(id);
    if (!grid) return;
    grid.addEventListener('click', e => {
      const btn = e.target.closest('.padBtn');
      if (btn) sendDeviceCommand(btn.dataset.cmd);
    });
  });

  /* ---------------- 固件刷入页 ---------------- */
  const fwEnv = document.getElementById('fwEnv');
  const fwModel = document.getElementById('fwModel');
  const fwPort = document.getElementById('fwPort');
  const fwLog = document.getElementById('fwLog');
  const fwStatus = document.getElementById('fwStatus');
  const fwProgress = document.getElementById('fwProgress');
  let fwPollTimer = null;
  let fwInfoLoaded = false;

  const FW_STATUS_TEXT = {
    idle: '空闲', running: '刷写中…', completed: '完成', failed: '失败', cancelled: '已取消'
  };

  function fwLogSet(lines) {
    if (!fwLog) return;
    fwLog.textContent = (lines || []).join('\n');
    fwLog.scrollTop = fwLog.scrollHeight;
  }

  async function loadFirmwareInfo() {
    if (fwInfoLoaded) return;
    try {
      const info = await devApi('/api/firmware/info');
      // 只保留 ESP32（esp32dev_wireless），其余开发板环境不显示
      const allEnvs = (info && info.environments) || [];
      const envs = allEnvs.filter(e => e.id === 'esp32dev_wireless');
      if (!envs.length) envs.push.apply(envs, allEnvs);
      const models = ((info && info.switchModels) || []).filter(m => !m.hidden);
      if (fwEnv) {
        fwEnv.innerHTML = envs.map(e => '<option value="' + e.id + '"' + (e.recommended ? ' selected' : '') + '>' + e.label + '</option>').join('');
      }
      if (fwModel) {
        fwModel.innerHTML = models.map(m => '<option value="' + m.id + '"' + (m.recommended ? ' selected' : '') + '>' + m.label + '</option>').join('');
      }
      if (info && info.platformIo && info.platformIo.available === false) {
        fwLogSet(['提示：服务端没检测到 PlatformIO，刷入会失败。', '需要本机能运行 pio（或设置 PLATFORMIO_BIN）。']);
      }
      fwInfoLoaded = true;
    } catch (e) {
      fwLogSet(['读取固件信息失败：' + e.message]);
    }
  }

  async function refreshFwPorts() {
    if (!fwPort) return;
    try {
      const data = await devApi('/api/ports');
      const ports = (data && data.ports) || [];
      fwPort.innerHTML = ports.length
        ? ports.map(p => '<option value="' + p.path + '">' + p.label + '</option>').join('')
        : '<option value="">未检测到串口</option>';
    } catch (e) { /* 忽略 */ }
  }

  function stopFwPoll() {
    if (fwPollTimer) { clearTimeout(fwPollTimer); fwPollTimer = null; }
  }

  async function pollFlashStatus() {
    try {
      const raw = await devApi('/api/firmware/flash/status');
      // 服务端把快照包在 flash 字段里
      const snap = (raw && raw.flash) ? raw.flash : raw;
      if (!snap) return;
      if (fwStatus) {
        fwStatus.textContent = FW_STATUS_TEXT[snap.status] || snap.status;
        fwStatus.classList.toggle('on', snap.status === 'completed');
      }
      if (fwProgress && snap.totalLineCount) {
        fwProgress.textContent = snap.lineOffset + '/' + snap.totalLineCount + ' 行';
      }
      // 只有真正有内容时才重写日志，避免刚开始轮询时把「提交刷写任务…」清空
      const incoming = (snap.lines || []).slice();
      if (snap.error) incoming.push('', '错误：' + snap.error);
      if (incoming.length > 0) {
        fwLogSet(incoming);
      } else if (snap.status === 'idle') {
        // 任务没起来（比如服务端拒绝），至少留一行提示
        fwLogSet(['刷写任务未启动（状态 idle），请检查环境/端口/PlatformIO']);
      }
      if (snap.status === 'running') {
        fwPollTimer = window.setTimeout(pollFlashStatus, 800);
      } else {
        stopFwPoll();
      }
    } catch (e) {
      stopFwPoll();
    }
  }

  /* ---- 环境准备：安装 PlatformIO / CP210x 驱动 ---- */
  let fwJobTimer = null;

  function fwJobStop() {
    if (fwJobTimer) { clearTimeout(fwJobTimer); fwJobTimer = null; }
  }

  function fwRenderJob(job, label) {
    const lines = ((job && job.lines) || []).slice();
    if (job && job.error) lines.push('', '错误：' + job.error);
    if (lines.length) fwLogSet(lines);
    if (fwStatus) {
      const map = { idle: '空闲', running: label + '中…', completed: '完成', failed: '失败', cancelled: '已取消' };
      fwStatus.textContent = map[job && job.status] || (job && job.status) || '空闲';
      fwStatus.classList.toggle('on', !!(job && job.status === 'completed'));
    }
  }

  async function fwPollJob(statusUrl, label) {
    try {
      const raw = await devApi(statusUrl);
      const job = (raw && (raw.install || raw.flash)) ? (raw.install || raw.flash) : raw;
      fwRenderJob(job, label);
      if (job && job.status === 'running') {
        fwJobTimer = window.setTimeout(() => fwPollJob(statusUrl, label), 800);
      }
    } catch (e) {
      fwLogSet([label + '状态读取失败：' + e.message]);
    }
  }

  async function fwStartJob(startUrl, body, statusUrl, label) {
    fwJobStop();
    fwLogSet([label + '：正在提交…']);
    if (fwStatus) { fwStatus.textContent = label + '中…'; fwStatus.classList.remove('on'); }
    try {
      const raw = await devApi(startUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const job = (raw && (raw.install || raw.flash)) ? (raw.install || raw.flash) : raw;
      fwRenderJob(job, label);
      fwJobTimer = window.setTimeout(() => fwPollJob(statusUrl, label), 600);
    } catch (e) {
      fwLogSet([label + '失败：' + e.message]);
      if (fwStatus) fwStatus.textContent = '失败';
    }
  }

  if (document.getElementById('fwInstallPio')) {
    document.getElementById('fwInstallPio').addEventListener('click', () => {
      if (!window.confirm('将用 pip 安装 PlatformIO（缺少 Python 时会先下载一个独立运行环境），继续？')) return;
      fwStartJob('/api/firmware/tooling/install', { allowPythonDownload: true },
        '/api/firmware/tooling/install/status', '安装 PlatformIO');
    });
  }

  if (document.getElementById('fwInstallDriver')) {
    document.getElementById('fwInstallDriver').addEventListener('click', () => {
      fwStartJob('/api/windows-serial-drivers/install', { driverId: 'cp210x' },
        '/api/windows-serial-drivers/install/status', '安装 CP210x 驱动');
    });
  }

  if (document.getElementById('fwStart')) {
    document.getElementById('fwStart').addEventListener('click', async () => {
      if (!fwPort || !fwPort.value) { fwLogSet(['请选择串口']); return; }
      const body = {
        environmentId: fwEnv && fwEnv.value,
        switchModelId: fwModel && fwModel.value,
        portPath: fwPort.value
      };
      if (fwStatus) { fwStatus.textContent = '提交中…'; fwStatus.classList.remove('on'); }
      fwLogSet(['提交刷写任务…']);
      let posted = true;
      try {
        // 提交最多等 5 秒；超时也照常开始轮询状态，避免界面永远停在「提交中」
        const postPromise = devApi('/api/firmware/flash', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        postPromise.catch(() => {});
        const timeout = new Promise(resolve => window.setTimeout(() => resolve('timeout'), 1500));
        const outcome = await Promise.race([postPromise, timeout]);
        if (outcome === 'timeout') {
          posted = false;
          fwLogSet(['提交超过 1.5 秒未返回，继续查询状态…']);
        }
        stopFwPoll();
        fwPollTimer = window.setTimeout(pollFlashStatus, posted ? 600 : 200);
      } catch (e) {
        fwLogSet(['提交失败：' + e.message]);
        if (fwStatus) fwStatus.textContent = '失败';
      }
    });
  }

  if (document.getElementById('fwRefresh')) {
    document.getElementById('fwRefresh').addEventListener('click', refreshFwPorts);
  }

  if (document.getElementById('fwCancel')) {
    document.getElementById('fwCancel').addEventListener('click', async () => {
      try {
        await devApi('/api/firmware/flash/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        fwLogSet(['已请求取消…']);
      } catch (e) { fwLogSet(['取消失败：' + e.message]); }
    });
  }

  // 启动时先把串口列表拉好，曲谱页的「演奏」直接可用
  refreshPorts();

  /* ---------------- 仅按键谱 ---------------- */
  const keysWrapEl = document.getElementById('keysWrap');
  const keysMetaEl = document.getElementById('keysMeta');
  const keysEmptyEl = document.getElementById('keysEmpty');
  const keysPlayBtn = document.getElementById('keysPlay');
  const keyCellMap = new Map();
  let keysTimers = [];
  let keysPlaying = false;

  // 图标拆成「viewBox + 内容」，页面里包成 <svg>，导出时贴进大 SVG 里复用
  function iconParts(kind) {
    const ring = '<circle cx="16" cy="16" r="13.6" fill="none" stroke="currentColor" stroke-width="2"/>';
    const up = '<path d="M16 21.5V11.5M12 15.5L16 11.5L20 15.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
    const down = '<path d="M16 10.5V20.5M12 16.5L16 20.5L20 16.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';

    if (kind === 'L' || kind === 'R') {
      return {
        vb: '0 0 32 32',
        inner: '<rect x="2.5" y="8.5" width="27" height="15" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>' +
          '<text x="16" y="20.4" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">' + kind + '</text>'
      };
    }

    if (kind === 'stick-up' || kind === 'stick-down') {
      const stickRing = '<circle cx="15" cy="16" r="13.6" fill="none" stroke="currentColor" stroke-width="2"/>';
      const stickL = '<text x="15" y="21" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">L</text>';
      const stickUp = '<path d="M39.5 24V8.5M35.9 12L39.5 8.4L43.1 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
      const stickDown = '<path d="M39.5 8V23.5M35.9 20L39.5 23.6L43.1 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
      return { vb: '0 0 48 32', inner: stickRing + stickL + (kind === 'stick-up' ? stickUp : stickDown) };
    }

    if (kind === 'dpad-up' || kind === 'dpad-down') {
      return { vb: '0 0 32 32', inner: ring + (kind === 'dpad-up' ? up : down) };
    }

    const letter = String(kind || '').slice(0, 1).toUpperCase();
    return {
      vb: '0 0 32 32',
      inner: ring + '<text x="16" y="21" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">' + letter + '</text>'
    };
  }

  function iconMarkup(kind) {
    const p = iconParts(kind);
    const stick = kind === 'stick-up' || kind === 'stick-down';
    return '<svg viewBox="' + p.vb + '" class="keyIcon' + (stick ? ' keyIcon-stick' : '') + '">' + p.inner + '</svg>';
  }

  // "摇杆下+L" -> ['stick-down', 'L']；"下+A" -> ['dpad-down', 'A']；"L" -> ['L']
  function keyKinds(label) {
    let rest = String(label || '').trim();
    const kinds = [];

    if (rest.indexOf('摇杆下+') === 0) { kinds.push('stick-down'); rest = rest.slice(4); }
    else if (rest.indexOf('摇杆上+') === 0) { kinds.push('stick-up'); rest = rest.slice(4); }
    else if (rest.indexOf('下+') === 0) { kinds.push('dpad-down'); rest = rest.slice(2); }
    else if (rest.indexOf('上+') === 0) { kinds.push('dpad-up'); rest = rest.slice(2); }

    rest = rest.trim();
    if (rest && rest.toUpperCase() !== 'B') kinds.push(rest);
    return kinds;
  }

  const KEYS_PER_LINE = 8;

  // 把音符按断句分成若干句；句内连续的音紧挨着排，中间有空档就插一个固定间隔
  function phraseItems(list) {
    const breakCols = [];
    breaks.forEach(function (b) {
      if (typeof b.col === 'number' && breakCols.indexOf(b.col) < 0) breakCols.push(b.col);
    });
    breakCols.sort(function (a, b) { return a - b; });

    const phraseOf = function (n) {
      let k = 0;
      for (let i = 0; i < breakCols.length; i += 1) {
        if (n.col > breakCols[i]) k += 1;
        else break;
      }
      return k;
    };

    const maxPhrase = list.length === 0
      ? -1
      : list.reduce(function (m, n) { return Math.max(m, phraseOf(n)); }, 0);

    const phrases = [];

    for (let ph = 0; ph <= maxPhrase; ph += 1) {
      const inPhrase = list
        .filter(function (n) { return phraseOf(n) === ph; })
        .sort(function (a, b) { return (a.col - b.col) || (a.id - b.id); });

      if (!inPhrase.length) continue;

      const items = [];
      inPhrase.forEach(function (n, i) {
        if (i > 0) {
          const prev = inPhrase[i - 1];
          if (n.col > prev.col + (prev.len || 1)) items.push({ kind: 'gap' });
        }
        items.push({ kind: 'note', note: n });
      });

      phrases.push(items);
    }

    return phrases;
  }

  function renderKeys() {
    if (!keysWrapEl) return;

    const list = sortedNotes();
    keysWrapEl.textContent = '';
    keyCellMap.clear();

    if (keysEmptyEl) keysEmptyEl.hidden = list.length > 0;

    if (keysMetaEl) {
      keysMetaEl.textContent = list.length
        ? list.length + ' 个音' + (breaks.length ? ' · ' + breaks.length + ' 处断句' : '')
        : '';
    }

    if (!list.length) return;

    phraseItems(list).forEach(function (items, pi) {
      const row = document.createElement('div');
      row.className = 'keyPhrase' + (pi > 0 ? ' sep' : '');

      items.forEach(function (item) {
        if (item.kind === 'gap') {
          const gap = document.createElement('span');
          gap.className = 'keyGap';
          row.appendChild(gap);
          return;
        }

        const n = item.note;
        const box = document.createElement('div');
        box.className = 'keyBox';
        box.dataset.noteId = String(n.id);

        keyKinds(n.mapping).forEach(function (kind, index) {
          if (index > 0) {
            const plus = document.createElement('span');
            plus.className = 'keyPlus';
            plus.textContent = '+';
            box.appendChild(plus);
          }
          box.insertAdjacentHTML('beforeend', iconMarkup(kind));
        });

        keyCellMap.set(n.id, box);
        row.appendChild(box);
      });

      keysWrapEl.appendChild(row);
    });
  }


  /* ---------------- 仅按键谱：试听 ---------------- */
  function stopKeysPlay() {
    keysTimers.forEach(clearTimeout);
    keysTimers = [];
    keysPlaying = false;
    Array.prototype.forEach.call(document.querySelectorAll('.keyBox.playing'),
      function (el) { el.classList.remove('playing'); });
    if (keysPlayBtn) keysPlayBtn.textContent = '▶ 试听';
  }

  function startKeysPlay() {
    if (keysPlaying) { stopKeysPlay(); return; }

    const list = sortedNotes();
    if (!list.length) { toast('还没有音符'); return; }

    const step = stepMs();
    keysPlaying = true;
    if (keysPlayBtn) keysPlayBtn.textContent = '■ 停止';

    list.forEach(function (n) {
      keysTimers.push(setTimeout(function () {
        tone(n.midi, Math.max(0.15, noteHoldMs(n.len || 1) / 1000));
        Array.prototype.forEach.call(document.querySelectorAll('.keyBox.playing'),
          function (el) { el.classList.remove('playing'); });

        const cell = keyCellMap.get(n.id);
        if (cell) {
          cell.classList.add('playing');
          centerInKeysSheet(cell);
        }
      }, n.col * step));
    });

    const last = list[list.length - 1];
    keysTimers.push(setTimeout(stopKeysPlay, last.col * step + noteHoldMs(last.len || 1) + 200));
  }

  // 试听时让当前音停在可见区域的中间（谱面区自己会滚，整页也可能需要滚）
  function centerInKeysSheet(el) {
    const sheet = el.closest ? el.closest('.keysSheet') : null;

    if (sheet && sheet.scrollHeight > sheet.clientHeight + 4) {
      const boxRect = el.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      const delta = (boxRect.top + boxRect.height / 2) - (sheetRect.top + sheetRect.height / 2);
      sheet.scrollTo({ top: Math.max(0, sheet.scrollTop + delta), behavior: 'smooth' });
      return;
    }

    const rect = el.getBoundingClientRect();
    const target = window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  // 试听时点谱面任意位置都能打断（按钮滚出视野后也能停）
  if (keysWrapEl) {
    keysWrapEl.addEventListener('click', function () {
      if (keysPlaying) stopKeysPlay();
    });
  }

  if (keysPlayBtn) keysPlayBtn.addEventListener('click', startKeysPlay);

  /* ---------------- 仅按键谱：导出 ---------------- */
  function r2(value) { return Math.round(value * 100) / 100; }

  // 把当前谱面画成一张浅色 SVG（图片和 PDF 都用它）
  // 把当前谱面画成一张浅色 SVG（导出图片 / 打印 PDF 都用它）
  function buildKeysSheetSvg() {
    const PAD = 30, LINE_H = 78, BOX_H = 56, BOX_PAD = 12;
    const ICON = 40, STICK_W = 60, PLUS_W = 16, ICON_GAP = 3;
    const GAP_NOTE = 10;       // 相邻两个音之间
    const GAP_REST = 36;       // 中间有休止时的固定空档
    const MAX_W = 1180;        // 一行最宽多少
    const PHRASE_GAP = 26;

    const phrases = phraseItems(sortedNotes());

    const boxWidth = function (item) {
      const kinds = keyKinds(item.note.mapping);
      let w = BOX_PAD * 2;
      kinds.forEach(function (k, i) {
        w += (k.indexOf('stick') === 0 ? STICK_W : ICON);
        if (i > 0) w += PLUS_W + ICON_GAP * 2;
      });
      return w;
    };

    const lines = [];

    phrases.forEach(function (items, pi) {
      let line = { items: [], width: 0, newPhrase: pi > 0 };

      items.forEach(function (item) {
        const w = item.kind === 'gap' ? GAP_REST : boxWidth(item);
        const extra = line.items.length ? GAP_NOTE : 0;

        if (line.items.length && line.width + extra + w > MAX_W) {
          lines.push(line);
          line = { items: [], width: 0, newPhrase: false };
        }

        const x = line.width + (line.items.length ? GAP_NOTE : 0);
        line.items.push({ item: item, x: x, w: w });
        line.width = x + w;
      });

      if (line.items.length) lines.push(line);
    });

    const width = MAX_W + PAD * 2;
    const body = [];
    let y = PAD;

    lines.forEach(function (line) {
      // 每行居中
      const lineOffset = Math.max(0, (MAX_W - line.width) / 2);

      if (line.newPhrase) {
        y += PHRASE_GAP;
        body.push('<line x1="' + PAD + '" y1="' + r2(y - PHRASE_GAP / 2) + '" x2="' + r2(width - PAD) +
          '" y2="' + r2(y - PHRASE_GAP / 2) + '" stroke="#b9c9c6" stroke-width="1" stroke-dasharray="6 6"/>');
      }

      line.items.forEach(function (entry) {
        if (entry.item.kind === 'gap') return;

        const n = entry.item.note;
        const boxX = PAD + lineOffset + entry.x;
        const boxY = y + (LINE_H - BOX_H) / 2;

        body.push('<rect x="' + r2(boxX) + '" y="' + r2(boxY) + '" width="' + r2(entry.w) + '" height="' + BOX_H +
          '" rx="12" fill="#ffffff" stroke="#d5c8a2" stroke-width="1.5"/>');

        let ix = boxX + BOX_PAD;

        keyKinds(n.mapping).forEach(function (kind, index) {
          if (index > 0) {
            body.push('<text x="' + r2(ix + PLUS_W / 2) + '" y="' + r2(boxY + BOX_H / 2 + 7) +
              '" text-anchor="middle" font-size="20" font-weight="700" fill="#93825a">+</text>');
            ix += PLUS_W + ICON_GAP * 2;
          }

          const parts = iconParts(kind);
          const w = kind.indexOf('stick') === 0 ? STICK_W : ICON;
          const vbw = Number(parts.vb.split(' ')[2]);
          const scale = w / vbw;
          const h = 32 * scale;

          body.push('<g transform="translate(' + r2(ix) + ',' + r2(boxY + (BOX_H - h) / 2) + ') scale(' +
            r2(scale) + ')" color="#3f3f3f">' + parts.inner + '</g>');

          ix += w + ICON_GAP;
        });
      });

      y += LINE_H;
    });

    const height = y + PAD;

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + r2(width) + '" height="' + r2(height) +
      '" viewBox="0 0 ' + r2(width) + ' ' + r2(height) + '">' +
      '<rect width="100%" height="100%" fill="#ffffff"/>' + body.join('') + '</svg>';
  }

  function exportKeysPng() {
    if (!notes.length) { toast('还没有音符'); return; }

    const svg = buildKeysSheetSvg();
    const img = new Image();

    img.onload = function () {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(function (blob) {
        if (!blob) { toast('导出失败'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '按键谱_' + stamp() + '.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1200);
        toast('已导出图片');
      }, 'image/png');
    };

    img.onerror = function () { toast('导出失败：图片生成出错'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  async function exportKeysPdf() {
    if (!notes.length) { toast('还没有音符'); return; }

    stopKeysPlay();
    document.body.classList.add('printing-keys');

    try {
      const api = window.friendMakerWindow;

      if (api && typeof api.exportPdf === 'function') {
        // 主进程 printToPDF → 直接写文件，不走打印对话框
        const result = await api.exportPdf('按键谱_' + stamp() + '.pdf');

        if (result && result.ok) {
          toast('已导出 PDF');
        } else if (!result || !result.canceled) {
          toast('导出失败：' + ((result && result.error) || '未知错误'));
        }
      } else {
        // 非 Electron 环境（比如直接用浏览器打开）退回打印
        window.print();
      }
    } catch (e) {
      toast('导出失败：' + e.message);
    } finally {
      document.body.classList.remove('printing-keys');
    }
  }

  // 打印时临时给 body 打标记，打印结束再摘掉（Electron / 浏览器都支持这两个事件）
  window.addEventListener('beforeprint', function () { document.body.classList.add('printing-keys'); });
  window.addEventListener('afterprint', function () { document.body.classList.remove('printing-keys'); });

  const keysPngBtn = document.getElementById('keysPng');
  const keysPdfBtn = document.getElementById('keysPdf');
  if (keysPngBtn) keysPngBtn.addEventListener('click', exportKeysPng);
  if (keysPdfBtn) keysPdfBtn.addEventListener('click', exportKeysPdf);

  /* ---------------- 谱面库 ---------------- */
  const scoreListEl = document.getElementById('scoreList');
  const scoreStatusEl = document.getElementById('scoreStatus');
  const scoreSearchEl = document.getElementById('scoreSearch');
  const scoreRefreshEl = document.getElementById('scoreRefresh');
  const scoreModalEl = document.getElementById('scoreModal');
  const scoreModalTitleEl = document.getElementById('scoreModalTitle');
  const scoreModalMetaEl = document.getElementById('scoreModalMeta');
  let scoreEntries = [];
  let scoreLoaded = false;
  let scoreBusy = false;
  let activeScore = null;
  let scoreError = '';

  function safeFileName(title, author) {
    return ((title || '谱面') + (author ? '_' + author : '')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  }

  function renderScores() {
    if (!scoreListEl) return;
    const q = ((scoreSearchEl && scoreSearchEl.value) || '').trim().toLowerCase();
    const list = scoreEntries.filter(function (s) {
      if (!q) return true;
      return String(s.title || '').toLowerCase().indexOf(q) >= 0 ||
        String(s.author || '').toLowerCase().indexOf(q) >= 0;
    });

    scoreListEl.textContent = '';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'scoreEmpty' + (scoreError ? ' error' : '');
      empty.textContent = scoreError
        ? scoreError
        : (scoreEntries.length ? '没有匹配的谱面' : '谱面库还是空的');
      scoreListEl.appendChild(empty);
      return;
    }

    list.forEach(function (s) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'scoreRow';

      const title = document.createElement('span');
      title.className = 'scoreTitle';
      title.textContent = s.title || '(无标题)';

      const author = document.createElement('span');
      author.className = 'scoreAuthor';
      author.textContent = s.author || '未知作者';

      const count = document.createElement('span');
      count.className = 'scoreNotes';
      count.textContent = s.notes ? s.notes + ' 音' : '';

      row.appendChild(title);
      row.appendChild(author);
      row.appendChild(count);
      row.addEventListener('click', function () { openScoreModal(s); });
      scoreListEl.appendChild(row);
    });
  }

  async function loadScores(force, silent) {
    if (scoreBusy) return;
    scoreBusy = true;
    if (scoreStatusEl) scoreStatusEl.textContent = '读取中…';

    try {
      const data = await devApi('/api/scores' + (force ? '?force=1' : ''));

      if (!data || data.ok === false) {
        scoreEntries = [];
        // 启动时静默失败的话，留一次机会给「打开页签/点刷新」重试
        scoreLoaded = !silent;
        scoreError = '网络问题，暂时读不到谱面库（' + ((data && data.error) || '未知错误') + '）· 点「刷新」重试';
        if (scoreStatusEl) scoreStatusEl.textContent = '读取失败';
        renderScores();
        if (!silent) toast('谱面库读取失败：' + ((data && data.error) || '未知错误'));
        return;
      }

      scoreEntries = Array.isArray(data.scores) ? data.scores : [];
      scoreLoaded = true;
      scoreError = '';
      if (scoreStatusEl) {
        const label = String(data.source || '');
        const from = label === 'GitHub API' ? 'GitHub'
          : label.indexOf('jsdelivr') >= 0 ? 'CDN'
            : label.indexOf('raw.githubusercontent') >= 0 ? 'raw'
              : '';
        scoreStatusEl.textContent = '共 ' + scoreEntries.length + ' 首' + (from ? ' · ' + from : '');
      }
      renderScores();
    } catch (e) {
      scoreEntries = [];
      scoreError = '网络问题，暂时读不到谱面库（' + e.message + '）· 点「刷新」重试';
      if (scoreStatusEl) scoreStatusEl.textContent = '读取失败';
      renderScores();
      if (!silent) toast('谱面库读取失败：' + e.message);
    } finally {
      scoreBusy = false;
    }
  }

  async function fetchScoreJson(entry) {
    const res = await fetch('/api/scores/file?id=' + encodeURIComponent(entry.id));
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data) throw new Error('谱面文件不是合法 JSON');
    if (data.ok === false) throw new Error(data.error || '读取失败');
    return { text: text, data: data };
  }

  function openScoreModal(entry) {
    activeScore = entry;
    if (scoreModalTitleEl) scoreModalTitleEl.textContent = entry.title || '谱面';
    if (scoreModalMetaEl) {
      scoreModalMetaEl.textContent = '作者：' + (entry.author || '未知作者') +
        (entry.notes ? ' · 共 ' + entry.notes + ' 个音' : '');
    }
    if (scoreModalEl) {
      scoreModalEl.classList.add('on');
      scoreModalEl.setAttribute('aria-hidden', 'false');
    }
  }

  function closeScoreModal() {
    if (scoreModalEl) {
      scoreModalEl.classList.remove('on');
      scoreModalEl.setAttribute('aria-hidden', 'true');
    }
    activeScore = null;
  }

  async function downloadScore() {
    if (!activeScore) return;
    const title = activeScore.title || '谱面';
    try {
      const r = await fetchScoreJson(activeScore);
      const blob = new Blob([r.text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = safeFileName(activeScore.title, activeScore.author) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
      closeScoreModal();
      toast('已保存「' + title + '」');
    } catch (e) {
      toast('下载失败：' + e.message);
    }
  }

  async function sendScoreToEditor() {
    if (!activeScore) return;
    const title = activeScore.title || '谱面';

    if (notes.length && !window.confirm('当前谱面会被替换，继续？')) return;

    try {
      const r = await fetchScoreJson(activeScore);
      const parsed = parseSequence(JSON.stringify(r.data));
      if (!parsed.ok) { toast('谱面解析失败：' + parsed.error); return; }
      applyImport(parsed, false);
      closeScoreModal();
      showView('score');
      toast('已载入「' + title + '」');
    } catch (e) {
      toast('载入失败：' + e.message);
    }
  }

  if (scoreRefreshEl) scoreRefreshEl.addEventListener('click', function () { loadScores(true); });
  if (scoreSearchEl) scoreSearchEl.addEventListener('input', renderScores);
  if (scoreModalEl) {
    scoreModalEl.addEventListener('click', function (e) {
      if (e.target === scoreModalEl) closeScoreModal();
    });
  }

  const scoreModalCloseEl = document.getElementById('scoreModalClose');
  const scoreDownloadEl = document.getElementById('scoreDownload');
  const scoreSendEl = document.getElementById('scoreSend');
  if (scoreModalCloseEl) scoreModalCloseEl.addEventListener('click', closeScoreModal);
  if (scoreDownloadEl) scoreDownloadEl.addEventListener('click', downloadScore);
  if (scoreSendEl) scoreSendEl.addEventListener('click', sendScoreToEditor);

  // 启动时就静默拉一遍谱面库（带时间戳绕过 CDN 缓存），打开页签时已经是最新的
  window.setTimeout(function () {
    loadScores(true, true);
  }, 2000);

  /* ---------------- 关于页 ---------------- */
  const aboutVersionEl = document.getElementById('aboutVersion');
  const aboutVersionBadge = document.getElementById('aboutVersionBadge');
  const aboutRepoEl = document.getElementById('aboutRepo');
  const aboutRuntimeEl = document.getElementById('aboutRuntime');
  const aboutTaglineEl = document.getElementById('aboutTagline');
  const aboutFeaturesEl = document.getElementById('aboutFeatures');
  const updateBtn = document.getElementById('updateCheckBtn');
  const updateStatusEl = document.getElementById('updateStatus');
  const updateDetailEl = document.getElementById('updateDetail');
  const updateCheckedAtEl = document.getElementById('updateCheckedAt');
  const aboutDot = document.getElementById('aboutDot');
  let aboutLoaded = false;
  let updateRunning = false;
  let lastReleaseUrl = '';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function setUpdateStatus(text, tone) {
    if (!updateStatusEl) return;
    updateStatusEl.textContent = text;
    updateStatusEl.classList.toggle('on', tone === 'on');
    updateStatusEl.classList.toggle('warn', tone === 'warn');
  }

  async function loadAbout() {
    if (aboutLoaded) return;
    aboutLoaded = true;
    try {
      const info = await devApi('/api/about');
      if (aboutVersionEl) aboutVersionEl.textContent = 'v' + info.version;
      if (aboutVersionBadge) aboutVersionBadge.textContent = 'v' + info.version;
      if (aboutRepoEl && info.repoUrl) {
        aboutRepoEl.href = info.repoUrl;
        aboutRepoEl.textContent = (info.repoLabel || info.repoUrl) + ' ↗';
      }
      if (aboutTaglineEl && info.tagline) {
        aboutTaglineEl.textContent = info.tagline;
      }
      if (aboutFeaturesEl && Array.isArray(info.description)) {
        aboutFeaturesEl.textContent = '';
        info.description.forEach(function (line) {
          const li = document.createElement('li');
          li.textContent = line;
          aboutFeaturesEl.appendChild(li);
        });
      }
      if (aboutRuntimeEl) {
        const rt = info.runtime || {};
        const parts = [];
        if (rt.platform) parts.push(rt.platform === 'win32' ? 'Windows' : (rt.platform === 'darwin' ? 'macOS' : rt.platform));
        if (rt.arch) parts.push(rt.arch);
        if (rt.electron) parts.push('Electron ' + rt.electron);
        aboutRuntimeEl.textContent = parts.join(' · ') || '—';
      }
    } catch (e) {
      aboutLoaded = false;
      if (aboutVersionEl) aboutVersionEl.textContent = '读取失败';
    }
  }

  function renderUpdate(result) {
    if (!result) return;
    lastReleaseUrl = result.releaseUrl || '';
    if (updateCheckedAtEl && result.checkedAt) {
      updateCheckedAtEl.textContent = '上次检查：' + fmtDateTime(result.checkedAt);
    }

    if (result.status === 'outdated' && result.latestVersion) {
      setUpdateStatus('有新版本', 'warn');
      if (updateDetailEl) {
        updateDetailEl.textContent = 'v' + result.latestVersion + ' 已发布' +
          (result.publishedAt ? '（' + String(result.publishedAt).slice(0, 10) + '）' : '') + '，点这里查看。';
        updateDetailEl.classList.add('clickable');
      }
      if (aboutDot) aboutDot.hidden = false;
      return;
    }

    if (updateDetailEl) updateDetailEl.classList.remove('clickable');

    if (result.status === 'latest') {
      setUpdateStatus('已是最新', 'on');
      if (updateDetailEl) updateDetailEl.textContent = '当前 v' + result.currentVersion + ' 就是最新版本。';
      if (aboutDot) aboutDot.hidden = true;
      return;
    }

    const reasons = {
      NO_RELEASE: '仓库还没有发布版本。',
      TIMEOUT: '检查超时，可能网络不通。',
      BAD_TAG: '发布版本号格式不认识。',
      TLS_CERT: 'HTTPS 证书校验失败，可能有代理或加速器在中间拦截。'
    };
    setUpdateStatus('检查失败', '');
    if (updateDetailEl) {
      updateDetailEl.textContent = reasons[result.error] || ('检查失败：' + (result.error || '未知错误'));
    }
  }

  async function checkUpdate(manual) {
    if (updateRunning) return null;
    updateRunning = true;
    if (updateBtn) updateBtn.disabled = true;
    if (manual) setUpdateStatus('检查中…', '');
    try {
      // 手动点按钮带 force=1 绕过缓存；启动自动检查走缓存，避免重复打 GitHub
      const result = await devApi('/api/update/check' + (manual ? '?force=1' : ''));
      renderUpdate(result);
      if (manual && result.status === 'latest') toast('已经是最新版本 v' + result.currentVersion);
      return result;
    } catch (e) {
      setUpdateStatus('检查失败', '');
      if (updateDetailEl) updateDetailEl.textContent = '检查失败：' + e.message;
      if (manual) toast('检查更新失败');
      return null;
    } finally {
      updateRunning = false;
      if (updateBtn) updateBtn.disabled = false;
    }
  }

  // 发现新版本 → 主题弹窗（下载并安装 / 稍后 / 打开发布页），下载进度实时显示在关于页
  let updatePromptedThisRun = false;
  let updateDownloading = false;

  const updateModalEl = document.getElementById('updateModal');
  const updateModalTitleEl = document.getElementById('updateModalTitle');
  const updateModalMetaEl = document.getElementById('updateModalMeta');
  const updateModalNoteEl = document.getElementById('updateModalNote');
  const updateModalDownloadBtn = document.getElementById('updateModalDownload');
  const updateModalLaterBtn = document.getElementById('updateModalLater');
  const updateModalManualBtn = document.getElementById('updateModalManual');
  const updateModalCloseBtn = document.getElementById('updateModalClose');

  let updateModalResolve = null;

  function closeUpdateModal(choice) {
    if (updateModalEl) {
      updateModalEl.classList.remove('on');
      updateModalEl.setAttribute('aria-hidden', 'true');
    }
    const resolve = updateModalResolve;
    updateModalResolve = null;
    if (resolve) resolve(choice);
  }

  function openUpdateModal(result) {
    return new Promise(function (resolve) {
      if (!updateModalEl) { resolve('manual'); return; }

      updateModalResolve = resolve;

      if (updateModalTitleEl) updateModalTitleEl.textContent = '发现新版本 v' + result.latestVersion;
      if (updateModalMetaEl) {
        updateModalMetaEl.textContent = '当前版本 v' + result.currentVersion +
          (result.publishedAt ? '　·　发布于 ' + String(result.publishedAt).slice(0, 10) : '');
      }

      const hasAsset = !!(result.asset && result.asset.url);
      if (updateModalNoteEl) {
        updateModalNoteEl.textContent = hasAsset
          ? '下载完成后会自动启动安装程序。'
          : '这个版本没有可直接下载的安装包，请到发布页手动下载。';
      }
      if (updateModalDownloadBtn) updateModalDownloadBtn.hidden = !hasAsset;

      updateModalEl.classList.add('on');
      updateModalEl.setAttribute('aria-hidden', 'false');
    });
  }

  if (updateModalDownloadBtn) updateModalDownloadBtn.addEventListener('click', function () { closeUpdateModal('download'); });
  if (updateModalLaterBtn) updateModalLaterBtn.addEventListener('click', function () { closeUpdateModal('later'); });
  if (updateModalManualBtn) updateModalManualBtn.addEventListener('click', function () { closeUpdateModal('manual'); });
  if (updateModalCloseBtn) updateModalCloseBtn.addEventListener('click', function () { closeUpdateModal('later'); });
  if (updateModalEl) {
    updateModalEl.addEventListener('click', function (e) {
      if (e.target === updateModalEl) closeUpdateModal('later');
    });
  }

  async function promptUpdateFlow(result) {
    if (updateDownloading) return;
    if (!result || result.status !== 'outdated' || !result.latestVersion) return;

    const api = window.friendMakerWindow;
    const hasAsset = !!(result.asset && result.asset.url);

    // 非 Electron（浏览器直接打开）时退回打开发布页
    if (!api || typeof api.downloadUpdate !== 'function') {
      if (result.releaseUrl) window.open(result.releaseUrl, '_blank');
      return;
    }

    const choice = await openUpdateModal(result);

    if (choice === 'later') {
      toast('已跳过，可随时在「关于」页更新');
      return;
    }

    if (choice === 'manual') {
      if (result.releaseUrl) window.open(result.releaseUrl, '_blank');
      toast('已在浏览器打开发布页');
      return;
    }

    if (!hasAsset) {
      if (result.releaseUrl) window.open(result.releaseUrl, '_blank');
      return;
    }

    updateDownloading = true;
    if (updateBtn) updateBtn.disabled = true;

    try {
      const outcome = (await api.downloadUpdate({
        version: result.latestVersion,
        assetUrl: result.asset.url,
        assetName: result.asset.name
      })) || {};

      if (outcome.action === 'installed') {
        setUpdateStatus('已下载', 'on');
        if (updateDetailEl) updateDetailEl.textContent = '安装包已下载并启动，按提示完成安装即可。';
        toast('安装包已启动，按提示完成安装');
      } else if (outcome.action === 'busy') {
        toast('更新正在处理中，请稍候');
      } else if (outcome.action === 'error') {
        setUpdateStatus('更新失败', '');
        if (updateDetailEl) updateDetailEl.textContent = '更新失败：' + (outcome.error || '未知错误');
        toast('更新失败：' + (outcome.error || '未知错误'));
      }
    } catch (e) {
      setUpdateStatus('更新失败', '');
      if (updateDetailEl) updateDetailEl.textContent = '更新失败：' + e.message;
      toast('更新失败：' + e.message);
    } finally {
      updateDownloading = false;
      if (updateBtn) updateBtn.disabled = false;
    }
  }

  // 下载进度 → 关于页那行小字
  if (window.friendMakerWindow && typeof window.friendMakerWindow.onUpdateProgress === 'function') {
    window.friendMakerWindow.onUpdateProgress(function (p) {
      if (!p) return;
      const pct = typeof p.percent === 'number' ? p.percent : null;
      setUpdateStatus(pct === null ? '下载中…' : '下载中 ' + pct + '%', 'warn');
      if (updateDetailEl) {
        updateDetailEl.textContent = '正在下载 v' + (p.version || '') +
          (pct === null
            ? '：' + (p.received / 1048576).toFixed(1) + ' MB'
            : '：' + pct + '%（' + (p.received / 1048576).toFixed(1) + ' MB）');
      }
    });
  }

  /* ---------------- 更新日志 ---------------- */
  const changelogModalEl = document.getElementById('changelogModal');
  const changelogListEl = document.getElementById('changelogList');
  const changelogBtn = document.getElementById('changelogBtn');
  const changelogCloseEl = document.getElementById('changelogClose');

  const KIND_CLASS = { '新增': 'new', '修复': 'fix', '优化': 'improve', '说明': 'note' };
  let changelogLoaded = false;

  function renderChangelog(entries) {
    if (!changelogListEl) return;
    changelogListEl.textContent = '';

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'changelogEmpty';
      empty.textContent = '还没有更新记录';
      changelogListEl.appendChild(empty);
      return;
    }

    entries.forEach(function (entry) {
      const block = document.createElement('div');
      block.className = 'clEntry';

      const head = document.createElement('div');
      head.className = 'clVersion';
      const ver = document.createElement('b');
      ver.textContent = 'v' + String(entry.version || '');
      const date = document.createElement('span');
      date.textContent = String(entry.date || '');
      head.appendChild(ver);
      head.appendChild(date);
      block.appendChild(head);

      (Array.isArray(entry.items) ? entry.items : []).forEach(function (item) {
        const row = document.createElement('div');
        row.className = 'clItem';

        const tag = document.createElement('span');
        tag.className = 'clKind ' + (KIND_CLASS[item.kind] || 'note');
        tag.textContent = item.kind || '说明';

        const text = document.createElement('span');
        text.textContent = String(item.text || '');

        row.appendChild(tag);
        row.appendChild(text);
        block.appendChild(row);
      });

      changelogListEl.appendChild(block);
    });
  }

  async function loadChangelog() {
    if (changelogLoaded || !changelogListEl) return;
    try {
      const data = await devApi('/api/changelog');
      const entries = Array.isArray(data.entries) ? data.entries : [];
      renderChangelog(entries);
      changelogLoaded = true;
    } catch (e) {
      changelogListEl.textContent = '';
      const failed = document.createElement('div');
      failed.className = 'changelogEmpty';
      failed.textContent = '读取更新日志失败：' + e.message;
      changelogListEl.appendChild(failed);
    }
  }

  function openChangelog() {
    if (!changelogModalEl) return;
    changelogModalEl.classList.add('on');
    changelogModalEl.setAttribute('aria-hidden', 'false');
    loadChangelog();
  }

  function closeChangelog() {
    if (!changelogModalEl) return;
    changelogModalEl.classList.remove('on');
    changelogModalEl.setAttribute('aria-hidden', 'true');
  }

  if (changelogBtn) changelogBtn.addEventListener('click', openChangelog);
  if (changelogCloseEl) changelogCloseEl.addEventListener('click', closeChangelog);
  if (changelogModalEl) {
    changelogModalEl.addEventListener('click', function (e) {
      if (e.target === changelogModalEl) closeChangelog();
    });
  }

  if (updateBtn) {
    updateBtn.addEventListener('click', function () {
      checkUpdate(true).then(function (result) {
        if (result && result.status === 'outdated' && result.latestVersion) {
          promptUpdateFlow(result);
        }
      });
    });
  }

  if (updateDetailEl) {
    updateDetailEl.addEventListener('click', function () {
      if (lastReleaseUrl) window.open(lastReleaseUrl, '_blank');
    });
  }

  // 启动自动检查：延迟 1.5 秒静默进行；发现新版本就弹窗询问（本次运行只弹一次）
  window.setTimeout(function () {
    checkUpdate(false).then(function (result) {
      if (result && result.status === 'outdated' && result.latestVersion && !updatePromptedThisRun) {
        updatePromptedThisRun = true;
        promptUpdateFlow(result);
      }
    }).catch(function () {});
  }, 1500);

  window.__ocarina = {
    importMidi: function (buf) { importMidi(buf); },
    getNotes: function () { return notes.map(function (n) { return { midi: n.midi, col: n.col, len: n.len || 1, mapping: n.mapping }; }); },
    getState: function () { return { cols: cols, bpm: bpm, gridFactor: gridFactor, defaultLen: defaultLen, playStart: playStart }; },
    getCommands: function () { return buildCommands().lines.map(function (l) { return l.text; }); },
    buildKeysSvg: function () { return buildKeysSheetSvg(); }
  };
})();