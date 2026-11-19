'use strict';
/**
 * 内置手册的「故障 → 教程章节」映射（纯函数，不依赖 electron / fs）
 *
 * 0.6.2：手册随应用分发（src/ui/manual.html）。主进程打开手册时只接受
 * 这里给出的锚点，避免渲染层把任意 file:// 路径传进来。
 *
 * 同一个故障可能有多个入口：自动检测的问题 code、安装失败的原始报错、
 * 用户手点的「教程」按钮。三路都汇到 resolve()，保证落到同一节。
 */

/** 章节 id 与 src/ui/manual.html 的锚点一一对应（由 docs/build-manual-html.py 生成） */
const TOPICS = Object.freeze({
  overview: { id: 'overview', anchor: 'apkstart-Руководство-пользователя-и-решения-проблем', title: 'Руководство · Содержание' },
  accel: { id: 'accel', anchor: '6-1-Подсказка-аппаратное-ускорение-не-включено-медленный-запуск-системы', title: 'Аппаратное ускорение не включено / медленный запуск системы' },
  install: { id: 'install', anchor: '6-2-Ошибка-установки-install_failed_', title: 'Ошибка установки (INSTALL_FAILED_*)' },
  arm: { id: 'arm', anchor: '6-3-В-образе-системы-нет-arm-слоя-трансляции-ARM-приложения-не-устанавливаются-или-аварийно-завершаются', title: 'Слой трансляции ARM / ARM-приложения не устанавливаются' },
  adb: { id: 'adb', anchor: '6-4-adb-не-авторизовано-разрешить-usb-отладку', title: 'adb не авторизовано (разрешить отладку по USB)' },
  startup: { id: 'startup', anchor: '6-5-Двойной-клик-по-значку-без-реакции-бесконечная-загрузка-появилось-окно-с-кнопкой-вращения', title: 'Не открывается / окно с кнопкой вращения' },
  other: { id: 'other', anchor: '6-6-Таблица-быстрой-проверки-прочих-проблем-запуска', title: 'Таблица быстрой проверки прочих проблем запуска' },
  sound: { id: 'sound', anchor: '6-7-У-приложения-нет-звука-звук-очень-тихий', title: 'У приложения нет звука / звук очень тихий' },
  diagnose: { id: 'diagnose', anchor: '5-4-Встроенное-руководство-и-автообучение', title: 'Встроенное руководство и автообучение' },
  settings: { id: 'settings', anchor: '3-6-Навигация-по-странице-настроек', title: 'Навигация по странице настроек' },
  storage: { id: 'storage', anchor: '8-Описание-данных-и-папок', title: 'Описание данных и папок' },
  network: { id: 'network', anchor: '5-2-Автодиагностика-авто-debug', title: 'Автодиагностика и исправление сети' },
});

const ARM_RE = /NO_MATCHING_ABIS|DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|arm64-v8a|armeabi-v7a|ARM 翻译层|ARM 转译层|слой трансляции|слой трансляции ARM|ARM-приложени/iu;
const ADB_RE = /ADB_UNAUTHORIZED|unauthorized|允许 USB 调试|调试授权|разрешить отладку|отладк|авторизац/iu;
const SOUND_RE = /audio|AUDIO|sound|声音|音量|静音|Audiosrv|звук|громкост|без звука|тихо/iu;

/** 自动检测的问题 code → 章节 id */
const ISSUE_MAP = Object.freeze({
  'accel.softwareEmulation': 'accel',
  'device.unauthorized': 'adb',
  'device.offline': 'adb',
  'device.missing': 'adb',
  'settings.orientationConflict': 'startup',
  'settings.detachedFullscreen': 'startup',
  'settings.snapshotOffLowDisk': 'storage',
  'storage.sharedBroken': 'storage',
  'settings.audioDisabled': 'sound',
  'audio.disabled': 'sound',
  'audio.windowsServiceStopped': 'sound',
  'storage.diskCritical': 'storage',
  'storage.diskLow': 'storage',
  'storage.dataNeedsReset': 'storage',
  'storage.dataMismatch': 'storage',
  'network.guestDown': 'network',
  'network.sourcesDown': 'network',
  'runtime.staleLocks': 'startup',
  'runtime.orphanProcesses': 'startup',
  'runtime.staleSnapshot': 'startup',
  'runtime.stuckBoot': 'startup',
});

/** 兜底：用标题/详情里的关键字再判一次，覆盖 doctor:selfCheck 的旧 code */
function topicByText(text) {
  const s = String(text || '');
  if (ARM_RE.test(s)) return 'arm';
  if (ADB_RE.test(s)) return 'adb';
  if (SOUND_RE.test(s)) return 'sound';
  if (/INSTALL_FAILED|INSTALL_PARSE|签名|安装包|APK 损坏|подпис|установочн|поврежд/iu.test(s)) return 'install';
  if (/硬件加速|虚拟机监控程序|WHPX|AEHD|hypervisor|accel|аппаратн|гипервизор|ускорени/iu.test(s)) return 'accel';
  if (/attach failed|emu:0|旋转|嵌入|打不开|没反应|图标|вращ|не открыва|не реагиру|значок/iu.test(s)) return 'startup';
  if (/磁盘|空间|disk|共享目录|数据分区|диск|места|общая папка|раздел данных/iu.test(s)) return 'storage';
  if (/网络|联网|DNS|下载源|сет|интернет|источник загрузки/iu.test(s)) return 'network';
  return 'overview';
}

/** 自动检测问题 → 教程章节 */
function topicForIssue(issue) {
  if (!issue) return TOPICS.overview;
  const code = String(issue.code || '');
  let id = ISSUE_MAP[code];
  // 启动失败要看真实原因：ARM 翻译层崩溃有专属章节，不能一律甩给「打不开」
  if (!id || code === 'runtime.bootFailed' || code === 'logs.errors') {
    id = topicByText(`${issue.title || ''} ${issue.detail || ''}`);
    if (id === 'overview' && code === 'runtime.bootFailed') id = 'startup';
    if (id === 'overview' && code === 'logs.errors') id = 'other';
  }
  return TOPICS[id] || TOPICS.overview;
}

/** 安装/运行原始报错 → 教程章节 */
function topicForError(text) {
  const s = String(text || '');
  if (!s.trim()) return TOPICS.overview;
  if (ARM_RE.test(s)) return TOPICS.arm;
  if (ADB_RE.test(s)) return TOPICS.adb;
  if (SOUND_RE.test(s)) return TOPICS.sound;
  if (/INSTALL_|PARSE_FAILED|安装失败|签名|安装包|установк|подпис/iu.test(s)) return TOPICS.install;
  if (/attach failed|emu:0|device not found|旋转窗口|окно с кнопкой вращени|вращени/iu.test(s)) return TOPICS.startup;
  return topicByText(s) === 'overview' ? TOPICS.install : TOPICS[topicByText(s)];
}

/**
 * 统一入口：渲染层只传它手里有的东西（code / error / topic），
 * 主进程永远拿回一个受信任的章节锚点。
 */
function resolve(payload) {
  const p = typeof payload === 'string' ? { error: payload } : (payload || {});
  let topic = TOPICS.overview;
  if (p.topic && TOPICS[p.topic]) topic = TOPICS[p.topic];
  else if (p.issue || p.code) {
    const issue = typeof p.issue === 'string'
      ? { code: p.issue, title: p.title, detail: p.detail }
      : (p.issue || { code: p.code, title: p.title, detail: p.detail });
    topic = topicForIssue(issue);
  } else if (p.error || p.message || p.text) topic = topicForError(p.error || p.message || p.text);
  return {
    id: topic.id,
    anchor: topic.anchor,
    title: topic.title,
    reason: String(p.reason || ''),
  };
}

module.exports = { TOPICS, ISSUE_MAP, topicForIssue, topicForError, topicByText, resolve };
