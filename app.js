/* =========================================================
   四级核心4500 · 刷单词系统
   - 三种模式进度独立
   - 同一单词在 100 题内必定复习一次
   - 连续 3 次正确 → 掌握
   - "已记住" → 直接按 3 次通过处理
   - 新增：上一个/下一个回退（最多 30 步）、记录框（最多 150 条）
   ========================================================= */

(function () {
  'use strict';

  // ============ 常量 ============
  const STORAGE_KEY      = 'cet4_progress_v6';
  const MASTER_THRESHOLD = 3;        // 连续正确次数 → 掌握
  const COOLDOWN_MS      = 5000;     // 记忆模式"记得"后冷却时间
  const MAX_INTERVAL     = 100;      // 同一单词最多间隔 100 题必出现
  const HISTORY_LIMIT    = 30;       // 最多回退 30 步
  const RECORD_LIMIT     = 150;      // 记录框最多 150 条

  const MODES = ['memory', 'spelling', 'combo'];

  // ============ 全局状态 ============
  let allWords    = [];
  let words       = [];
  let mode        = 'memory';
  let current     = null;
  let queue       = [];
  let memoryRevealed = false;
  let blankIndices   = [];
  let questionCounter = 0;

  // 历史记录
  let history       = [];       // 快照数组：[{ snapshot, wordRef }]
  let historyIndex  = -1;       // 当前查看的快照下标；-1 表示在"最新"
  let reviewMode    = false;    // 是否处于"回退查看"状态

  // 答题记录（用于左侧记录框）
  let records = [];             // 最新的在数组末尾（我们渲染时反转）

  // ============ DOM ============
  const card        = document.getElementById('card');
  const counterEl   = document.getElementById('counter');
  const progressBar = document.getElementById('progressBar');
  const statsEl     = document.getElementById('stats');
  const resetBtn    = document.getElementById('resetBtn');
  const prevBtn     = document.getElementById('prevBtn');
  const nextBtn     = document.getElementById('nextBtn');
  const recordBtn   = document.getElementById('recordBtn');
  const recordPanel = document.getElementById('recordPanel');
  const recordList  = document.getElementById('recordList');
  const recordClose = document.getElementById('recordClose');

  // =========================================================
  //  1. 初始化
  // =========================================================
  function init() {
    if (!window.WORDS || !window.WORDS.length) {
      card.innerHTML = `<div class="done">❌ 词库加载失败</div>`;
      return;
    }
    allWords = window.WORDS;

    const saved = localStorage.getItem(STORAGE_KEY);
    const map = saved ? JSON.parse(saved) : {};

    words = allWords.map(w => {
      const p = map[w.id] || {};
      return {
        id: w.id,
        word: w.word,
        pos: w.pos,
        meaning: w.meaning,
        memory:   normalizeState(p.memory),
        spelling: normalizeState(p.spelling),
        combo:    normalizeState(p.combo)
      };
    });

    resetQueue();
    bindEvents();
  }

  function normalizeState(s) {
    return {
      streak:   s && s.streak ? s.streak : 0,
      mastered: !!(s && s.mastered),
      nextTime: 0,
      lastSeen: -9999
    };
  }

  // =========================================================
  //  2. 持久化
  // =========================================================
  function saveProgress() {
    const map = {};
    words.forEach(w => {
      const out = {};
      let hasData = false;
      for (const m of MODES) {
        const s = w[m];
        if (s.streak > 0 || s.mastered) {
          out[m] = { streak: s.streak, mastered: s.mastered };
          hasData = true;
        }
      }
      if (hasData) map[w.id] = out;
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (e) { console.warn(e); }
  }

  // =========================================================
  //  3. 队列
  // =========================================================
  function resetQueue() {
    queue = words.filter(w => !w[mode].mastered);
    shuffle(queue);
    memoryRevealed = false;
    questionCounter = 0;
    queue.forEach(w => { w[mode].lastSeen = -9999; });
    history = [];
    historyIndex = -1;
    reviewMode = false;
    nextQuestion();
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function pickNext() {
    const now = Date.now();
    let overdue = null;
    for (const w of queue) {
      const st = w[mode];
      const gap = questionCounter - st.lastSeen;
      if (gap >= MAX_INTERVAL) {
        if (!overdue || st.lastSeen < overdue[mode].lastSeen) overdue = w;
      }
    }
    if (overdue) return overdue;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i][mode].nextTime <= now) return queue[i];
    }
    let earliest = queue[0];
    for (const w of queue) {
      if (w[mode].nextTime < earliest[mode].nextTime) earliest = w;
    }
    return earliest;
  }

  function nextQuestion() {
    if (queue.length === 0) {
      current = null;
      historyIndex = -1;
      reviewMode = false;
      render();
      return;
    }
    current = pickNext();
    current[mode].lastSeen = questionCounter;
    questionCounter++;
    memoryRevealed = false;
    // 进入新题：清空回退查看状态
    historyIndex = history.length - 1;
    reviewMode = false;
    // 保存"题目前"的快照
    pushSnapshot();
    render();
  }

  // =========================================================
  //  4. 历史快照
  // =========================================================
  /**
   * 每道题开始时保存一次快照，记录：
   *   - 单词 id（便于回看时定位）
   *   - 记忆模式下是否正确/是否已记住 等状态
   *   - 拼写/组合模式下用户输入的答案（答对后才有意义）
   */
  function pushSnapshot() {
    const snapshot = {
      wordId: current.id,
      word: current.word,
      pos: current.pos,
      meaning: current.meaning,
      mode: mode,
      // 记忆模式
      revealed: false,          // 是否已显示释义
      // 拼写/组合模式：用户作答内容
      userAnswer: null,         // 字符串，例如 "longthy"
      // 该快照时点的结果（答题后写入）
      result: null              // 'correct' | 'master' | 'wrong'
    };
    history.push({ snapshot, wordRef: current });
    // 保留最后 3 条（含当前）
    if (history.length > HISTORY_LIMIT + 1) {
      history.shift();
    }
    historyIndex = history.length - 1;
  }

  function updateCurrentSnapshot(patch) {
    if (historyIndex < 0 || historyIndex >= history.length) return;
    Object.assign(history[historyIndex].snapshot, patch);
  }

  // 记录到左侧记录框
  function addRecord(word, result, userAnswer) {
    records.push({
      word: word.word,
      meaning: word.meaning,
      pos: word.pos,
      result,               // 'correct' | 'master' | 'wrong'
      answer: userAnswer || '',
      time: Date.now()
    });
    if (records.length > RECORD_LIMIT) records.shift();
    renderRecords();
  }

  // =========================================================
  //  5. 掌握逻辑
  // =========================================================
  function markCorrect(userAnswer) {
    const st = current[mode];
    st.streak++;
    if (st.streak >= MASTER_THRESHOLD) {
      st.mastered = true;
      queue = queue.filter(w => w !== current);
      updateCurrentSnapshot({ result: 'master', userAnswer: userAnswer || null });
      addRecord(current, 'master', userAnswer);
    } else {
      queue = queue.filter(w => w !== current);
      st.nextTime = 0;
      queue.push(current);
      updateCurrentSnapshot({ result: 'correct', userAnswer: userAnswer || null });
      addRecord(current, 'correct', userAnswer);
    }
    saveProgress();
    nextQuestion();
  }

  function markMastered() {
    const st = current[mode];
    st.streak = MASTER_THRESHOLD;
    st.mastered = true;
    queue = queue.filter(w => w !== current);
    updateCurrentSnapshot({ result: 'master' });
    addRecord(current, 'master');
    saveProgress();
    nextQuestion();
  }

  function onRemember() {
    if (!current) return;
    const st = current.memory;
    st.streak++;
    if (st.streak >= MASTER_THRESHOLD) {
      st.mastered = true;
      queue = queue.filter(w => w !== current);
      updateCurrentSnapshot({ result: 'master' });
      addRecord(current, 'master');
      saveProgress();
      nextQuestion();
    } else {
      st.nextTime = Date.now() + COOLDOWN_MS;
      queue = queue.filter(w => w !== current);
      queue.push(current);
      updateCurrentSnapshot({ result: 'correct' });
      addRecord(current, 'correct');
      saveProgress();
      nextQuestion();
    }
  }

  function onForget() {
    if (!current) return;
    const st = current.memory;
    st.streak = 0;
    st.nextTime = 0;
    queue = queue.filter(w => w !== current);
    queue.push(current);
    updateCurrentSnapshot({ result: 'wrong' });
    addRecord(current, 'wrong');
    saveProgress();
    nextQuestion();
  }

  // =========================================================
  //  6. 上一个 / 下一个
  // =========================================================
  function goPrev() {
    if (history.length === 0) return;
    const target = reviewMode ? historyIndex - 1 : history.length - 2;
    if (target < 0) return;
    historyIndex = target;
    reviewMode = true;
    renderSnapshot();
  }

  function goNext() {
    if (!reviewMode) return;
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    if (historyIndex >= history.length - 1) {
      // 回到最新
      reviewMode = false;
      nextQuestion_Render();
    } else {
      renderSnapshot();
    }
  }

  // 回到最新题目（不重新入队，仅恢复当前词）
  function nextQuestion_Render() {
    const last = history[history.length - 1];
    current = last.wordRef;
    render();
  }

  function renderSnapshot() {
    const snap = history[historyIndex].snapshot;
    current = history[historyIndex].wordRef;
    reviewMode = true;
    updateNavButtons();
    renderSnapshotContent(snap);
  }

  function renderSnapshotContent(snap) {
    if (snap.mode === 'memory') {
      // 记忆模式：显示完整信息 + 结果徽章
      card.innerHTML = `
        <div class="word">${escapeHTML(snap.word)}</div>
        ${meaningHTML(snap)}
        <div class="hint-text">${
          snap.result === 'master' ? '✅ 已记住 / 已掌握' :
          snap.result === 'correct' ? '✔️ 记得' :
          snap.result === 'wrong' ? '✖️ 不记得' :
          '（答题中）'
        }</div>
      `;
    } else {
      // 拼写/组合：显示"答对时的样子"
      const word = snap.word;
      const userAns = snap.userAnswer || word;   // 无记录时按答对显示
      card.innerHTML = `
        ${meaningHTML(snap)}
        <div class="letters">
          ${word.split('').map((ch, i) => {
            const u = (userAns[i] || '').toLowerCase();
            const correct = u === ch.toLowerCase() || !u;
            return `<span class="letter ${correct ? 'correct' : 'wrong'}">${escapeHTML(ch)}</span>`;
          }).join('')}
        </div>
        <div class="hint-text">答题回看：${snap.result === 'master' ? '已掌握' : snap.result === 'correct' ? '正确' : '—'}</div>
      `;
    }
  }

  // =========================================================
  //  7. 渲染
  // =========================================================
  function remainingCount() {
    return words.filter(w => !w[mode].mastered).length;
  }

  function meaningHTML(w) {
    const pos = w.pos ? `<span class="pos">${escapeHTML(w.pos)}</span>` : '';
    return `<div class="meaning">${pos}${escapeHTML(w.meaning)}</div>`;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;',
      '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function render() {
    const remaining = remainingCount();
    const total = words.length;
    const done = total - remaining;
    counterEl.textContent = remaining;
    statsEl.textContent = `已掌握 ${done} / ${total}`;
    progressBar.style.width = total ? (done / total * 100) + '%' : '0%';

    updateNavButtons();

    if (!current && !reviewMode) {
      card.innerHTML = `
        <div class="done">🎉 本模式全部完成！</div>
        <div class="done-sub">已掌握 ${total} 个单词，点击底部"重置进度"可重新开始</div>`;
      return;
    }

    if (mode === 'memory') renderMemory();
    else if (mode === 'spelling') renderSpelling();
    else renderCombo();
  }

  function updateNavButtons() {
    // 上一个：只要有历史就能点（history.length >= 2 表示有上一题）
    const canPrev = reviewMode
      ? historyIndex > 0
      : history.length >= 2;
    prevBtn.disabled = !canPrev;

    // 下一个：只有 reviewMode 才显示
    if (reviewMode) {
      nextBtn.classList.add('show');
    } else {
      nextBtn.classList.remove('show');
    }
  }

  // ---------- 记忆模式 ----------
  function renderMemory() {
    card.innerHTML = `
      <div class="word">${escapeHTML(current.word)}</div>
      ${memoryRevealed
        ? meaningHTML(current) +
          `<div class="mem-btns">
             <button class="btn-forget" id="btnF">不记得 <kbd>←</kbd></button>
             <button class="btn-remember" id="btnR">记得 <kbd>→</kbd></button>
             <button class="btn-master" id="btnM">已记住</button>
           </div>`
        : `<div class="hint-text">按 <kbd>空格</kbd> 或点击屏幕显示释义</div>`}
    `;
    if (memoryRevealed) {
      document.getElementById('btnF').onclick = onForget;
      document.getElementById('btnR').onclick = onRemember;
      document.getElementById('btnM').onclick = markMastered;
      updateCurrentSnapshot({ revealed: true });
    }
  }

  // ---------- 拼写模式 ----------
  function renderSpelling() {
    const letters = current.word.split('');
    card.innerHTML = `
      ${meaningHTML(current)}
      <div class="letters" id="letters">
        ${letters.map((_, i) =>
          `<input class="letter" maxlength="1" data-i="${i}" inputmode="latin" autocomplete="off" spellcheck="false">`
        ).join('')}
      </div>
      <div class="hint-text">输入后按 <kbd>回车</kbd> 判断，全对进入下一题</div>
      <button class="btn-master" id="btnM">已记住（直接掌握）</button>
    `;
    document.getElementById('btnM').onclick = markMastered;
    bindLetterInputs();
  }

  // ---------- 组合模式 ----------
  function renderCombo() {
    const letters = current.word.split('');
    const len = letters.length;
    const blankCount = Math.max(1, Math.round(len * (0.3 + Math.random() * 0.2)));
    const idxs = [...Array(len).keys()];
    shuffle(idxs);
    blankIndices = idxs.slice(0, blankCount).sort((a, b) => a - b);

    card.innerHTML = `
      ${meaningHTML(current)}
      <div class="letters" id="letters">
        ${letters.map((ch, i) => {
          if (blankIndices.includes(i)) {
            return `<input class="letter" maxlength="1" data-i="${i}" inputmode="latin" autocomplete="off" spellcheck="false">`;
          }
          return `<span class="letter fixed">${escapeHTML(ch)}</span>`;
        }).join('')}
      </div>
      <div class="hint-text">补全缺失字母，按 <kbd>回车</kbd> 判断</div>
      <button class="btn-master" id="btnM">已记住（直接掌握）</button>
    `;
    document.getElementById('btnM').onclick = markMastered;
    bindLetterInputs();
  }

  // ---------- 输入框 ----------
  function bindLetterInputs() {
    const inputs = [...card.querySelectorAll('input.letter')];
    inputs.forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/[^a-zA-Z]/g, '').slice(-1);
        inp.classList.remove('wrong', 'correct');
        if (inp.value && idx < inputs.length - 1) inputs[idx + 1].focus();
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (inp.value) {
            inp.value = '';
            inp.classList.remove('wrong', 'correct');
          } else if (idx > 0) {
            const prev = inputs[idx - 1];
            prev.value = '';
            prev.classList.remove('wrong', 'correct');
            prev.focus();
          }
          return;
        }
        if (e.key === 'Delete') {
          inp.value = '';
          inp.classList.remove('wrong', 'correct');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          checkAnswer(inputs);
          return;
        }
        if (e.key === 'ArrowLeft' && idx > 0) { inputs[idx - 1].focus(); e.preventDefault(); }
        if (e.key === 'ArrowRight' && idx < inputs.length - 1) { inputs[idx + 1].focus(); e.preventDefault(); }
      });
      inp.addEventListener('focus', () => inp.select());
    });
    if (inputs.length) inputs[0].focus();
  }

  function checkAnswer(inputs) {
    if (!current) return;
    const word = current.word;
    let allCorrect = true;
    let userStr = '';
    inputs.forEach(inp => {
      const i = +inp.dataset.i;
      const val = inp.value.toLowerCase();
      userStr += val || '_';
      const target = word[i].toLowerCase();
      if (val !== target) {
        inp.classList.add('wrong');
        inp.classList.remove('correct');
        allCorrect = false;
      } else {
        inp.classList.remove('wrong');
        inp.classList.add('correct');
      }
    });
    updateCurrentSnapshot({ userAnswer: userStr });
    if (allCorrect) {
      setTimeout(() => markCorrect(userStr), 350);
    }
  }

  // =========================================================
  //  8. 记录框
  // =========================================================
  function renderRecords() {
    if (records.length === 0) {
      recordList.innerHTML = `<div style="padding:20px;color:#99a;text-align:center;font-size:13px;">暂无记录</div>`;
      return;
    }
    // 最新的在最上面
    const html = records.slice().reverse().map(r => {
      const statusClass = r.result === 'master' ? 'master' : r.result === 'correct' ? 'ok' : 'no';
      const statusText  = r.result === 'master' ? '✅ 已掌握' : r.result === 'correct' ? '✔️ 正确' : '✖️ 错误';
      return `
        <div class="record-item">
          <div class="r-word">${escapeHTML(r.word)}</div>
          <div class="r-meaning">${r.pos ? `<i>${escapeHTML(r.pos)}</i> ` : ''}${escapeHTML(r.meaning)}</div>
          <div class="r-status ${statusClass}">${statusText}</div>
        </div>
      `;
    }).join('');
    recordList.innerHTML = html;
  }

  function toggleRecordPanel() {
    const open = recordPanel.classList.toggle('open');
    recordBtn.classList.toggle('active', open);
    if (open) renderRecords();
  }
  // =========================================================
  //  9. 事件
  // =========================================================
  function bindEvents() {
    // Tab 切换
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === mode) return;
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        mode = btn.dataset.mode;
        resetQueue();
      });
    });

    // 上一个 / 下一个 按钮
    prevBtn.addEventListener('click', goPrev);
    nextBtn.addEventListener('click', goNext);

    // 记录框
    recordBtn.addEventListener('click', toggleRecordPanel);
    recordClose.addEventListener('click', toggleRecordPanel);

    // 全局键盘
    document.addEventListener('keydown', e => {
      // ========== 上一个 / 下一个（两套快捷键）==========
      // 上一页：↑ 或 -
      if (e.key === 'ArrowUp' || e.key === '-') {
        e.preventDefault();
        goPrev();
        return;
      }
      // 下一页：↓ 或 + 或 =
      if (e.key === 'ArrowDown' || e.key === '+' || e.key === '=') {
        e.preventDefault();
        goNext();
        return;
      }

      // ========== 记录框开关：Ctrl+R ==========
      if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        toggleRecordPanel();
        return;
      }

      // ========== 记忆模式快捷键 ==========
      if (mode !== 'memory' || !current || reviewMode) return;

      if (e.code === 'Space' && !memoryRevealed) {
        e.preventDefault();
        memoryRevealed = true;
        renderMemory();
      } else if (memoryRevealed && e.key === 'ArrowLeft') {
        e.preventDefault();
        onForget();
      } else if (memoryRevealed && e.key === 'ArrowRight') {
        e.preventDefault();
        onRemember();
      } else if (memoryRevealed && e.key === '1') {
        onForget();
      } else if (memoryRevealed && e.key === '2') {
        onRemember();
      } else if (memoryRevealed && e.key === '3') {
        markMastered();
      }
    });

    // 点击屏幕显示释义（记忆模式）
    card.addEventListener('click', e => {
      if (reviewMode) return;
      if (mode === 'memory' && current && !memoryRevealed) {
        if (e.target.tagName !== 'BUTTON') {
          memoryRevealed = true;
          renderMemory();
        }
      }
    });

    // 重置
    resetBtn.addEventListener('click', () => {
      if (!confirm('确定要重置当前模式（' + modeLabel(mode) + '）的进度吗？\n其他模式的进度不受影响。')) return;
      words.forEach(w => {
        w[mode].streak = 0;
        w[mode].mastered = false;
        w[mode].nextTime = 0;
        w[mode].lastSeen = -9999;
      });
      records = [];
      saveProgress();
      resetQueue();
      renderRecords();
    });
  }
  function modeLabel(m) {
    return { memory: '记忆模式', spelling: '拼写模式', combo: '组合模式' }[m] || m;
  }

  // =========================================================
  //  启动
  // =========================================================
  document.addEventListener('DOMContentLoaded', init);

})();