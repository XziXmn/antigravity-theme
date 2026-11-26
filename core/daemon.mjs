#!/usr/bin/env node
/**
 * antigravity-codex-theme · CDP Theme, Localization & Live Telemetry Daemon (core/daemon.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USER_DIR,
  parseDaemonCliArgs,
  createBundleController
} from './daemon/paths.mjs';
import {
  acquireDaemonPidLock,
  trimLogFileIfOversized,
  trimDaemonLogsIfNeeded,
  createCdpManager
} from './daemon/cdp-bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadOptionalModule = async (relPath) => {
  const fullPath = path.join(__dirname, relPath);
  if (!fs.existsSync(fullPath)) return null;
  try {
    return await import(`./${relPath}`);
  } catch {
    return null;
  }
};

const protoMod = await loadOptionalModule('daemon/protobuf.mjs');
const lsLogMod = await loadOptionalModule('daemon/ls-log.mjs');
const lsClientMod = await loadOptionalModule('daemon/ls-client.mjs');
const titleUpdaterMod = await loadOptionalModule('daemon/title-updater.mjs');
const sqliteMetricsMod = await loadOptionalModule('daemon/sqlite-metrics.mjs');
const promptSuggestMod = await loadOptionalModule('daemon/prompt-suggest.mjs');
const flowSessionsMod = await loadOptionalModule('flow/sessions.mjs');
const flowProxyMod = await loadOptionalModule('flow/proxy.mjs');
const flowAsarMod = await loadOptionalModule('flow/asar-patch.mjs');
const flowPurifyMod = await loadOptionalModule('flow/purify.mjs');

const parseProto = protoMod?.parseProto || null;
const parseGenMetadataRow = protoMod?.parseGenMetadataRow || null;
const extractMaxStepIdx = protoMod?.extractMaxStepIdx || null;
const extractProtoLeafStrings = protoMod?.extractProtoLeafStrings || null;
const extractStep17Message = protoMod?.extractStep17Message || null;
const isCancelText = protoMod?.isCancelText || null;
const readRecentLsRetryInfo = lsLogMod?.readRecentLsRetryInfo || null;

let DatabaseSync = null;
try {
  const sqliteMod = await import('node:sqlite').catch(() => null);
  if (sqliteMod && typeof sqliteMod.DatabaseSync === 'function') {
    DatabaseSync = sqliteMod.DatabaseSync;
  }
} catch {
  DatabaseSync = null;
}

const cliOpts = parseDaemonCliArgs(process.argv.slice(2));

/**
 * Survival guard. While flow.asar-patch is active the daemon owns Antigravity's model endpoint,
 * so an unhandled rejection anywhere in the injection/proxy pipeline must never take the process
 * down: a dead daemon means a dead relay and "Error Loading Models" in the IDE. runner errors get
 * logged loudly and the daemon keeps serving.
 */
function installDaemonSurvivalGuards() {
  process.on('uncaughtException', (err) => {
    console.error('[Daemon] uncaughtException (surviving):', err?.stack || err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Daemon] unhandledRejection (surviving):', reason?.stack || reason);
  });
}

if (!cliOpts.runOnce) installDaemonSurvivalGuards();

const bundleCtrl = createBundleController({
  safeMode: cliOpts.safeMode,
  cliChannel: cliOpts.cliChannel,
  hasSqlite: Boolean(DatabaseSync && sqliteMetricsMod),
  cliOpts
});

const metricsReader = sqliteMetricsMod
  ? sqliteMetricsMod.createMetricsReader({
      getDatabaseSync: () => DatabaseSync,
      getConfig: () => bundleCtrl.getState().activeConfig
    })
  : { parseConversationMetrics: () => null };

const promptSuggester = promptSuggestMod
  ? promptSuggestMod.createPromptSuggestionEngine({
      getConfig: () => bundleCtrl.getState().activeConfig,
      runOnce: cliOpts.runOnce
    })
  : null;

let flowEventSink = null;
let activeMainSessionIds = [];
const flowSessionStore = flowSessionsMod
  ? flowSessionsMod.createFlowSessionStore({
      storePath: path.join(USER_DIR, 'flow-sessions.json'),
      getDefaultMode: () => bundleCtrl.getState().activeConfig?.flow?.defaultMode || 'default',
      onChange: (info) => {
        if (typeof flowEventSink === 'function') {
          try {
            flowEventSink({ type: 'session-change', ...info });
          } catch {}
        }
      }
    })
  : null;

const lsClient = lsClientMod ? lsClientMod.createLanguageServerClient() : null;

let flowProxyCtrl = null;
const autoTitleUpdater =
  titleUpdaterMod && lsClient && !cliOpts.runOnce
    ? titleUpdaterMod.createAutoTitleUpdater({
        getConfig: () => bundleCtrl.getState().activeConfig,
        lsClient,
        generateTitle: async (prompt) => {
          if (flowProxyCtrl && typeof flowProxyCtrl.callUtilityModel === 'function') {
            return await flowProxyCtrl.callUtilityModel(prompt);
          }
          return '';
        },
        log: (msg) => console.log(msg)
      })
    : null;

flowProxyCtrl =
  flowProxyMod && flowSessionStore && !cliOpts.runOnce
    ? flowProxyMod.createFlowProxyController({
        getConfig: () => bundleCtrl.getState().activeConfig?.flow || {},
        getSystemPrompt: () => bundleCtrl.getState().activeConfig?.customSystemPrompt || null,
        getSubagentRouting: () => bundleCtrl.getState().activeConfig?.subagentRouting || null,
        getActiveMainSessions: () => activeMainSessionIds,
        sessionStore: flowSessionStore,
        onEvent: (ev) => {
          if (typeof flowEventSink === 'function') {
            try {
              flowEventSink(ev);
            } catch {}
          }
        },
        onMainTurn: (info) => {
          if (autoTitleUpdater) autoTitleUpdater.observeTurn(info);
        },
        log: (msg) => console.log(msg)
      })
    : null;

const flowBackupDir = path.join(USER_DIR, 'flow-backups');

/**
 * Footgun detector: if app.asar still redirects to the local relay while the relay is disabled
 * (module toggled off, plugin disabled, safe mode), every model request in the IDE fails with
 * ECONNREFUSED. Warn once per state change so the log explains the outage instead of staying silent.
 */
let relayDisabledWarningKey = '';
let relayDisabledWarningCheckedAt = 0;
function warnRelayDisabledWithPatchedAsar(cfg) {
  if (!flowAsarMod) return;
  const now = Date.now();
  if (now - relayDisabledWarningCheckedAt < 60000) return;
  relayDisabledWarningCheckedAt = now;
  const port = cfg.flow?.port || 18100;
  let asar = null;
  try {
    asar = flowAsarMod.getAsarPatchStatus({ port, backupDir: flowBackupDir });
  } catch {
    return;
  }
  const key = asar?.patched ? `patched:${asar.port || port}` : '';
  if (key === relayDisabledWarningKey) return;
  relayDisabledWarningKey = key;
  if (!key) return;
  console.warn(
    `[Flow] app.asar 仍改道到 http://127.0.0.1:${asar.port || port}，但本地转发当前是关闭状态：` +
      'IDE 的模型请求会直接连接失败（connection refused）。' +
      '恢复：node install.mjs ensure；还原原始端点：node install.mjs rollback。'
  );
}

const flowController =
  flowSessionStore
    ? {
        setEventListener: (fn) => {
          flowEventSink = typeof fn === 'function' ? fn : null;
        },
        setActiveMainSessions: (ids) => {
          if (Array.isArray(ids)) {
            activeMainSessionIds = ids.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
          }
        },
        syncState: async () => {
          const cfg = bundleCtrl.getState().activeConfig;
          const active = Boolean(!cliOpts.safeMode && !cliOpts.runOnce && cfg.enabled && cfg.modules?.flow);
          if (!active) warnRelayDisabledWithPatchedAsar(cfg);
          if (flowProxyCtrl) return await flowProxyCtrl.syncState({ enabled: active });
          return { running: false, port: cfg.flow?.port || 18100, error: '' };
        },
        stop: async () => {
          if (flowProxyCtrl) await flowProxyCtrl.stop();
        },
        getState: ({ cascadeId = '', paneKey = 'main' } = {}) => {
          const cfg = bundleCtrl.getState().activeConfig;
          const flowCfg = cfg.flow || {};
          const proxy = flowProxyCtrl ? flowProxyCtrl.getStatus() : { running: false, port: flowCfg.port || 18100, error: '' };
          const session = flowSessionStore.getSnapshot({ cascadeId, paneKey });
          const asar = flowAsarMod
            ? flowAsarMod.getAsarPatchStatus({ port: flowCfg.port || 18100, backupDir: flowBackupDir })
            : { found: false, patched: false, status: 'unavailable' };
          return {
            available: true,
            enabled: Boolean(cfg.enabled && cfg.modules?.flow),
            defaultMode: flowCfg.defaultMode || 'default',
            proxy,
            session,
            asar
          };
        },
        setSessionMode: ({ cascadeId = '', paneKey = 'main', mode, seatOverride } = {}) => {
          return flowSessionStore.setSessionMode({ cascadeId, paneKey, mode, seatOverride });
        },
        claimDraft: ({ cascadeId = '', paneKey = 'main' } = {}) => {
          return flowSessionStore.claimDraftIfNeeded(cascadeId, paneKey);
        },
        scanHotWords: (text) => {
          return flowPurifyMod ? flowPurifyMod.assertSeatSafe(text) : { ok: true, hot: [] };
        },
        applyAsarPatch: ({ allowDarwin = false } = {}) => {
          if (!flowAsarMod) return { ok: false, error: 'asar-patch module unavailable' };
          const cfg = bundleCtrl.getState().activeConfig;
          return flowAsarMod.applyAsarPatch({
            port: cfg.flow?.port || 18100,
            backupDir: flowBackupDir,
            allowDarwin
          });
        },
        rollbackAsarPatch: () => {
          if (!flowAsarMod) return { ok: false, error: 'asar-patch module unavailable' };
          const cfg = bundleCtrl.getState().activeConfig;
          return flowAsarMod.rollbackAsarPatch({
            port: cfg.flow?.port || 18100,
            backupDir: flowBackupDir
          });
        }
      }
    : null;

let activePidLock = null;
let syncTimer = null;
let daemonStopping = false;

function stopSyncLoop() {
  daemonStopping = true;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

function scheduleNextSync(overrideDelayMs = null) {
  if (daemonStopping || cliOpts.runOnce) return;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const delay =
    Number.isFinite(overrideDelayMs) && overrideDelayMs >= 100
      ? overrideDelayMs
      : typeof cdpManager.getNextSyncDelayMs === 'function'
      ? cdpManager.getNextSyncDelayMs()
      : 2500;
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    if (daemonStopping) return;
    try {
      await cdpManager.sync();
    } finally {
      scheduleNextSync();
    }
  }, delay);
}

const cdpManager = createCdpManager({
  bundleCtrl,
  metricsReader,
  promptSuggester,
  flowController,
  lsClient,
  autoTitleUpdater,
  hasSqlite: () => Boolean(DatabaseSync && sqliteMetricsMod),
  runOnce: cliOpts.runOnce,
  safeMode: cliOpts.safeMode,
  getPidLock: () => activePidLock,
  onSuperseded: () => {
    stopSyncLoop();
    process.exit(0);
  },
  onFastWatch: (delayMs) => {
    if (syncTimer) scheduleNextSync(delayMs);
  }
});

export {
  parseProto,
  parseGenMetadataRow,
  extractMaxStepIdx,
  extractProtoLeafStrings,
  extractStep17Message,
  isCancelText,
  readRecentLsRetryInfo,
  trimLogFileIfOversized
};

export function parseConversationMetrics(cascadeId, conversationsDir, extraOpts = {}) {
  bundleCtrl.rebuildBundleIfNeeded();
  return metricsReader.parseConversationMetrics(cascadeId, conversationsDir, extraOpts);
}

export async function startDaemon() {
  if (globalThis.__ag_daemon_started) return;
  globalThis.__ag_daemon_started = true;

  activePidLock = acquireDaemonPidLock(cliOpts.cliChannel, cliOpts.runOnce, () => {
    stopSyncLoop();
    cdpManager.closeAll();
    if (flowController && typeof flowController.stop === 'function') {
      void flowController.stop();
    }
  });
  if (cliOpts.runOnce && promptSuggester && typeof promptSuggester.stop === 'function') {
    process.on('exit', () => promptSuggester.stop({ terminateAll: true }));
  }
  trimDaemonLogsIfNeeded(cliOpts.runOnce);
  bundleCtrl.rebuildBundleIfNeeded();

  const { activeConfig, cachedPatchVersion } = bundleCtrl.getState();
  console.log(
    `[Antigravity Codex Daemon] Started (${cachedPatchVersion}) | preset=${activeConfig.preset} | channel=${activeConfig.channel} | sqlite=${Boolean(DatabaseSync)} | safeMode=${cliOpts.safeMode}`
  );

  await cdpManager.sync();
  if (cliOpts.runOnce) {
    cdpManager.closeAll();
    process.exit(0);
  } else {
    scheduleNextSync();
  }
}

const invokedArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectDaemon =
  invokedArg === path.resolve(__filename) || path.basename(invokedArg) === 'antigravity-codex-daemon.mjs';

if (process.env.AG_DAEMON_LIBRARY !== '1' && isDirectDaemon) {
  await startDaemon();
}
