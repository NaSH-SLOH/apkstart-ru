'use strict';
/**
 * 自动检测（自动 debug）内核
 *
 * 分两层，刻意分开：
 *   1) 采集层（src/core/autodebug-probe.js，主进程）：把机器真实状态采成一份纯数据快照 obs；
 *   2) 判定层（本文件，纯函数）：evaluate(obs) → issues[]。
 *
 * 判定层不碰 fs / child_process / electron，CI 可以直接 require 并单测
 * （教训见记忆 2026-11-17：CI 上 require 顶层依赖 electron 的模块会全红）。
 * 唯一额外依赖是同目录的 manual.js（纯映射表），用来把问题直接指到内置教程章节。
 *
 * 一条铁律：obs 里没有的字段一律当作「不知道」，不能因为探测失败就报问题。
 * 误报比漏报更伤用户信任 —— 用户一旦发现弹出来的「检测结果」是假的，
 * 就再也不会相信自动检测给出的任何结论了。
 */

const manual = require('./manual');

/** 问题分类（设置页按这个顺序分组展示） */
const CATEGORIES = [
  { id: 'runtime', name: 'Среда выполнения', hint: 'Процессы виртуальной машины Android, этап запуска, снимки и остаточные блокировки' },
  { id: 'device', name: 'Подключение устройства', hint: 'Состояние авторизации adb, доступность устройства' },
  { id: 'storage', name: 'Хранилище', hint: 'Свободное место на диске, раздел данных, общая папка' },
  { id: 'settings', name: 'Настройки', hint: 'Конфликты и взаимное исключение между параметрами' },
  { id: 'network', name: 'Сеть', hint: 'Сеть Android и доступность источников загрузки' },
  { id: 'logs', name: 'Журнал', hint: 'Ошибки в журнале работы' },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** 严重度排序：数字越大越严重 */
const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };

/** 归一化一条问题，保证 UI 拿到的字段永远齐全 */
function normalise(raw) {
  if (!raw || !raw.code) return null;
  const severity = SEVERITY_RANK[raw.severity] ? raw.severity : 'info';
  const item = {
    code: String(raw.code),
    category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'runtime',
    severity,
    title: String(raw.title || raw.code),
    hint: String(raw.hint || ''),
    // fix 是「一键修复」的动作名，由渲染层映射到具体操作；没有就留空
    fix: raw.fix || '',
    // detail 是给人看的补充信息（路径、数值等），不进标题
    detail: raw.detail === undefined || raw.detail === null ? '' : String(raw.detail),
  };
  // 0.6.2：每条问题都自带「教程」目标，渲染层不用再复制一份故障分类表
  item.help = manual.topicForIssue(item);
  return item;
}

/**
 * 判定：把观测快照变成问题列表
 * @param {object} obs 采集层给出的快照（字段可缺省）
 * @returns {Array<object>} 归一化后的问题列表
 */
function evaluate(obs) {
  const o = obs || {};
  const runtime = o.runtime || {};
  const device = o.device || {};
  const storage = o.storage || {};
  const settings = o.settings || {};
  const network = o.network || {};
  const logs = o.logs || {};
  const accel = o.accel || {};
  const out = [];

  const push = (raw) => {
    const it = normalise(raw);
    if (it) out.push(it);
  };

  /* ---------------- 运行时 ---------------- */

  // 开机失败：直接给最后一条真实原因，别让用户猜
  const bootError = runtime.error || (runtime.lastFailure && runtime.lastFailure.error) || '';
  if (bootError) {
    push({
      code: 'runtime.bootFailed',
      category: 'runtime',
      severity: 'error',
      title: 'Предыдущий запуск среды выполнения Android завершился ошибкой',
      hint: 'Фактическая ошибка среды выполнения получена; устранение этой причины обычно восстанавливает работу с первой попытки.',
      detail: bootError,
      fix: 'restartRuntime',
    });
  }

  // 一直卡在引导中：超过阈值还没 ready，多半是快照坏了或镜像有问题
  if (runtime.running && runtime.phase && runtime.phase !== 'ready' && runtime.bootMs > 150000) {
    push({
      code: 'runtime.stuckBoot',
      category: 'runtime',
      severity: 'warn',
      title: 'Запуск Android зависает на этапе загрузки',
      hint: 'Загрузка идёт уже более 2,5 мин, но система не запустилась. Обычная причина — повреждённый снимок быстрого запуска; перезапуск среды выполнения (с холодным запуском) обычно помогает.',
      detail: `Этап: ${runtime.phase}`,
      fix: 'restartRuntime',
    });
  }

  // 残留锁文件：会让下次启动被判成「AVD 已被占用」直接 FATAL
  if (Number(runtime.locks) > 0) {
    push({
      code: 'runtime.staleLocks',
      category: 'runtime',
      severity: 'warn',
      title: `Обнаружено файлов блокировки от прошлого запуска: ${runtime.locks}`,
      hint: 'Неочищенные файлы блокировки приводят к тому, что следующий запуск сразу завершается ошибкой «AVD уже занят». Можно очистить в один клик.',
      fix: 'lock',
    });
  }

  // 孤儿进程：emulator.exe 只是启动器，qemu 是 detached 的独立进程，
  // 只杀启动器会留下孤儿占着 multiinstance.lock（记忆 2026-11-13）。
  if (Number(runtime.orphans) > 0) {
    push({
      code: 'runtime.orphanProcesses',
      category: 'runtime',
      severity: 'warn',
      title: `Остаточных процессов эмулятора: ${runtime.orphans}`,
      hint: 'Процессы Android, не завершённые при прошлом выключении, всё ещё удерживают ресурсы и блокировку AVD, из-за чего следующий запуск может завершиться ошибкой. Можно выполнить очистку в один клик (установленные приложения и сохранения не затрагиваются).',
      fix: 'orphans',
    });
  }

  // 快照空壳：文件在但校验不过，每次开机都要「加载失败再冷启动」，等于白留了几 GB
  if (runtime.snapshotStale) {
    push({
      code: 'runtime.staleSnapshot',
      category: 'runtime',
      severity: 'warn',
      title: 'Снимок быстрого запуска повреждён',
      hint: 'Файл снимка существует, но не проходит проверку, поэтому при каждом запуске системы выполняется дополнительный холодный запуск. Его удаление вернёт место на диске ценой одного холодного запуска.',
      fix: 'snapshots',
    });
  }

  /* ---------------- 设备连接 ---------------- */

  // unauthorized：安卓弹了「允许 USB 调试吗」但没人点（记忆 2026-11-17 的老坑）
  if (device.state === 'unauthorized') {
    push({
      code: 'device.unauthorized',
      category: 'device',
      severity: 'error',
      title: 'Устройство Android не авторизовано для отладки',
      hint: 'На стороне Android появлялся запрос «Разрешить отладку по USB», но не был подтверждён, поэтому adb не подключается. Перезапуск среды выполнения (с холодным запуском) снова покажет запрос; после подтверждения всё восстановится.',
      fix: 'restartRuntime',
    });
  } else if (device.state === 'offline') {
    push({
      code: 'device.offline',
      category: 'device',
      severity: 'warn',
      title: 'Устройство Android в состоянии offline',
      hint: 'adb видит устройство, но не подключается: обычно виртуальная машина ещё загружается или служба adb не завершила рукопожатие. Если через некоторое время не восстановится, перезапустите среду выполнения.',
      fix: 'restartRuntime',
    });
  } else if (runtime.running && device.checked && device.state === 'no-device') {
    push({
      code: 'device.missing',
      category: 'device',
      severity: 'warn',
      title: 'Среда выполнения работает, но adb не видит устройство',
      hint: 'Процессы Android работают, но adb не видит устройство: скорее всего, порт службы adb занят другой программой или загрузка ещё не завершена.',
      fix: 'restartRuntime',
    });
  }

  /* ---------------- 存储 ---------------- */

  const freeMB = Number(storage.freeMB) || 0;
  if (freeMB > 0 && freeMB < 2048) {
    push({
      code: 'storage.diskCritical',
      category: 'storage',
      severity: 'error',
      title: 'Диск со средой выполнения почти заполнен',
      hint: 'Свободно менее 2 GB: установка приложений и запись снимков будут завершаться ошибкой. Нажмите «Очистка в один клик», чтобы освободить старые образы, снимки и журналы.',
      detail: `Осталось ${freeMB} MB`,
      fix: 'disk',
    });
  } else if (freeMB > 0 && freeMB < 8192) {
    push({
      code: 'storage.diskLow',
      category: 'storage',
      severity: 'warn',
      title: 'На диске со средой выполнения мало места',
      hint: 'Свободно менее 8 GB, а для снимков и образа системы ещё нужно место. Рекомендуется сначала один раз очистить освобождаемые файлы.',
      detail: `Осталось ${freeMB} MB`,
      fix: 'disk',
    });
  }

  // 数据分区实际容量比配置小 → 装的游戏会提示「存储空间不足」
  if (storage.needsReset) {
    push({
      code: 'storage.dataNeedsReset',
      category: 'storage',
      severity: 'warn',
      title: 'Увеличение раздела данных не вступило в силу',
      hint: 'Дифференциальный диск быстрого запуска мешает увеличению объёма на месте, и в guest виден прежний объём. Нужно «Сбросить данные Android» и пересоздать раздел с новым объёмом (установленные приложения будут удалены).',
      detail: `Конфигурация ${storage.configuredGB} GB · фактически ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  } else if (Number(storage.configuredGB) > 0 && Number(storage.actualGB) > 0
    && Number(storage.configuredGB) > Number(storage.actualGB)) {
    push({
      code: 'storage.dataMismatch',
      category: 'storage',
      severity: 'error',
      title: 'Раздел данных Android меньше заданного в конфигурации',
      hint: 'Фактически доступный объём в Android меньше указанного в настройках, поэтому при установке больших игр появляется сообщение о нехватке места.',
      detail: `Конфигурация ${storage.configuredGB} GB · фактически ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  }

  if (storage.sharedOk === false) {
    push({
      code: 'storage.sharedBroken',
      category: 'storage',
      severity: 'warn',
      title: 'Общая папка недоступна',
      hint: 'Локальная папка для обмена файлами не существует или недоступна для записи, поэтому сохранённые в Android файлы не синхронизируются.',
      detail: storage.sharedPath || '',
      fix: 'shared',
    });
  }

  /* ---------------- 设置 ---------------- */

  // 方向策略与物理面板打架 → 安卓只给应用中间一条窄画面（记忆 2026-11-18 的老坑）
  const mode = String(settings.orientationMode || 'auto');
  if (mode === 'portrait' && settings.landscape === true) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Политика ориентации экрана противоположна текущей ориентации панели',
      hint: 'Политика требует портретной ориентации, а панель сейчас в альбомной: Android даст приложению узкую полосу с чёрными полями по бокам. Приведите ориентацию панели в соответствие с политикой.',
      fix: 'orientation',
    });
  } else if (mode === 'landscape' && settings.landscape === false) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Политика ориентации экрана противоположна текущей ориентации панели',
      hint: 'Политика требует альбомной ориентации, а панель сейчас в портретной: видео и игры будут узкой вертикальной полосой. Приведите ориентацию панели в соответствие с политикой.',
      fix: 'orientation',
    });
  }

  if (settings.windowEmbed === false && settings.autoFullscreen) {
    push({
      code: 'settings.detachedFullscreen',
      category: 'settings',
      severity: 'info',
      title: 'В режиме нативного окна «Автоматический полноэкранный режим при запуске» не действует',
      hint: 'Нативное окно создаёт сам эмулятор, и полноэкранный режим он определяет сам — переключатель здесь на это не влияет. Чтобы развернуть на весь экран, нажмите F11 в окне или смените способ размещения окна на встроенный режим.',
    });
  }

  if (settings.keepSnapshot === false && freeMB > 0 && freeMB < 4096) {
    push({
      code: 'settings.snapshotOffLowDisk',
      category: 'settings',
      severity: 'info',
      title: 'Мало места на диске, снимок быстрого запуска отключён',
      hint: 'Свободно менее 4 GB, а снимки отключены: при открытии приложения выполняется полный холодный запуск (более десяти секунд). Если места на диске достаточно, снова включите снимки.',
      fix: 'settings',
    });
  }

  /* ---------------- 声音 ---------------- */

  // 0.6.2 新增：用户反馈「有的应用没声音」时，第一反应往往是系统音量问题，
  // 实际上最常见是引擎开关被关掉（-no-audio）或 Windows Audio 服务被停了。
  const audio = o.audio || {};
  if (audio.checked && audio.enabled === false) {
    push({
      code: 'audio.disabled',
      category: 'settings',
      severity: 'warn',
      title: 'Звук Android-приложений отключён в настройках',
      hint: 'Эмулятор запущен с -no-audio, поэтому звука нет только у приложений в ApkStart. Нажмите «Обработать», чтобы включить его снова, и перезапустите среду выполнения.',
      fix: 'audio',
    });
  }
  if (audio.checked && audio.serviceRunning === false) {
    push({
      code: 'audio.windowsServiceStopped',
      category: 'settings',
      severity: 'warn',
      title: 'Служба аудио Windows (Audiosrv) не запущена',
      hint: 'Тогда звук пропадёт и у остальных программ системы. Запустите Windows Audio в services.msc и задайте тип запуска «Автоматически» либо выполните net start Audiosrv в PowerShell от имени администратора.',
      fix: 'audioService',
    });
  }

  /* ---------------- 网络 ---------------- */

  if (network.ok === false) {
    push({
      code: 'network.guestDown',
      category: 'network',
      severity: 'warn',
      title: 'В Android нет сети',
      hint: 'На стороне Android не удаётся разрешение имён или сеть, поэтому видео- и новостные приложения бесконечно крутят индикатор. Поможет «Исправить сеть» — сброс данных Android (список приложений сохранится).',
      detail: network.reason || '',
      fix: 'repairNetwork',
    });
  }

  const badSources = Array.isArray(network.sources) ? network.sources.filter((s) => s && s.ok === false) : [];
  if (badSources.length) {
    push({
      code: 'network.sourcesDown',
      category: 'network',
      severity: 'warn',
      title: `${badSources.length} источников загрузки недоступны`,
      hint: 'При проверке обновлений запрос идёт сразу к нескольким источникам, и недоступность одного не мешает работе; если недоступны все, проверьте сеть или прокси.',
      detail: badSources.map((s) => s.name).join(', '),
      fix: 'settings',
    });
  }

  /* ---------------- 日志 ---------------- */

  const errLines = Array.isArray(logs.errors) ? logs.errors.filter(Boolean) : [];
  if (errLines.length) {
    push({
      code: 'logs.errors',
      category: 'logs',
      severity: 'warn',
      title: `В журнале работы ошибок: ${errLines.length}`,
      hint: 'Последний запуск оставил записи об ошибках; разверните отчёт диагностики, чтобы увидеть полный контекст.',
      detail: errLines.slice(-1)[0],
      fix: 'report',
    });
  }

  /* ---------------- 加速 ---------------- */

  if (accel.checked && accel.ok === false) {
    push({
      code: 'accel.softwareEmulation',
      category: 'runtime',
      severity: 'warn',
      title: 'Аппаратное ускорение сейчас недоступно',
      hint: 'Доступна только чисто программная эмуляция: запуск системы занимает несколько минут, картинка часто теряет кадры. Включите «Платформа гипервизора Windows» и перезагрузите ПК.',
      detail: accel.note || '',
      fix: 'virtualization',
    });
  }

  return dedupe(out);
}

/** 同 code 只留最后一条（后一次检测覆盖前一次） */
function dedupe(issues) {
  const map = new Map();
  for (const raw of issues || []) {
    const it = normalise(raw);
    if (!it) continue;
    map.set(it.code, it);
  }
  return Array.from(map.values());
}

/** 按严重度从高到低排 */
function bySeverity(a, b) {
  const d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (d) return d;
  return String(a.code).localeCompare(String(b.code));
}

/** 汇总：给状态条计数、给设置页分栏 */
function summarize(issues) {
  const list = dedupe(issues).sort(bySeverity);
  const errors = list.filter((i) => i.severity === 'error').length;
  const warns = list.filter((i) => i.severity === 'warn').length;
  const infos = list.filter((i) => i.severity === 'info').length;
  const byCategory = CATEGORIES.map((c) => {
    const items = list.filter((i) => i.category === c.id);
    return {
      id: c.id,
      name: c.name,
      count: items.length,
      errors: items.filter((i) => i.severity === 'error').length,
    };
  });
  return {
    total: list.length,
    errors,
    warns,
    infos,
    byCategory,
    // 一眼能看出「有没有必须马上处理的问题」
    health: errors ? 'error' : (warns ? 'warn' : (infos ? 'info' : 'ok')),
  };
}

/** 按分类分组，用于设置页分类渲染 */
function groupByCategory(issues) {
  const list = dedupe(issues).sort(bySeverity);
  return CATEGORIES.map((c) => ({
    ...c,
    items: list.filter((i) => i.category === c.id),
  })).filter((g) => g.items.length);
}

/**
 * 对比两次检测结果：找出「新出现」和「已消失」的问题。
 * 自动检测只在新问题出现时提醒用户，已消失的只做静默记账 ——
 * 每次都弹「已恢复 3 项」会变成噪音。
 */
function diff(prevIssues, nextIssues) {
  const prev = new Map((prevIssues || []).map((i) => [i.code, i]));
  const next = new Map((nextIssues || []).map((i) => [i.code, i]));
  const added = [];
  const resolved = [];
  for (const [code, it] of next) {
    const before = prev.get(code);
    if (!before || before.severity !== it.severity) added.push(it);
  }
  for (const [code, it] of prev) {
    if (!next.has(code)) resolved.push(it);
  }
  return { added, resolved };
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  SEVERITY_RANK,
  normalise,
  evaluate,
  dedupe,
  summarize,
  groupByCategory,
  diff,
  bySeverity,
};
