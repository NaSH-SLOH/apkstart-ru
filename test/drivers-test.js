'use strict';
/**
 * 驱动（兼容补丁）扩展的纯 Node 测试：不需要 Electron、不需要模拟器、不需要联网。
 *
 * 这里守的是「用户写的 JSON 再野，也只能改白名单里的参数，不能在本机执行代码、
 * 不能删数据」这条底线，外加匹配 / 叠加 / 导入导出的行为。
 *
 * 运行：node test/drivers-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `apkstart-drv-${name}-`));
}

const HOST = {
  platform: 'win32',
  arch: 'x64',
  totalMB: 16384,
  cores: 8,
  gpuVendor: 'amd',
  gpuName: 'AMD Radeon 780M',
  cpuVendor: 'amd',
  osBuild: 22631,
  accel: 'whpx',
  emulatorVersion: '36.4.9',
};

const base = () => ({
  format: drivers.DRIVER_FORMAT,
  id: 'test-driver',
  name: '测试驱动',
  version: '1.0.0',
  match: { any: true },
  effect: { gpuMode: 'swangle' },
});

(() => {
  console.log('\n[驱动 · 校验]');

  test('Встроенные примеры проходят проверку (иначе пользователь скопирует ошибку)', () => {
    const dir = path.join(ROOT, 'src', 'drivers');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    assert.ok(files.length >= 3, `内置示例只有 ${files.length} 个`);
    for (const f of files) {
      const r = drivers.validateDriver(readJSON(path.join(dir, f)), { file: f });
      assert.equal(r.ok, true, `${f}: ${r.errors.join('；')}`);
    }
  });

  test('Неверный format отклоняется сразу', () => {
    const d = { ...base(), format: 'something-else' };
    const r = drivers.validateDriver(d);
    assert.equal(r.ok, false);
    assert.ok(/format/.test(r.errors.join('')));
  });

  test('id с обходом пути / пробелом отклоняется (при импорте id становится именем файла)', () => {
    for (const id of ['../evil', 'a b', 'x', 'name/../../etc/passwd']) {
      const r = drivers.validateDriver({ ...base(), id });
      assert.equal(r.ok, false, `id=${id} 竟然通过了`);
    }
  });

  test('Опечатка в ключе match даёт ошибку, а не тихо не работает', () => {
    const r = drivers.validateDriver({ ...base(), match: { gpu: 'amd' } });
    assert.equal(r.ok, false);
    assert.ok(/match\.gpu/.test(r.errors.join('')));
  });

  test('Опечатка в поле effect даёт ошибку', () => {
    const r = drivers.validateDriver({ ...base(), effect: { gpu: 'swangle' } });
    assert.equal(r.ok, false);
    assert.ok(/effect\.gpu/.test(r.errors.join('')));
  });

  console.log('\n[驱动 · 白名单（不许删数据 / 不许执行代码）]');

  test('Отклоняется -wipe-data (удалит приложения и сохранения пользователя)', () => {
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } });
    assert.equal(r.ok, false);
    assert.ok(/emulatorArgs: -wipe-data запрещён/.test(r.errors.join('')), r.errors.join('；'));
  });

  test('Отклоняются -partition-size / -datadir / -sysdir', () => {
    for (const a of ['-partition-size=8192', '-datadir=D:/x', '-sysdir=D:/y']) {
      const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: [a] } });
      assert.equal(r.ok, false, `${a} 竟然通过了`);
    }
  });

  test('-gpu принимает только известные бэкенды', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=host'] } }).ok, true);
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=../evil'] } });
    assert.equal(r.ok, false);
  });

  test('config.ini разрешает только ключи из белого списка (изменение раздела данных / размещения нельзя)', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle' } } }).ok, true);
    for (const k of ['disk.dataPartition.size', 'image.sysdir.1', 'hw.ramSize', 'hw.cpu.arch']) {
      const r = drivers.validateDriver({ ...base(), effect: { configIni: { [k]: '1' } } });
      assert.equal(r.ok, false, `${k} 竟然通过了`);
    }
  });

  test('Значения config.ini / env не содержат переводов строк (защита от внедрения строк)', () => {
    const a = drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle\nhw.ramSize=99999' } } });
    assert.equal(a.ok, false);
    const b = drivers.validateDriver({ ...base(), effect: { env: { ANDROID_X: 'a\nb' } } });
    assert.equal(b.ok, false);
  });

  test('env пропускает только префиксы ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { env: { ANDROID_EMU_BACKEND: 'x' } } }).ok, true);
    for (const k of ['PATH', 'SystemRoot', 'NODE_OPTIONS', 'LD_PRELOAD']) {
      const r = drivers.validateDriver({ ...base(), effect: { env: { [k]: 'x' } } });
      assert.equal(r.ok, false, `${k} 竟然通过了`);
    }
  });

  test('В модуле драйверов нет eval / new Function / динамического require файлов пользователя', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'drivers.js'), 'utf8');
    assert(!/\beval\s*\(/.test(src), '出现了 eval');
    assert(!/new\s+Function\s*\(/.test(src), '出现了 new Function');
    assert(!/require\s*\(\s*(raw|d\.|driver)/.test(src), '出现了按驱动内容 require');
  });

  console.log('\n[驱动 · 匹配]');

  test('gpuVendor совпадает / не совпадает', () => {
    assert.equal(drivers.matchHost({ gpuVendor: ['amd'] }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuVendor: ['nvidia'] }, HOST).ok, false);
  });

  test('gpuName проверяется регулярным выражением (без учёта регистра)', () => {
    assert.equal(drivers.matchHost({ gpuName: 'radeon\\s+780m' }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuName: 'geforce' }, HOST).ok, false);
  });

  test('Память / ядра / версия системы сопоставляются по диапазону', () => {
    assert.equal(drivers.matchHost({ totalMB: { min: 8192 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ totalMB: { max: 8192 } }, HOST).ok, false);
    assert.equal(drivers.matchHost({ cores: { min: 8 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 22000 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 30000 } }, HOST).ok, false);
  });

  test('Версия emulator сравнивается как число, а не как строка (36.4.9 < 36.4.10)', () => {
    const host = { ...HOST, emulatorVersion: '36.4.9' };
    assert.equal(drivers.matchHost({ emulatorVersion: { max: '36.4.10' } }, host).ok, true);
    assert.equal(drivers.matchHost({ emulatorVersion: { min: '36.4.10' } }, host).ok, false);
  });

  test('Сопоставление accel: машина без аппаратного ускорения получает только патч tcg', () => {
    const noHv = { ...HOST, accel: 'none' };
    assert.equal(drivers.matchHost({ accel: ['none'] }, noHv).ok, true);
    assert.equal(drivers.matchHost({ accel: ['none'] }, HOST).ok, false);
  });

  test('Пустой match / несовпадение не дают совпадения по умолчанию', () => {
    assert.equal(drivers.matchHost({}, HOST).ok, false);
    assert.equal(drivers.matchHost(null, HOST).ok, false);
  });

  console.log('\n[驱动 · 叠加与开关]');

  test('Встроенные примеры по умолчанию не действуют (enabled:false), включаются в интерфейсе', () => {
    const d = { ...drivers.validateDriver(readJSON(path.join(ROOT, 'src', 'drivers', 'example-amd-igpu-swangle.json'))).driver };
    const off = drivers.resolve({ drivers: [d], host: HOST });
    assert.equal(off.applied.length, 0, '内置示例默认就生效了');
    const on = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: true } });
    assert.equal(on.applied.length, 1);
    assert.equal(on.effect.gpuMode, 'swangle');
  });

  test('state=false перекрывает enabled:true из файла', () => {
    const d = drivers.validateDriver({ ...base(), enabled: true }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: false } });
    assert.equal(r.applied.length, 0);
  });

  test('Больший priority применяется позже (перекрывает прежние gpuMode / одноимённые параметры)', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', priority: 0, effect: { gpuMode: 'software', emulatorArgs: ['-gpu=software'] } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', priority: 10, effect: { gpuMode: 'swangle', emulatorArgs: ['-gpu=swangle'] } }).driver;
    const r = drivers.resolve({ drivers: [b, a], host: HOST });
    assert.equal(r.effect.gpuMode, 'swangle');
    const gpus = r.effect.args.filter((x) => x.flag === '-gpu');
    assert.equal(gpus.length, 1, '同一个参数被叠了两次');
    assert.equal(gpus[0].value, 'swangle');
  });

  test('ini / env объединяются, а не перекрывают объект целиком', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', effect: { configIni: { 'hw.gpu.mode': 'swangle' }, env: { ANDROID_AA: '1' } } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', effect: { configIni: { 'hw.keyboard': 'no' }, env: { ANDROID_BB: '2' } } }).driver;
    const r = drivers.resolve({ drivers: [a, b], host: HOST });
    assert.deepEqual(r.effect.ini, { 'hw.gpu.mode': 'swangle', 'hw.keyboard': 'no' });
    assert.deepEqual(r.effect.env, { ANDROID_AA: '1', ANDROID_BB: '2' });
  });

  test('notes содержат имя драйвера, в интерфейсе понятно, кто изменил', () => {
    const d = drivers.validateDriver({ ...base(), name: '老显卡补丁', effect: { notes: ['关掉硬件渲染'] } }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST });
    assert.deepEqual(r.effect.notes, ['老显卡补丁: 关掉硬件渲染']);
  });

  console.log('\n[驱动 · 读盘 / 导入 / 导出]');

  test('Битый файл только даёт ошибку и не мешает другим драйверам в каталоге', () => {
    const dir = tmpDir('load');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(base()));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 1);
    assert.equal(r.errors.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Файл больше 256 KB не читается как драйвер', () => {
    const dir = tmpDir('big');
    fs.writeFileSync(path.join(dir, 'big.json'), `{"pad":"${'x'.repeat(300 * 1024)}"}`);
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 0);
    assert.ok(/Файл слишком большой/.test(JSON.stringify(r.errors)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Импорт: после проверки сохраняется как <id>.json (имя файла не из ввода пользователя)', () => {
    const src = tmpDir('src');
    const dst = tmpDir('dst');
    const f = path.join(src, '随便叫什么.json');
    fs.writeFileSync(f, JSON.stringify(base()));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(path.basename(r.file), 'test-driver.json');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('Импорт: при неудачной проверке файл не записывается', () => {
    const src = tmpDir('src2');
    const dst = tmpDir('dst2');
    const f = path.join(src, 'bad.json');
    fs.writeFileSync(f, JSON.stringify({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } }));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, false);
    assert.equal(fs.readdirSync(dst).length, 0, '坏驱动被写进去了');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('Экспортированный шаблон машины сам является корректным драйвером', () => {
    const tpl = drivers.templateFromHost(HOST);
    const r = drivers.validateDriver(tpl);
    assert.equal(r.ok, true, r.errors.join('；'));
    assert.deepEqual(r.driver.match.gpuVendor, ['amd']);
  });

  console.log('\n[驱动 · 接进启动链路]');

  test('buildArgs / env / config.ini используют эффект драйвера', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(ROOT);
    emu._driverEffect = {
      gpuMode: 'swangle',
      forceTcg: true,
      args: [{ flag: '-feature', value: 'Vulkan' }, { flag: '-gpu', value: 'host' }],
      ini: { 'hw.gpu.mode': 'swangle', 'hw.audioInput': 'yes' },
      env: { ANDROID_EMU_TEST: '1' },
      notes: [],
    };
    const args = emu.buildArgs({ gpu: 'host', accel: 'auto', memoryMB: 4096, cores: 4 });
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at('-gpu'), 'swangle', '驱动没盖住 -gpu');
    assert.equal(at('-accel'), 'off', 'forceTcg 没转成 -accel off');
    assert.equal(args.filter((a) => a === '-gpu').length, 1, '-gpu 出现两次（驱动里那份没跳过）');
    assert.equal(at('-feature'), 'Vulkan');
    const env = emu.env(ROOT, { accel: 'off' });
    assert.equal(env.ANDROID_EMU_TEST, '1');
    const ini = emu._iniWithDrivers('hw.gpu.mode=host\nhw.keyboard=yes\n');
    assert(/hw\.gpu\.mode=swangle/.test(ini), 'ini 没被覆盖');
    assert(/hw\.audioInput=yes/.test(ini), 'ini 新键没追加');
    assert.equal((ini.match(/hw\.gpu\.mode=/g) || []).length, 1, 'ini 出现了重复键');
    emu._driverEffect = null;
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
