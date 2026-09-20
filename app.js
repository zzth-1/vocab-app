/* =========================================================
   四级核心4500 · 刷单词系统
   - 三种模式进度独立
   - 分组：每组 N 个单词，背完当前组才进入下一组
   - 同一单词的复习间隔跟随组大小（组大小 * 1.5，至少为组大小）
   - 连续 3 次正确 → 掌握
   - "已记住" → 直接按 3 次通过处理
   - 上一个/下一个回退（最多 30 步）、记录框（最多 150 条）
   - 记录框持久化到 localStorage（file:// 下也可用）
   - 分组按钮（显示 已掌握/组大小 + 浅蓝进度条）
   - 分组大小可选 20/50/75/100/150/自定义
   - 切换分组大小不破坏已掌握进度
   - 记忆模式回退到上一题时，重新显示三个按钮
     并高亮当时的选择，其他按钮可点击以“改判”
   - 本次修复：
     · A/D 在回看模式下能移动焦点
     · 原选择永久保留，只有进入下一题后才更新
     · 回看改判时：按一下空格 = 改判 + 进入下一个单词
     · 提示只显示“原选择”，不显示中间改判过程
   ========================================================= */

(function () {
  'use strict';

  // ============ 常量 ============
  const STORAGE_KEY        = 'cet4_progress_v6';
  const RECORD_STORAGE_KEY = 'cet4_records_v1';
  const GROUP_STORAGE_KEY  = 'cet4_group_size_v1';
  const THEME_STORAGE_KEY  = 'cet4_theme_v1';

  const MASTER_THRESHOLD   = 3;
  const COOLDOWN_MS        = 5000;
  const HISTORY_LIMIT      = 30;
  const RECORD_LIMIT       = 150;

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

  let history       = [];
  let historyIndex  = -1;
  let reviewMode    = false;

  // 回看模式下，改判完成后标记
  let reviewResolved = false;
  // 回看模式下的焦点：0=不记得 1=记得 2=已记住
  let reviewFocusIndex = 1;

  let records = [];

  // 分组状态
  let groupSize  = 50;
  let groupQueue = [];

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
  const groupBtn    = document.getElementById('groupBtn');
  const groupLabel  = document.getElementById('groupLabel');
  const groupProgressBg = document.getElementById('groupProgressBg');

  const groupModalOverlay = document.getElementById('groupModalOverlay');
  const groupOptions      = document.getElementById('groupOptions');
  const customRow         = document.getElementById('customRow');
  const customInput       = document.getElementById('customInput');
  const customConfirm     = document.getElementById('customConfirm');
  const groupModalClose   = document.getElementById('groupModalClose');
  const themeBtn          = document.getElementById('themeBtn');

  // =========================================================
  //  1. 初始化
  // =========================================================
  function init() {
    if (!window.WORDS || !window.WORDS.length) {
      card.innerHTML = `<div class="done">❌ 词库加载失败</div>`;
      return;
    }
    allWords = window.WORDS;

    const savedGroup = safeGet(GROUP_STORAGE_KEY);
    if (savedGroup) {
      const g = parseInt(savedGroup, 10);
      if (g > 0 && g <= allWords.length) groupSize = g;
    }

    const saved = safeGet(STORAGE_KEY);
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

    try {
      const savedRecords = safeGet(RECORD_STORAGE_KEY);
      records = savedRecords ? JSON.parse(savedRecords) : [];
      if (!Array.isArray(records)) records = [];
    } catch (e) {
      records = [];
    }

    // 加载主题
    const savedTheme = safeGet(THEME_STORAGE_KEY);
    if (savedTheme === 'dark') {
      document.body.classList.add('dark');
      updateThemeIcon();
    }

    resetQueue();
    bindEvents();
    renderRecords();
    updateGroupButton();
  }

    // ===== 主题切换 =====
  function updateThemeIcon() {
    if (!themeBtn) return;
    themeBtn.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  }

  function toggleTheme() {
    const isDark = document.body.classList.toggle('dark');
    safeSet(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
    updateThemeIcon();
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); }
    catch (e) { console.warn('读取 localStorage 失败', e); return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, val); return true; }
    catch (e) { console.warn('写入 localStorage 失败', e); return false; }
  }
  function safeRemove(key) {
    try { localStorage.removeItem(key); }
    catch (e) { console.warn('删除 localStorage 失败', e); }
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
    safeSet(STORAGE_KEY, JSON.stringify(map));
  }

  // =========================================================
  //  3. 分组核心逻辑
  // =========================================================
  function getMaxInterval() {
    return Math.max(groupSize, Math.round(groupSize * 1.5));
  }

  function getUnmasteredWords() {
    return words.filter(w => !w[mode].mastered);
  }

  function refreshGroupQueue() {
    if (!words.length) { groupQueue = []; return; }
    const unmastered = getUnmasteredWords();
    groupQueue = unmastered.slice(0, groupSize);
  }

function updateGroupButton() {
  if (!groupBtn) return;

  const total = words.length;
  const unmastered = getUnmasteredWords();
  const masteredTotal = total - unmastered.length;

  // 全部掌握
  if (unmastered.length === 0) {
    groupLabel.textContent = `${groupSize}/${groupSize}`;
    groupProgressBg.style.width = '100%';
    return;
  }

  // 当前组已掌握数 = 总已掌握数 % groupSize
  // 最后一组不足 groupSize 时，用该组的实际大小做分母
  let masteredInGroup = masteredTotal % groupSize;
  let currentGroupSize = groupSize;

  // 判断是否是最后一组（剩余单词数不足 groupSize）
  const remainingInCurrentGroup = Math.min(unmastered.length, groupSize);
  // 当前组的实际大小 = 该组开始时的大小
  // 即：本组开始时单词数 = remainingInCurrentGroup + masteredInGroup
  // 但如果 masteredInGroup + remainingInCurrentGroup < groupSize，
  // 说明本组是最后一组，实际组大小 = masteredInGroup + remainingInCurrentGroup
  const actualGroupSize = masteredInGroup + remainingInCurrentGroup;
  if (actualGroupSize < groupSize) {
    currentGroupSize = actualGroupSize;
  }

  groupLabel.textContent = `${masteredInGroup}/${currentGroupSize}`;

  const percent = currentGroupSize > 0
    ? (masteredInGroup / currentGroupSize) * 100
    : 0;
  groupProgressBg.style.width = percent + '%';
}
  function resetQueue() {
    refreshGroupQueue();
    queue = groupQueue.slice();
    shuffle(queue);
    memoryRevealed = false;
    questionCounter = 0;
    queue.forEach(w => { w[mode].lastSeen = -9999; });
    history = [];
    historyIndex = -1;
    reviewMode = false;
    reviewResolved = false;
    nextQuestion();
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function pickNext() {
    if (queue.length === 0) return null;
    const now = Date.now();
    const maxInterval = getMaxInterval();

    let overdue = null;
    for (const w of queue) {
      const st = w[mode];
      const gap = questionCounter - st.lastSeen;
      if (gap >= maxInterval) {
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
      const unmastered = getUnmasteredWords();
      if (unmastered.length > 0) {
        refreshGroupQueue();
        queue = groupQueue.slice();
        shuffle(queue);
        queue.forEach(w => { w[mode].lastSeen = -9999; });
        questionCounter = 0;

        if (queue.length > 0) {
          current = pickNext();
          if (current) {
            current[mode].lastSeen = questionCounter;
            questionCounter++;
          }
          memoryRevealed = false;
          historyIndex = history.length - 1;
          reviewMode = false;
          reviewResolved = false;
          pushSnapshot();
          render();
          updateGroupButton();
          return;
        }
      }

      current = null;
      historyIndex = -1;
      reviewMode = false;
      reviewResolved = false;
      render();
      updateGroupButton();
      return;
    }

    current = pickNext();
    if (current) {
      current[mode].lastSeen = questionCounter;
      questionCounter++;
    }
    memoryRevealed = false;
    historyIndex = history.length - 1;
    reviewMode = false;
    reviewResolved = false;
    pushSnapshot();
    render();
    updateGroupButton();
  }

  // =========================================================
  //  4. 历史快照
  // =========================================================
  function pushSnapshot() {
    if (!current) return;
    const snapshot = {
      wordId: current.id,
      word: current.word,
      pos: current.pos,
      meaning: current.meaning,
      mode: mode,
      revealed: false,
      userAnswer: null,
      result: null,
      userChoice: null,      // 原始选择，永久不变
      currentChoice: null,   // 当前生效的选择（改判会变）
      before: captureState(current, mode)
    };
    history.push({ snapshot, wordRef: current });
    if (history.length > HISTORY_LIMIT + 1) history.shift();
    historyIndex = history.length - 1;
  }

  function captureState(word, m) {
    const s = word[m];
    return {
      streak: s.streak,
      mastered: s.mastered,
      nextTime: s.nextTime
    };
  }

  function restoreState(word, m, before) {
    const s = word[m];
    s.streak = before.streak;
    s.mastered = before.mastered;
    s.nextTime = before.nextTime;
  }

  function updateCurrentSnapshot(patch) {
    if (historyIndex < 0 || historyIndex >= history.length) return;
    Object.assign(history[historyIndex].snapshot, patch);
  }

  function addRecord(word, result, userAnswer) {
    records.push({
      word: word.word,
      meaning: word.meaning,
      pos: word.pos,
      result,
      answer: userAnswer || '',
      time: Date.now()
    });
    if (records.length > RECORD_LIMIT) records.shift();
    safeSet(RECORD_STORAGE_KEY, JSON.stringify(records));
    renderRecords();
  }

  function removeLatestRecord(word) {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].word === word.word) {
        records.splice(i, 1);
        break;
      }
    }
    safeSet(RECORD_STORAGE_KEY, JSON.stringify(records));
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
      updateCurrentSnapshot({ result: 'master', userAnswer: userAnswer || null,
                              userChoice: 'master', currentChoice: 'master' });
      addRecord(current, 'master', userAnswer);
    } else {
      queue = queue.filter(w => w !== current);
      st.nextTime = 0;
      queue.push(current);
      updateCurrentSnapshot({ result: 'correct', userAnswer: userAnswer || null });
      addRecord(current, 'correct', userAnswer);
    }
    saveProgress();
    updateGroupButton();
    nextQuestion();
  }

  function markMastered() {
    const st = current[mode];
    st.streak = MASTER_THRESHOLD;
    st.mastered = true;
    queue = queue.filter(w => w !== current);
    updateCurrentSnapshot({ result: 'master', userChoice: 'master', currentChoice: 'master' });
    addRecord(current, 'master');
    saveProgress();
    updateGroupButton();
    nextQuestion();
  }

  function onRemember() {
    if (!current) return;
    const st = current.memory;
    st.streak++;
    if (st.streak >= MASTER_THRESHOLD) {
      st.mastered = true;
      queue = queue.filter(w => w !== current);
      updateCurrentSnapshot({ result: 'master', userChoice: 'remember', currentChoice: 'remember' });
      addRecord(current, 'master');
      saveProgress();
      updateGroupButton();
      nextQuestion();
    } else {
      st.nextTime = Date.now() + COOLDOWN_MS;
      queue = queue.filter(w => w !== current);
      queue.push(current);
      updateCurrentSnapshot({ result: 'correct', userChoice: 'remember', currentChoice: 'remember' });
      addRecord(current, 'correct');
      saveProgress();
      updateGroupButton();
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
    updateCurrentSnapshot({ result: 'wrong', userChoice: 'forget', currentChoice: 'forget' });
    addRecord(current, 'wrong');
    saveProgress();
    updateGroupButton();
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
    reviewResolved = false;

    // 只在进入回看时初始化焦点
    const snap = history[historyIndex].snapshot;
    if (snap.mode === 'memory') {
      const cur = snap.currentChoice || snap.userChoice;
      reviewFocusIndex =
        cur === 'forget'   ? 0 :
        cur === 'remember' ? 1 :
        cur === 'master'   ? 2 : 1;
    }

    renderSnapshot();
  }

  function goNext() {
    if (!reviewMode) return;
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    if (historyIndex >= history.length - 1) {
      reviewMode = false;
      reviewResolved = false;
      nextQuestion_Render();
    } else {
      reviewResolved = false;

      // 切到另一条回看时，同样初始化焦点
      const snap = history[historyIndex].snapshot;
      if (snap.mode === 'memory') {
        const cur = snap.currentChoice || snap.userChoice;
        reviewFocusIndex =
          cur === 'forget'   ? 0 :
          cur === 'remember' ? 1 :
          cur === 'master'   ? 2 : 1;
      }

      renderSnapshot();
    }
  }

  // 从回看状态直接跳到最新一题（把 currentChoice 同步回 userChoice）
  function exitReviewToLatest() {
    if (!reviewMode) return;

    // 把当前这条快照的 currentChoice 同步回 userChoice
    const entry = history[historyIndex];
    if (entry && entry.snapshot && entry.snapshot.mode === 'memory') {
      const snap = entry.snapshot;
      if (snap.currentChoice) {
        snap.userChoice = snap.currentChoice;
      }
    }

    historyIndex = history.length - 1;
    reviewMode = false;
    reviewResolved = false;
    nextQuestion_Render();
  }

  function nextQuestion_Render() {
    const last = history[history.length - 1];
    if (!last) { nextQuestion(); return; }
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

  // 记忆模式回退：渲染三按钮 + 高亮原选择 + 焦点 + 可改判
  function renderSnapshotContent(snap) {
    if (snap.mode === 'memory') {
      const origChoice = snap.userChoice;

      // 兼容旧数据
      if (origChoice === undefined || (origChoice === null && snap.result === null)) {
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
        return;
      }

      // selected = 原选择；focused = 当前焦点
      card.innerHTML = `
        <div class="word">${escapeHTML(snap.word)}</div>
        ${meaningHTML(snap)}
        <div class="mem-btns">
          <button class="btn-forget ${origChoice === 'forget' ? 'selected' : ''} ${reviewFocusIndex === 0 ? 'focused' : ''}" data-rechoice="forget" data-idx="0">不记得 <kbd>A</kbd></button>
          <button class="btn-remember ${origChoice === 'remember' ? 'selected' : ''} ${reviewFocusIndex === 1 ? 'focused' : ''}" data-rechoice="remember" data-idx="1">记得 <kbd>D</kbd></button>
          <button class="btn-master ${origChoice === 'master' ? 'selected' : ''} ${reviewFocusIndex === 2 ? 'focused' : ''}" data-rechoice="master" data-idx="2">已记住 <kbd>F</kbd></button>
        </div>
        <div class="hint-text">原选择：${
          origChoice === 'forget' ? '✖️ 不记得' :
          origChoice === 'remember' ? '✔️ 记得' :
          origChoice === 'master' ? '✅ 已记住' :
          '—'
        }</div>
      `;

      card.querySelectorAll('[data-rechoice]').forEach(btn => {
        btn.addEventListener('click', () => {
          reviewFocusIndex = parseInt(btn.dataset.idx, 10);
          rechoose(btn.dataset.rechoice);
        });
      });

      return;
    } else {
      const word = snap.word;
      const userAns = snap.userAnswer || word;
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

  // 在回看状态下改判：改判完成后立即退出回看到下一题
  function rechoose(newChoice) {
    if (!reviewMode) return;
    if (historyIndex < 0 || historyIndex >= history.length) return;

    const entry = history[historyIndex];
    const snap  = entry.snapshot;
    const word  = entry.wordRef;

    if (snap.mode !== 'memory') return;

    const cur = snap.currentChoice || snap.userChoice;

    // 如果和当前生效选择相同，直接退出到下一题
    if (cur === newChoice) {
      // 确保 userChoice 同步
      snap.currentChoice = newChoice;
      exitReviewToLatest();
      return;
    }

    // 1) 回滚该词到答题前状态
    restoreState(word, 'memory', snap.before);

    // 2) 从记录框里移除这道题最近的一条记录
    removeLatestRecord(word);

    // 3) 把该词按需放回 / 移出 queue
    const inQueue = queue.includes(word);
    if (!word.memory.mastered && !inQueue && groupQueue.includes(word)) {
      queue.push(word);
    }
    if (word.memory.mastered) {
      queue = queue.filter(w => w !== word);
    }

    // 4) 用新的选择重新执行判分
    const st = word.memory;
    if (newChoice === 'forget') {
      st.streak = 0;
      st.nextTime = 0;
      if (!queue.includes(word) && groupQueue.includes(word)) queue.push(word);
      snap.result = 'wrong';
      addRecord(word, 'wrong');
    } else if (newChoice === 'remember') {
      st.streak++;
      if (st.streak >= MASTER_THRESHOLD) {
        st.mastered = true;
        queue = queue.filter(w => w !== word);
        snap.result = 'master';
        addRecord(word, 'master');
      } else {
        st.nextTime = Date.now() + COOLDOWN_MS;
        if (!queue.includes(word) && groupQueue.includes(word)) queue.push(word);
        snap.result = 'correct';
        addRecord(word, 'correct');
      }
    } else if (newChoice === 'master') {
      st.streak = MASTER_THRESHOLD;
      st.mastered = true;
      queue = queue.filter(w => w !== word);
      snap.result = 'master';
      addRecord(word, 'master');
    }

    // 更新 currentChoice
    snap.currentChoice = newChoice;

    saveProgress();
    updateGroupButton();

    // ✨ 改判完成后立即退出回看到下一题
    // exitReviewToLatest 会把 currentChoice 同步回 userChoice
    exitReviewToLatest();
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
    updateGroupButton();

    if (!current && !reviewMode) {
      const unmastered = getUnmasteredWords();
      if (unmastered.length === 0) {
        card.innerHTML = `
          <div class="done">🎉 本模式全部完成！</div>
          <div class="done-sub">已掌握 ${total} 个单词，点击底部"重置进度"可重新开始</div>`;
      } else {
        card.innerHTML = `<div class="done">📚 分组切换中...</div>`;
      }
      return;
    }

    if (!current) return;

    if (mode === 'memory') renderMemory();
    else if (mode === 'spelling') renderSpelling();
    else renderCombo();
  }

  function updateNavButtons() {
    const canPrev = reviewMode
      ? historyIndex > 0
      : history.length >= 2;
    prevBtn.disabled = !canPrev;

    if (reviewMode) nextBtn.classList.add('show');
    else nextBtn.classList.remove('show');
  }

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
    if (!recordList) return;
    if (records.length === 0) {
      recordList.innerHTML = `<div style="padding:20px;color:#99a;text-align:center;font-size:13px;">暂无记录</div>`;
      return;
    }
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
  //  9. 分组设置弹窗
  // =========================================================
  function openGroupModal() {
    groupModalOverlay.style.display = 'flex';

    document.querySelectorAll('.group-opt').forEach(btn => {
      const size = btn.dataset.size;
      if (size !== 'custom' && parseInt(size, 10) === groupSize) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    const isCustom = ![20, 50, 75, 100, 150].includes(groupSize);
    if (isCustom) {
      document.querySelector('.group-opt[data-size="custom"]').classList.add('active');
      customRow.style.display = 'flex';
      customInput.value = groupSize;
    } else {
      customRow.style.display = 'none';
    }
  }

  function closeGroupModal() {
    groupModalOverlay.style.display = 'none';
  }

  function setGroupSize(newSize) {
    if (newSize === groupSize) { closeGroupModal(); return; }
    if (newSize <= 0) return;
    if (newSize > allWords.length) newSize = allWords.length;

    groupSize = newSize;
    safeSet(GROUP_STORAGE_KEY, String(groupSize));

    refreshGroupQueue();
    queue = groupQueue.slice();
    shuffle(queue);
    questionCounter = 0;
    queue.forEach(w => { w[mode].lastSeen = -9999; });
    history = [];
    historyIndex = -1;
    reviewMode = false;
    reviewResolved = false;
    memoryRevealed = false;

    if (queue.length > 0) {
      current = pickNext();
      if (current) {
        current[mode].lastSeen = questionCounter;
        questionCounter++;
      }
      pushSnapshot();
    } else {
      current = null;
    }
    render();
    updateGroupButton();
    closeGroupModal();
  }

  // =========================================================
  //  10. 事件
  // =========================================================
  function bindEvents() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === mode) return;
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        mode = btn.dataset.mode;
        resetQueue();
        updateGroupButton();
      });
    });

      // 主题切换
    if (themeBtn) {
      themeBtn.addEventListener('click', toggleTheme);
    }

    prevBtn.addEventListener('click', goPrev);
    nextBtn.addEventListener('click', goNext);

    recordBtn.addEventListener('click', toggleRecordPanel);
    recordClose.addEventListener('click', toggleRecordPanel);

    groupBtn.addEventListener('click', openGroupModal);
    groupModalClose.addEventListener('click', closeGroupModal);
    groupModalOverlay.addEventListener('click', (e) => {
      if (e.target === groupModalOverlay) closeGroupModal();
    });

    groupOptions.addEventListener('click', (e) => {
      const btn = e.target.closest('.group-opt');
      if (!btn) return;
      const size = btn.dataset.size;
      if (size === 'custom') {
        customRow.style.display = 'flex';
        customInput.focus();
        document.querySelectorAll('.group-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      } else {
        customRow.style.display = 'none';
        document.querySelectorAll('.group-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setGroupSize(parseInt(size, 10));
      }
    });

    customConfirm.addEventListener('click', () => {
      const val = parseInt(customInput.value, 10);
      if (val > 0 && val <= allWords.length) {
        setGroupSize(val);
      } else {
        alert('请输入有效的数字（1-' + allWords.length + '）');
      }
    });

    // ========== 全局键盘 ==========
    document.addEventListener('keydown', e => {
      // 通用：↑ / -  上一个，↓ / + / =  下一个
      if (e.key === 'ArrowUp' || e.key === '-') { e.preventDefault(); goPrev(); return; }
      if (e.key === 'ArrowDown' || e.key === '+' || e.key === '=') { e.preventDefault(); goNext(); return; }

      // Ctrl+R 记录框
      if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        toggleRecordPanel();
        return;
      }

      // 焦点在输入框时不处理记忆模式快捷键
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // 记忆模式：W = 上一个，S = 下一个（最新题无操作）
      if (mode === 'memory' && !reviewMode) {
        if (e.key.toLowerCase() === 'w') {
          e.preventDefault();
          goPrev();
          return;
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          return;
        }
      }

      // ========== 记忆模式回看状态的快捷键 ==========
      if (mode === 'memory' && reviewMode) {
        // A / ← → 焦点左移
        if (e.key.toLowerCase() === 'a' || e.key === 'ArrowLeft') {
          e.preventDefault();
          reviewFocusIndex = (reviewFocusIndex + 2) % 3;
          renderSnapshot();
          return;
        }
        // D / → → 焦点右移
        if (e.key.toLowerCase() === 'd' || e.key === 'ArrowRight') {
          e.preventDefault();
          reviewFocusIndex = (reviewFocusIndex + 1) % 3;
          renderSnapshot();
          return;
        }

        // 数字键 1/2/3 或 F 直接指定并改判（改判后立即退出）
        if (e.key === '1') { e.preventDefault(); rechoose('forget');   return; }
        if (e.key === '2') { e.preventDefault(); rechoose('remember'); return; }
        if (e.key.toLowerCase() === 'f' || e.key === '3') {
          e.preventDefault(); rechoose('master'); return;
        }

        // 回车 / 空格 / S → 确认当前焦点（改判并立即退出）
        if (e.key === 'Enter' || e.code === 'Space' || e.key.toLowerCase() === 's') {
          e.preventDefault();
          const target = ['forget', 'remember', 'master'][reviewFocusIndex];
          rechoose(target);
          return;
        }
        return;
      }

      // ========== 普通记忆模式（最新一题） ==========
      if (mode !== 'memory' || !current) return;

      if (e.code === 'Space' && !memoryRevealed) {
        e.preventDefault();
        memoryRevealed = true;
        renderMemory();
        return;
      }

      if (!memoryRevealed) return;

      if (e.key.toLowerCase() === 'a' || e.key === 'ArrowLeft' || e.key === '1') {
        e.preventDefault(); onForget(); return;
      }
      if (e.key.toLowerCase() === 'd' || e.key === 'ArrowRight' || e.key === '2') {
        e.preventDefault(); onRemember(); return;
      }
      // F = 已记住（S 已改为“下一个”）
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault(); markMastered(); return;
      }
    });

    card.addEventListener('click', e => {
      if (reviewMode) return;
      if (mode === 'memory' && current && !memoryRevealed) {
        if (e.target.tagName !== 'BUTTON') {
          memoryRevealed = true;
          renderMemory();
        }
      }
    });

    resetBtn.addEventListener('click', () => {
      if (!confirm('确定要重置当前模式（' + modeLabel(mode) + '）的进度吗？\n其他模式的进度不受影响。\n\n（答题记录也会一并清空）')) return;
      words.forEach(w => {
        w[mode].streak = 0;
        w[mode].mastered = false;
        w[mode].nextTime = 0;
        w[mode].lastSeen = -9999;
      });
      records = [];
      safeRemove(RECORD_STORAGE_KEY);
      saveProgress();
      refreshGroupQueue();
      resetQueue();
      renderRecords();
      updateGroupButton();
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