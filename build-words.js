// Node.js 运行：node build-words.js
const fs = require('fs');

const raw = fs.readFileSync('四级核心4500词汇.txt', 'utf-8');
const words = [];

raw.split(/\r?\n/).forEach((line, lineNo) => {
  line = line.trim();
  if (!line.startsWith('|')) return;

  // 去掉首尾的 | ，再按 | 分割
  let cols = line.replace(/^\||\|$/g, '').split('|').map(s => s.trim());

  // 跳过表头 / 分隔线
  if (cols.length < 4) return;
  if (!/^\d+$/.test(cols[0])) return;

  const idx = parseInt(cols[0]);
  const word = cols[1];
  let pos = cols[2] || '';
  let meaning = cols.slice(3).join('|').trim();  // 关键：合并多余列

  if (!word || !meaning) return;

  // 清理常见的脏数据
  // 1) 释义里去掉 "中文释义:" 前缀
  meaning = meaning.replace(/^中文释义[:：]?\s*/, '');
  // 2) 词性里去掉异常字符，保留字母和点
  pos = pos.replace(/[^a-z.\s]/gi, '').trim();
  // 3) 如果词性为空但释义开头是 "n. / v. / adj." 等，尝试提取
  if (!pos) {
    const m = meaning.match(/^([a-z]+\.)\s*/i);
    if (m) {
      pos = m[1];
      meaning = meaning.slice(m[0].length).trim();
    }
  }

  words.push({
    id: idx,
    word: word,
    pos: pos,
    meaning: meaning
  });
});

// 输出为 words.js（window.WORDS）
const output = 'window.WORDS = ' + JSON.stringify(words) + ';';
fs.writeFileSync('words.js', output, 'utf-8');

console.log('✅ 转换完成');
console.log('   有效词数:', words.length);
console.log('   输出文件: words.js');

// 简单报告几个可能异常的条目
const suspicious = words.filter(w => !w.pos);
if (suspicious.length) {
  console.log('\n⚠️ 以下条目没有词性（共 ' + suspicious.length + ' 条），前 10 条:');
  suspicious.slice(0, 10).forEach(w => console.log('   -', w.id, w.word, '|', w.meaning.slice(0, 30)));
}