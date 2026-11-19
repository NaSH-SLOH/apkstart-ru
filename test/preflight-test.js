'use strict';
/**
 * 本机体检 / 自动配置的纯逻辑测试：不需要 Electron、不需要模拟器、不真的改系统。
 *
 * 守两件事：
 *   1. 结论必须和人话一致（BIOS 没开就说 BIOS，商店版不能自己提权就只给入口）；
 *   2. 自动配置只写「安全」的设置项，生成的驱动必须能过驱动校验。
 *
 * 运行：node test/preflight-test.js
 */
const assert = require('assert/strict');
const path = require('path');

const preflight = require('../src/core/preflight');
const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const hwBase = () => ({
  platform: 'win32',
  arch: 'x64',
  osBuild: 22631,
  cpu: {
    name: 'AMD Ryzen 7 7840HS', cores: 8, threads: 16,
    vtSupported: true, vtFirmware: true, slat: true,
  },
  memory: { totalMB: 32768, freeMB: 8192 },
  gpu: {
    name: 'AMD Radeon 780M', vendor: 'amd', vramMB: 2048,
    driverVersion: '31.0.12027.9001', driverDate: '2024-05-01', status: 'OK',
  },
  virtualization: {
    hypervisorPresent: true,
    hypervisorPlatform: 'enabled',
    vmPlatform: 'enabled',
    hyperV: 'disabled',
    winHvApi: true,
    vmCompute: true,
    aehdInstalled: false,
    accelOk: true,
    accelKind: 'whpx',
  },
});

const clone = (o) => JSON.parse(JSON.stringify(o));

(() => {
  console.log('\n[体检 · 资源推荐]');

  test('32 GB / 16 потоков: даёт 8 GB + 4 ядра', () => {
    const r = preflight.recommendResources({ totalMB: 32768, cores: 16, accelOk: true, vramMB: 2048 });
    assert.equal(r.memoryMB, 8192);
    assert.equal(r.cores, 4);
    assert.equal(r.renderSize, 'auto');
  });

  test('8 GB / 4 потока: даёт 3 GB + 2 ядра и не больше половины хоста', () => {
    const r = preflight.recommendResources({ totalMB: 8192, cores: 4, accelOk: true, vramMB: 1024 });
    assert.equal(r.memoryMB, 3072);
    assert.equal(r.cores, 2);
    assert.ok(r.memoryMB <= 8192 / 2);
  });

  test('При 4 GB памяти даёт только 2 GB, не задушит Windows', () => {
    const r = preflight.recommendResources({ totalMB: 4096, cores: 4, accelOk: false, vramMB: 256 });
    assert.equal(r.memoryMB, 2048);
    assert.equal(r.renderSize, '540x960', '没有加速时应该降分辨率');
  });

  test('Без ускорения → 540p; при малом объёме видеопамяти тоже → 540p', () => {
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: false, vramMB: 4096 }).renderSize, '540x960');
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: true, vramMB: 256 }).renderSize, '540x960');
  });

  console.log('\n[体检 · 渲染后端建议]');

  test('Без ускорения всегда software (сначала гарантируем картинку)', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: false, vramMB: 8192 }).gpuMode, 'software');
  });

  test('NVIDIA + ускорение → host; AMD/Intel → swangle', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: true, vramMB: 8192 }).gpuMode, 'host');
    assert.equal(preflight.recommendGpu({ vendor: 'amd', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
    assert.equal(preflight.recommendGpu({ vendor: 'intel', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
  });

  test('Если модель видеокарты не читается — не гадаем, возвращаем auto', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'unknown', accelOk: true, vramMB: 0 }).gpuMode, 'auto');
  });

  console.log('\n[体检 · 场景判断]');

  test('Всё в норме: level=good, рекомендуется host или swangle, TCG не навязывается', () => {
    const r = preflight.evaluate({ hw: hwBase(), settings: {} });
    assert.equal(r.level, 'good', r.summary);
    assert.equal(r.patch.engine.forceTcg, false);
    assert.equal(r.patch.engine.gpuMode, 'auto');
    assert.equal(r.recommended.gpuMode, 'swangle');
  });

  test('Виртуализация в BIOS выключена: вердикт bad, только ручная инструкция «зайти в BIOS», без обещаний в один клик', () => {
    const hw = hwBase();
    hw.cpu.vtFirmware = false;
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'bad');
    const item = r.items.find((i) => i.key === 'vt-bios-off');
    assert.ok(item, '缺少 BIOS 提示');
    assert.equal(item.action.kind, 'manual');
    assert.equal(r.patch.engine.forceTcg, true, 'BIOS 没开时应该锁软件模拟');
  });

  test('CPU не поддерживает виртуализацию: объясняется только программная эмуляция, без инструкции про BIOS', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = false;
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'vt-unsupported'));
    assert.ok(!r.items.some((i) => i.key === 'vt-bios-off'));
  });

  test('Компоненты Windows выключены + установочная версия: даётся «Включить в один клик (нужны права администратора)»', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.ok(item);
    assert.equal(item.action.kind, 'elevate');
    assert.equal(item.action.id, 'virtualization');
    assert.ok(/в один клик/.test(item.action.label));
  });

  test('Версия из магазина не может сама повысить права: для той же проблемы только открывается окно «Компоненты Windows»', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'store' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.equal(item.action.kind, 'elevate');
    assert.ok(/Компоненты Windows/.test(item.action.label), item.action.label);
    assert.ok(!/в один клик/.test(item.action.label));
  });

  test('Без ускорения + установочная версия: дополнительно даётся вход «Установить AEHD»', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.hypervisorPlatform = 'disabled';
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const accel = r.items.find((i) => i.key === 'accel-off');
    assert.equal(accel.action.id, 'accel');
  });

  test('Когда Hyper-V забирает VT, WMI с false не должен ошибочно давать «не поддерживается»', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = 'unknown';
    hw.cpu.vtFirmware = true;
    hw.cpu.slat = 'unknown';
    hw.virtualization.accelOk = true;
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'good', r.summary);
    assert.ok(!r.items.some((i) => i.key === 'vt-unsupported'));
  });

  test('Видеопамять не читается / видеокарта неизвестна: warn, но без фатального вывода', () => {
    const hw = hwBase();
    hw.gpu = { name: '', vendor: 'unknown', vramMB: 0, driverVersion: '', driverDate: '', status: '' };
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-unknown'));
    assert.equal(r.level, 'warn');
  });

  test('Устаревший драйвер вызывает напоминание об обновлении (частая причина чёрного экрана)', () => {
    const hw = hwBase();
    hw.gpu.driverDate = '2019-03-01';
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-driver-old'));
  });

  test('Мало памяти / старая система — отдельные подсказки', () => {
    const hw = hwBase();
    hw.memory.totalMB = 4096;
    hw.osBuild = 18363;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'mem-low'));
    assert.ok(r.items.some((i) => i.key === 'os-old'));
  });

  console.log('\n[体检 · 自动配置的边界]');

  test('Автоконфигурация пишет только безопасные настройки (не трогает раздел данных / режим разрешения)', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    assert.deepEqual(Object.keys(r.patch.engine).sort(),
      ['autoMemory', 'cores', 'forceTcg', 'gpuMode', 'memoryMB', 'renderSize'].sort());
  });

  test('Автосгенерированный драйвер проходит проверку, а match привязан к этой машине', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.deepEqual(v.driver.match.gpuVendor, ['amd']);
    assert.equal(v.driver.effect.gpuMode, 'swangle');
    assert.equal(v.driver.effect.forceTcg, null, '有加速时不该写 forceTcg');
  });

  test('Без ускорения сгенерированный драйвер фиксирует программную эмуляцию', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.equal(v.driver.effect.forceTcg, true);
    assert.equal(v.driver.effect.gpuMode, 'software');
  });

  test('Даже при сбое опроса нужен вывод (неизвестно ≠ падение)', () => {
    const r = preflight.evaluate({ hw: { platform: 'win32' } });
    assert.ok(['warn', 'bad'].includes(r.level));
    assert.ok(r.items.length >= 3);
    assert.equal(typeof r.summary, 'string');
  });

  test('collect() асинхронный (не блокирует интерфейс)', () => {
    assert.equal(preflight.collect.constructor.name, 'AsyncFunction');
  });

  test('Оценка — чистая функция: одинаковый вход даёт одинаковую конфигурацию', () => {
    const a = preflight.evaluate({ hw: {}, settings: {} });
    const b = preflight.evaluate({ hw: {}, settings: {} });
    assert.deepEqual(a.patch, b.patch);
    assert.deepEqual(a.driver, b.driver);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
