'use strict';
/**
 * 资源分配（内存 / CPU / 存储）的纯 Node 测试：不需要 Electron、不需要模拟器。
 *
 * 这一层的价值就是「填错也不出事」：用户随便填 32GB 内存、128GB 分区，
 * 保存前都要被收敛到宿主真的给得出的范围，否则表现是开机黑屏 / 装到一半失败，
 * 用户根本看不出是哪里错了。
 *
 * 运行：node test/resources-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  hostProfile, memoryLimits, clampMemoryMB, clampCores, memVerdict,
  diskRequiredMB, diskVerdict, diskLimits, clampDataGB, storageVerdict,
} = require('../src/core/resources');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const GB = 1024 * 1024 * 1024;

(() => {
  console.log('\n[资源分配 · 宿主能力]');

  test('hostProfile принимает внедрённые значения (тест не трогает реальную машину)', () => {
    const h = hostProfile({ totalMB: 32768, cores: 16 });
    assert.equal(h.totalMB, 32768);
    assert.equal(h.cores, 16);
  });

  test('hostProfile без значений не возвращает 0 ядер / NaN', () => {
    const h = hostProfile({});
    assert.ok(h.cores >= 1);
    assert.ok(Number.isFinite(h.totalMB));
  });

  test('Лимит памяти оставляет хосту 25%', () => {
    const lim = memoryLimits(32768);
    assert.equal(lim.maxMB, 24576, `32GB 宿主最多分 24GB，实际 ${lim.maxMB}`);
    assert.equal(lim.stepMB, 512);
    assert.equal(lim.minMB, 1024);
  });

  test('Если память хоста не читается, всё равно даётся консервативный лимит', () => {
    const lim = memoryLimits(0);
    assert.ok(lim.maxMB >= 4096 && lim.maxMB <= 16384);
  });

  console.log('\n[资源分配 · 内存收敛]');

  test('0 означает авто, возвращается как есть', () => {
    const r = clampMemoryMB(0, 32768);
    assert.equal(r.mb, 0);
    assert.equal(r.reason, 'auto');
  });

  test('Заполнено 3 GB — выравнивается по 512 MB до 3072', () => {
    const r = clampMemoryMB(3000, 32768);
    assert.equal(r.mb, 3072);
    assert.equal(r.capped, true);
  });

  test('Заполнено 64 GB — сжимается до лимита хоста с указанием причины', () => {
    const r = clampMemoryMB(64 * 1024, 32768);
    assert.equal(r.mb, 24576);
    assert.equal(r.capped, true);
    assert.ok(/максимум можно выделить 24 GB/.test(r.reason), r.reason);
  });

  test('Заполнено 128 MB — поднимается до минимального значения для запуска', () => {
    const r = clampMemoryMB(128, 32768);
    assert.equal(r.mb, 1024);
    assert.equal(r.capped, true);
  });

  test('Машина с 4 GB памяти не отдаёт все 4 GB Android', () => {
    const r = clampMemoryMB(4096, 4096);
    assert.equal(r.mb, 3072);
  });

  console.log('\n[资源分配 · CPU 收敛]');

  test('Машина с 16 ядрами получает максимум 15 ядер', () => {
    assert.equal(clampCores(16, 16).cores, 15);
  });

  test('Одноядерная машина всё равно получает 1 ядро', () => {
    assert.equal(clampCores(8, 1).cores, 1);
  });

  test('0 = авто', () => {
    assert.equal(clampCores(0, 8).cores, 0);
  });

  console.log('\n[资源分配 · 内存占比提示]');

  test('Слишком большой объём предупреждает о свопинге Windows', () => {
    const v = memVerdict(28672, 32768);
    assert.equal(v.level, 'insufficient');
    assert.ok(/свопинг/.test(v.note), v.note);
  });

  test('Нормальный диапазон не беспокоит пользователя', () => {
    assert.equal(memVerdict(8192, 32768).level, 'ok');
    assert.equal(memVerdict(8192, 32768).note, '');
  });

  test('Меньше 768 MB — не запустится', () => {
    assert.equal(memVerdict(512, 32768).level, 'insufficient');
  });

  console.log('\n[资源分配 · 存储]');

  test('Игра 50 GB оценивается как 1.8x + 2 GB резерва', () => {
    const need = diskRequiredMB(50 * GB);
    assert.equal(need, Math.ceil(50 * 1024 * 1.8) + 2048);
  });

  test('Лимит раздела с данными — 80% диска', () => {
    assert.equal(diskLimits(100 * 1024).maxGB, 80);
  });

  test('При 20 GB на диске нельзя указать раздел 64 GB', () => {
    const r = clampDataGB(64, 20 * 1024);
    assert.equal(r.gb, 16);
    assert.equal(r.capped, true);
    assert.ok(/свободно только 20\.0 GB/.test(r.reason), r.reason);
  });

  test('При достаточном месте раздел 64 GB разрешён', () => {
    const r = clampDataGB(64, 200 * 1024);
    assert.equal(r.gb, 64);
    assert.equal(r.capped, false);
  });

  test('При нехватке места storageVerdict сообщает, сколько не хватает', () => {
    const v = storageVerdict(30 * 1024, 50 * GB);
    assert.equal(v.ok, false);
    assert.ok(v.shortMB > 0);
    assert.ok(/не хватает/.test(v.note), v.note);
  });

  test('Если свободное место не читается, проверка пропускается, а не блокирует', () => {
    assert.equal(storageVerdict(0, 50 * GB).ok, true);
  });

  console.log('\n[资源分配 · 磁盘预检]');

  test('diskVerdict пропускает при достаточном месте', () => {
    const v = diskVerdict(200 * 1024, 100 * 1024);
    assert.equal(v.ok, true);
    assert.equal(v.message, '');
  });

  test('diskVerdict при нехватке места сообщает, сколько не хватает (с указанием диска среды выполнения)', () => {
    const v = diskVerdict(10 * 1024, 60 * 1024);
    assert.equal(v.ok, false);
    assert.ok(/Недостаточно места на диске/.test(v.message), v.message);
    assert.ok(/на диске со средой выполнения ApkStart/.test(v.message), v.message);
  });

  test('diskVerdict не блокирует, если свободное место не читается', () => {
    assert.equal(diskVerdict(0, 60 * 1024).ok, true);
  });

  test('Предварительная проверка для пакета 50 GB считается как 1.8x + 2 GB', () => {
    const need = diskRequiredMB(50 * GB);
    assert.ok(need > 85 * 1024 && need < 95 * 1024, `需要 ${need} MB`);
  });

  console.log('\n[资源分配 · 接线检查]');

  const builtinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'builtin.js'), 'utf8');
  test('Встроенный бэкенд тоже предоставляет resources()', () => {
    assert(/resources\(\) \{/.test(builtinSrc), 'builtin 缺少 resources()');
  });

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  test('Главный процесс ограничивает выход за границы и отдаёт обзор ресурсов', () => {
    assert(/sanitizeResourcePatch/.test(mainSrc), '保存设置时未收敛资源值');
    assert(/engine:resources/.test(mainSrc), '缺少 engine:resources IPC');
    assert(/runtime:resetAndResize/.test(mainSrc), '缺少重置+按新容量重建的通道');
    assert(!/mumuMemoryGB|mumuCores/.test(mainSrc), '主进程仍残留第三方底座的内存收敛逻辑');
  });

  const emulatorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
  test('quickboot с разностным диском честно сообщает об ошибке вместо ложного успеха при расширении на месте', () => {
    assert(/_hasDataOverlay/.test(emulatorSrc), '未检测 qcow2 差量盘');
    assert(/needsReset: true/.test(emulatorSrc), '扩容失败未标记 needsReset');
    assert(/fsGB/.test(emulatorSrc), 'dataInfo 未暴露文件系统实际大小');
  });

  const doctorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
  test('Лимиты памяти/ядер в авто-режиме зависят от хоста, а не жёстко 8 GB/8 ядер', () => {
    assert(/memoryLimits\(host\.totalMB\)/.test(doctorSrc), 'doctor 未按宿主收敛内存');
    assert(!/1536, 8192/.test(doctorSrc), 'doctor 仍在写死 8192 上限');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
