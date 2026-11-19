'use strict';
/**
 * 内置手册映射测试（0.6.2）
 *
 * 重点守两件事：
 *  1) 每个章节锚点都必须真的存在于随包分发的 src/ui/manual.html；
 *  2) 自动检测 / 安装报错 / 用户手点三路入口都落到同一个正确章节。
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

const ROOT = path.join(__dirname, '..');
const manual = require(path.join(ROOT, 'src/core/manual'));
const html = fs.readFileSync(path.join(ROOT, 'src/ui/manual.html'), 'utf8');

console.log('\n[内置手册 · 锚点]');
test('Якорь каждой темы существует в поставляемом HTML', () => {
  for (const topic of Object.values(manual.TOPICS)) {
    assert(html.includes(`id="${topic.anchor}"`), `${topic.id} 的锚点 ${topic.anchor} 在手册里不存在`);
  }
});

test('Текст руководства содержит версию 0.6.2 и раздел про звук', () => {
  assert(html.includes('v0.6.2'), '手册应标注 v0.6.2');
  assert(html.includes('В приложении нет звука'), '手册应有声音排障章节');
  assert(html.includes('Встроенное руководство и автоуроки'), '手册应说明自动教程');
});

console.log('\n[内置手册 · 自动检测问题 → 章节]');
test('Проблема аппаратного ускорения ведёт к 6.1', () => {
  const t = manual.topicForIssue({ code: 'accel.softwareEmulation', title: '当前没有硬件加速' });
  assert(t.id === 'accel', `应定位到 accel，实际 ${t.id}`);
});

test('adb не авторизован ведёт к 6.4', () => {
  const t = manual.topicForIssue({ code: 'device.unauthorized', title: '安卓设备未授权调试' });
  assert(t.id === 'adb', `应定位到 adb，实际 ${t.id}`);
});

test('Отключение звука и остановка службы ведут к 6.7', () => {
  assert(manual.topicForIssue({ code: 'audio.disabled' }).id === 'sound', '声音开关应到 6.7');
  assert(manual.topicForIssue({ code: 'audio.windowsServiceStopped' }).id === 'sound', '音频服务应到 6.7');
});

test('Сбой запуска с логом ARM в первую очередь ведёт к 6.3', () => {
  const t = manual.topicForIssue({
    code: 'runtime.bootFailed',
    title: '安卓运行时上次启动失败',
    detail: 'DoBadTrampoline libndk_translation',
  });
  assert(t.id === 'arm', `应定位到 arm，实际 ${t.id}`);
});

test('Обычный сбой запуска ведёт к 6.5', () => {
  const t = manual.topicForIssue({ code: 'runtime.bootFailed', title: '启动失败', detail: 'cannot lock AVD' });
  assert(t.id === 'startup', `应定位到 startup，实际 ${t.id}`);
});

console.log('\n[内置手册 · 安装报错 → 章节]');
test('NO_MATCHING_ABIS ведёт к разделу ARM', () => {
  assert(manual.topicForError('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm', '应到 ARM 章节');
});

test('Прочие INSTALL_FAILED ведут к разделу установки', () => {
  assert(manual.topicForError('INSTALL_FAILED_INSUFFICIENT_STORAGE').id === 'install', '应到安装章节');
});

test('Исходные ошибки adb и звука ведут в разные разделы', () => {
  assert(manual.topicForError('ADB_UNAUTHORIZED').id === 'adb', 'adb 报错应到 6.4');
  assert(manual.topicForError('audio disabled -no-audio').id === 'sound', '声音报错应到 6.7');
});

console.log('\n[内置手册 · 统一入口]');
test('resolve принимает строку / issue / topic', () => {
  assert(manual.resolve('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm', '字符串应能识别');
  assert(manual.resolve({ issue: 'audio.disabled' }).id === 'sound', 'issue code 应能识别');
  assert(manual.resolve({ topic: 'overview', reason: 'toolbar' }).anchor, 'topic 应能识别');
});

test('Неизвестный ввод ведёт к оглавлению без исключения', () => {
  const r = manual.resolve({});
  assert(r.id === 'overview' && r.anchor, '应回目录页');
});

console.log('\n[内置手册 · 接线检查]');
test('Главный процесс регистрирует manual:open, preload отдаёт openManual', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  assert(/ipcMain\.handle\('manual:open'/.test(main), '主进程未注册 manual:open');
  assert(/openManual:\s*\(payload\)/.test(preload), 'preload 未暴露 openManual');
  assert(/new BrowserWindow\([\s\S]*manual\.html/.test(main), '主进程未创建手册窗口');
});

test('В заголовке и в разделе О программе есть вход в руководство', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/id="btnManual"/.test(html), '标题栏缺少手册按钮');
  assert(/id="btnOpenManual"/.test(html), '关于页缺少手册按钮');
  assert(/\$\('btnManual'\)\?\.addEventListener/.test(js), '标题栏按钮未绑定');
  assert(/\$\('btnOpenManual'\)\?\.addEventListener/.test(js), '关于页按钮未绑定');
});

test('Сбой установки и сбой исправления автоматически открывают нужный урок', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/openManualForError\(raw, 'install-failed'\)/.test(js), '安装失败未自动开教程');
  assert(/function failFix\([\s\S]*openManualForIssue\(issue, 'fix-failed'\)/.test(js), '修复失败未自动开教程');
  assert(/case 'audioService'/.test(js) && /case 'audio':/.test(js), '声音修复动作未接入');
});

test('Пункты диагностики имеют кнопку урока', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/class="dbg-help"/.test(js), '自动检测条目缺少教程按钮');
  assert(/class="ec-help"/.test(js), '自检条目缺少教程按钮');
});

console.log(`\n内置手册测试：${passed} 通过，${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
