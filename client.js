/* global window, document, localStorage */
/**
 * dsh-model-picker-plus —— 把 DSH 的扁平模型选择器替换成分组模型库。
 * 复用 modelDirectories 做目录与切换，只改展示层和容错。
 *
 * 容错栈（一个环节坏，不拖垮整体）：
 *   1. 当前模型走本地投影（quickCurrent），目录挂了也秒显
 *   2. 目录懒绑定 + 5 秒重试自愈；resolver 僵尸化时切换应急目录
 *   3. 目录请求全会话去重并带超时，后台刷新失败保留最后成功数据
 *   4. 单个来源失败只进 failures，其他分组照常渲染
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-picker-plus',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const ReactDOM = require('react-dom');
    const { useState, useEffect, useMemo, useRef, useCallback } = React;
    const memo = React.memo ?? (component => component);

    const NS = 'model-picker-plus';
    const VERSION = '0.3.1';
    const RECENTS_KEY = 'dsh-model-picker-plus:recents';
    const FAVORITES_KEY = 'dsh-model-picker-plus:favorites';
    const MAX_RECENTS = 8;

    // 现场诊断日志默认关闭；仅 localStorage 显式设为 1 时开启。
    const DEBUG_KEY = 'dsh-model-picker-plus:debug';
    const debugEnabled = (() => {
      try {
        return localStorage.getItem(DEBUG_KEY) === '1';
      } catch {
        return false;
      }
    })();
    const dlog = (...args) => { if (debugEnabled) console.log(`[${NS}]`, ...args); };
    const summarizeState = (s) => ({
      status: s?.status ?? null,
      groups: Array.isArray(s?.groups) ? s.groups.length : 0,
      current: s?.current ? `${s.current.provider}/${s.current.model}` : null,
      failures: Array.isArray(s?.failures) ? s.failures.length : 0,
      error: s?.error ?? null,
    });

    // 卡顿诊断时间线：记录墙钟与单调时间；__modelPickerPlusDiag() 导出报告。
    const timeline = [];
    const mark = (event, data) => {
      const entry = { at: new Date().toISOString(), elapsedMs: Math.round(performance.now()), event };
      if (data !== undefined) entry.data = data;
      timeline.push(entry);
      if (timeline.length > 300) timeline.shift();
      dlog(event, data ?? '');
    };
    let diagSnapshot = null;
    let diagGroups = [];
    let diagFailures = [];
    mark('client module loaded', { version: VERSION });
    if (typeof window !== 'undefined') {
      window.__modelPickerPlusDiag = () => ({
        version: VERSION,
        generatedAt: new Date().toISOString(),
        page: window.location?.href ?? null,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        snapshot: diagSnapshot,
        failures: diagFailures,
        groups: diagGroups,
        timeline: [...timeline],
      });
    }

    let localeSvc;
    const translate = (key) => {
      if (localeSvc && typeof localeSvc.bind === 'function') return localeSvc.bind(NS)(key);
      return DICT.zh[key] || key;
    };

    const DICT = {
      zh: {
        loading: '加载模型…',
        loadingSlow: '模型未就绪',
        loadSlowTitle: '模型目录暂时没有响应',
        loadSlowHint: '可能是 Provider 插件被卸载或目录加载超时，目录恢复后会自动显示。',
        unavailable: '模型不可用',
        subagentLocked: '子代理会话不支持切换模型',
        selectNotReady: '模型目录尚未就绪，请稍后重试',
        search: '搜索模型、Provider、用途…',
        title: '模型库',
        current: '当前',
        effort: '思考强度',
        providerDefault: '默认',
        favorites: '收藏',
        addFavorite: '添加收藏',
        removeFavorite: '取消收藏',
        recent: '最近使用',
        providers: '全部来源',
        noResults: '没有匹配的模型',
        retry: '重试',
        loadFailed: '模型目录加载失败：{message}',
        selectFailed: '切换模型失败：{message}',
        modelsCount: '{count} 个模型',
        vision: '视觉',
        reasoning: '推理',
        tools: '工具',
        omni: '多模态',
        free: '免费',
        filterAll: '全部',
        filterFree: '免费',
        filterVision: '视觉',
        filterReasoning: '推理',
        filterTools: '工具',
        sourceFailed: '加载失败',
        close: '关闭',
        changeModel: '更换',
        keyboardNavigate: '↑↓ 选择',
        keyboardUse: 'Enter 使用',
        keyboardClose: 'Esc 关闭',
        collapseAll: '全部收起',
        expandAll: '全部展开',
        recommend: '推荐',
        allModels: '全部模型',
        recentModels: '最近使用',
        favoriteModels: '收藏',
        taskPrompt: '你想做什么？',
        taskCode: '编程',
        taskVision: '看图片',
        taskReasoning: '深度推理',
        taskFast: '快速回答',
        taskFree: '免费优先',
        recommended: '为你推荐',
        useModel: '使用',
        viewAll: '查看全部模型',
        currentRoute: '自动路由 · 由 DSH 决定候选范围',
        recommendationCode: '适合代码修改与工具调用',
        recommendationVision: '支持图片输入与视觉理解',
        recommendationReasoning: '适合复杂分析和多步骤任务',
        recommendationFast: '优先选择响应较快的模型',
        recommendationFree: '免费来源 · 适合日常问答',
        noTaskResults: '没有符合条件的模型，试试其他场景',
      },
      en: {
        loading: 'Loading models…',
        loadingSlow: 'Models not ready',
        loadSlowTitle: 'Model directory is not responding',
        loadSlowHint: 'A provider plugin may have been removed, or loading timed out. Models appear automatically once the directory recovers.',
        unavailable: 'Models unavailable',
        subagentLocked: 'Model switching is unavailable in subagent sessions',
        selectNotReady: 'The model directory is not ready yet — try again shortly',
        search: 'Search models, providers, use cases…',
        title: 'Model library',
        current: 'Current',
        effort: 'Reasoning effort',
        providerDefault: 'Default',
        favorites: 'Favorites',
        addFavorite: 'Add favorite',
        removeFavorite: 'Remove favorite',
        recent: 'Recent',
        providers: 'All providers',
        noResults: 'No matching models',
        retry: 'Retry',
        loadFailed: 'Failed to load models: {message}',
        selectFailed: 'Failed to switch model: {message}',
        modelsCount: '{count} models',
        vision: 'Vision',
        reasoning: 'Reasoning',
        tools: 'Tools',
        omni: 'Omni',
        free: 'Free',
        filterAll: 'All',
        filterFree: 'Free',
        filterVision: 'Vision',
        filterReasoning: 'Reasoning',
        filterTools: 'Tools',
        sourceFailed: 'Failed to load',
        close: 'Close',
        changeModel: 'Change',
        keyboardNavigate: '↑↓ Navigate',
        keyboardUse: 'Enter Use',
        keyboardClose: 'Esc Close',
        collapseAll: 'Collapse all',
        expandAll: 'Expand all',
        recommend: 'Recommended',
        allModels: 'All models',
        recentModels: 'Recent',
        favoriteModels: 'Favorites',
        taskPrompt: 'What are you doing?',
        taskCode: 'Coding',
        taskVision: 'Images',
        taskReasoning: 'Deep reasoning',
        taskFast: 'Fast answers',
        taskFree: 'Free first',
        recommended: 'Recommended for you',
        useModel: 'Use',
        viewAll: 'View all models',
        currentRoute: 'Auto routing · DSH chooses candidates',
        recommendationCode: 'Good for code edits and tool calls',
        recommendationVision: 'Supports image input and vision',
        recommendationReasoning: 'Good for complex, multi-step tasks',
        recommendationFast: 'Prioritizes lower response latency',
        recommendationFree: 'Free source · good for everyday questions',
        noTaskResults: 'No models fit this task. Try another one',
      },
    };

    const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
    const modelKey = (provider, model) => `${provider}\n${model}`;
    const splitModelKey = (key) => {
      const index = String(key).indexOf('\n');
      return index < 0 ? null : { provider: key.slice(0, index), model: key.slice(index + 1) };
    };
    const modelLabel = (model) => String(model?.name || model?.id || '');
    const normalize = (value) => String(value ?? '').toLowerCase().trim();
    const normalizeLabel = (value) => normalize(value).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '');
    const isDistinctText = (value, ...others) => {
      const current = normalizeLabel(value);
      return current !== '' && !others.some(other => normalizeLabel(other) === current);
    };

    function storageGet(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }

    function storageSet(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式下静默忽略 */ }
    }

    // 极简快照 store（getSnapshot / subscribe / set / update），应急目录专用。
    function createMiniStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      const emit = () => {
        for (const listener of [...listeners]) {
          try { listener(); } catch { /* 单个监听器异常不影响其他 */ }
        }
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set: (next) => { snapshot = next; emit(); },
        update: (fn) => {
          const draft = { ...snapshot };
          fn(draft);
          snapshot = draft;
          emit();
        },
      };
    }

    // 目录（modelCatalog）全会话共享：一个宿主世代一份目录，进行中的
    // 请求去重，就绪状态广播；各会话只拥有自己的投影 face。
    let sharedCatalogStatus = 'idle'; // idle | loading | ready | error
    let sharedCatalogValue = null;
    let sharedCatalogError = null;
    let sharedCatalogInflight = null;
    let sharedCatalogReadyAt = 0; // 就绪时间戳（TTL 判定）
    let catalogTtlMs = 60000;     // 新鲜期内打开菜单零 RPC
    let catalogSwrMs = 10000;     // 超过这个年龄就顺手后台刷新（SWR）
    let resilienceEpoch = 0;      // 重置时 +1，让旧定时器失效
    let startupRefetchDone = false;
    let directoryWarmupStarted = false;
    const moduleLoadedAt = Date.now();
    const sharedCatalogListeners = new Set();
    const notifySharedCatalog = () => {
      for (const listener of [...sharedCatalogListeners]) {
        try { listener(); } catch { /* 单个监听器异常不影响其他 */ }
      }
    };

    // 全会话共享的目录拉取。三层策略：
    //   · TTL 新鲜期（60s）且年轻（≤10s）直接命中，零 RPC，菜单秒开；
    //   · 超过 SWR 年龄：旧数据继续显示，同时后台刷新（SWR）——覆盖宿主
    //     启动窗口：预热可能赶在 free-models-hub 注册 Provider（5–8s）之前
    //     拿到不完整目录，刷新完成后广播，菜单自动补全；
    //   · 出错总是重新拉（重试语义）。
    // RPC 带 10 秒超时：永挂起的请求必须能判死，否则界面永远 loading。
    let catalogRpcTimeoutMs = 10000;
    function loadSharedCatalog(remote) {
      if (sharedCatalogInflight) return sharedCatalogInflight;
      const age = Date.now() - sharedCatalogReadyAt;
      if (sharedCatalogStatus === 'ready' && age < catalogTtlMs && age < catalogSwrMs) {
        return Promise.resolve(sharedCatalogStatus); // 新鲜命中：零 RPC
      }
      // ready 状态下不翻 loading：旧数据继续显示，完成后广播（SWR）。
      if (sharedCatalogStatus !== 'ready') {
        sharedCatalogStatus = 'loading';
        notifySharedCatalog();
      }
      const operation = (async () => {
        try {
          let timeout;
          const response = await Promise.race([
            remote.session.modelCatalog(),
            // 不 unref：挂起的目录加载本就应该把流程“吊”到超时判死为止。
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error(`catalog RPC timeout after ${catalogRpcTimeoutMs}ms`)), catalogRpcTimeoutMs);
            }),
          ]).finally(() => clearTimeout(timeout));
          if (!response?.ok) {
            throw new Error(response?.error ? `${response.error.code}: ${response.error.message}` : 'catalog request failed');
          }
          sharedCatalogValue = response.value;
          sharedCatalogStatus = 'ready';
          sharedCatalogReadyAt = Date.now();
          sharedCatalogError = null;
          // 启动窗口补枪：模块加载 45 秒内的首次成功，12 秒后再拉一次，
          // 确保晚注册的 Provider（free-models-hub 等）一定被收进来。
          if (!startupRefetchDone && Date.now() - moduleLoadedAt < 45000) {
            startupRefetchDone = true;
            const epoch = resilienceEpoch;
            const timer = setTimeout(() => {
              if (epoch === resilienceEpoch) void loadSharedCatalog(remote);
            }, 12000);
            timer.unref?.();
          }
        } catch (error) {
          sharedCatalogError = String(error?.message ?? error);
          // 后台刷新失败时保留最后一次成功目录；只有首次加载失败才进入 error。
          sharedCatalogStatus = sharedCatalogValue ? 'ready' : 'error';
        }
        notifySharedCatalog();
        return sharedCatalogStatus;
      })();
      sharedCatalogInflight = operation;
      operation.finally(() => { if (sharedCatalogInflight === operation) sharedCatalogInflight = null; });
      return operation;
    }

    // 测试专用：重置跨会话容灾状态，让每个用例从干净状态开始。
    function resetResilienceState() {
      resilienceEpoch += 1;
      startupRefetchDone = false;
      directoryWarmupStarted = false;
      sharedCatalogStatus = 'idle';
      sharedCatalogValue = null;
      sharedCatalogError = null;
      sharedCatalogInflight = null;
      sharedCatalogReadyAt = 0;
      sharedCatalogListeners.clear();
      catalogRpcTimeoutMs = 10000;
      catalogTtlMs = 60000;
      catalogSwrMs = 10000;
    }

    // 应急目录：resolver 实例僵尸化（其内部访问 remote.session 的 Cordis
    // 通道失效）时，直接用还活着的 RPC 客户端 + 本地投影，按 DSH 的算法
    // （current = 投影 ?? catalog.default）拼一个接口相同的目录
    // { store, load, select }。聊天正常就是 RPC 客户端活着的证据。
    function createFallbackDirectory(remote, sessions, sessionId) {
      const store = createMiniStore({ current: null, routable: null, groups: [], failures: [], status: 'loading', error: null });
      let face = null;
      try {
        face = sessions.binding(sessionId)?.session?.projections?.faceOf?.('modelSelection') ?? null;
      } catch { /* 没有投影也能工作，只是切换后不自动回填 */ }
      let generation = 0; // select 代际：旧响应不覆盖新操作
      let disposed = false;
      let faceUnsubscribe = null;

      // 合并「共享目录 + 本会话投影」出快照。
      const sync = () => {
        if (disposed) return;
        let projected = null;
        try { projected = face?.getSnapshot?.()?.next ?? null; } catch { /* 投影读取失败按无投影处理 */ }
        if (sharedCatalogStatus !== 'ready' || !sharedCatalogValue) {
          store.update((s) => {
            s.current = null;
            s.routable = null;
            s.groups = [];
            s.failures = [];
            if (s.status !== 'error') s.status = sharedCatalogStatus === 'error' ? 'error' : 'loading';
            if (sharedCatalogStatus === 'error') s.error = sharedCatalogError;
          });
          return;
        }
        const catalog = sharedCatalogValue;
        const current = projected ?? catalog.default ?? null;
        store.update((s) => {
          s.current = current;
          s.routable = current ? catalog.routableProviders?.includes?.(current.provider) ?? null : null;
          s.groups = catalog.groups ?? [];
          s.failures = catalog.failures ?? [];
          s.status = s.status === 'selecting' ? 'selecting' : 'ready';
          s.error = null;
        });
      };
      if (face) {
        try {
          const unsubscribe = face.subscribe?.(sync);
          if (typeof unsubscribe === 'function') faceUnsubscribe = unsubscribe;
        } catch { /* 订阅失败忽略 */ }
      }
      sharedCatalogListeners.add(sync);
      sync(); // 创建即同步一次：目录已就绪时立刻可用，不必等下次广播

      return {
        store,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          try { faceUnsubscribe?.(); } catch { /* 清理失败不影响其他资源 */ }
          faceUnsubscribe = null;
          sharedCatalogListeners.delete(sync);
        },
        // 拉取远端目录（menu 打开时调用）：全会话共享 + 去重 + TTL 命中。
        load: () => disposed ? Promise.resolve(store.getSnapshot()) : loadSharedCatalog(remote).then(() => store.getSnapshot()),
        // 切换模型：投影帧随后回填 current；无 face 时乐观回填。
        select: async (selection) => {
          if (disposed) throw new Error('directory disposed');
          const gen = ++generation;
          store.update((s) => { s.status = 'selecting'; s.error = null; });
          try {
            const result = await remote.session.selectModel({
              sessionId,
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
            });
            if (gen !== generation) {
              if (!result?.ok) throw new Error(result?.error ? `${result.error.code}: ${result.error.message}` : 'select failed');
              return;
            }
            if (!result?.ok) {
              throw new Error(result?.error ? `${result.error.code}: ${result.error.message}` : 'select failed');
            }
            store.update((s) => {
              if (!face) {
                s.current = {
                  provider: selection.provider,
                  model: selection.model,
                  ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
                };
                s.routable = sharedCatalogValue?.routableProviders?.includes?.(selection.provider) ?? s.routable;
              }
              s.status = sharedCatalogStatus === 'ready' ? 'ready' : sharedCatalogStatus === 'error' ? 'error' : 'loading';
            });
          } catch (error) {
            if (gen === generation) {
              store.update((s) => {
                // 切换失败只影响本次操作；已有目录继续可用，允许立即重试。
                s.status = sharedCatalogValue ? 'ready' : 'error';
                s.error = sharedCatalogValue ? null : String(error?.message ?? error);
              });
            }
            throw error;
          }
        },
      };
    }

    function selectionFor(group, model, current) {
      const same = current?.provider === group.id && current?.model === model.id;
      const effort = same
        ? current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort;
      return {
        provider: group.id,
        model: model.id,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      };
    }

    function findChoice(groups, selection) {
      if (!selection) return undefined;
      for (const group of groups) {
        if (group.id !== selection.provider) continue;
        const model = group.models.find(item => item.id === selection.model);
        if (model) return { group, model };
      }
      return undefined;
    }

    function modelMatches(group, model, query) {
      const q = normalize(query);
      if (!q) return true;
      return [group.id, group.name, model.id, model.name, model.description]
        .some(value => normalize(value).includes(q));
    }

    function filterGroups(groups, query) {
      const q = normalize(query);
      if (!q) return groups;
      return groups
        .map(group => ({
          ...group,
          models: normalize(group.name).includes(q) || normalize(group.id).includes(q)
            ? group.models
            : group.models.filter(model => modelMatches(group, model, q)),
        }))
        .filter(group => group.models.length > 0);
    }

    function createModelIndex(groups) {
      const byKey = new Map();
      const rows = [];
      for (const group of groups) {
        for (const model of group.models) {
          const row = {
            key: modelKey(group.id, model.id),
            group,
            model,
            free: isFreeModel(group, model),
            vision: isVisionModel(group, model),
            reasoning: isReasoningModel(model),
            tools: hasToolsModel(model),
            omni: isOmniModel(model),
          };
          rows.push(row);
          byKey.set(row.key, row);
        }
      }
      return { rows, byKey };
    }

    function rowsForKeys(groupsOrIndex, keys) {
      const index = groupsOrIndex?.byKey instanceof Map ? groupsOrIndex : createModelIndex(groupsOrIndex);
      const rows = [];
      const seen = new Set();
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const choice = index.byKey.get(key);
        if (choice) rows.push(choice);
      }
      return rows;
    }

    function effortLabel(model, current, t) {
      const reasoning = model?.reasoning;
      if (!reasoning) return '';
      const effort = current?.reasoningEffort ?? reasoning.defaultEffort;
      if (effort === undefined) return t('providerDefault');
      return reasoning.efforts.find(item => item.id === effort)?.name ?? effort;
    }

    // __MODEL_METADATA_BEGIN__（由 scripts/update-model-metadata.mjs 生成于 2026-09-16，来源：models.dev 7824 条 + openrouter 443 条 + huggingface 1000 条，请勿手改）
    const MODEL_METADATA_AT = '2026-09-16';
    const MODEL_METADATA = {"abliterated-model":{"i":"it","t":1,"r":1},"abliterated-model-large":{"t":1,"r":1},"abliterated-model-large-v2":{"t":1,"r":1},"active-speaker-detection":{"i":"v","f":1},"agent-max":{"i":"it","t":1,"r":1},"agent-prime":{"t":1,"r":1},"agent-standard":{"t":1,"r":1},"agents-a1":{"i":"it","t":1,"r":1,"f":1},"agnes-1.5-lite":{"i":"it","t":1},"agnes-1.5-pro":{"t":1,"r":1},"agnes-2.0-flash":{"i":"it","t":1,"r":1,"f":1},"agnes-2.5-flash":{"i":"it","t":1,"r":1,"f":1},"agnes-2.5-pro-alpha":{"i":"it","t":1,"r":1},"agnes-3.0-flash":{"i":"it","t":1,"r":1},"aion-2.0":{"t":1,"r":1},"aion-3.0":{"t":1,"r":1},"aion-3.0-mini":{"t":1,"r":1},"aion-labs-aion-3-0":{"t":1,"r":1},"aion-labs-aion-3-0-mini":{"t":1,"r":1},"aion-rp-llama-3.1-8b":{"t":1},"alibaba-qwen3-32b":{"t":1,"r":1},"alicloud-deepseek-v4-flash":{"t":1,"r":1},"alicloud-deepseek-v4-pro":{"t":1,"r":1},"alicloud-glm-5.1":{"t":1,"r":1},"allam-2-7b":{"f":1},"amazon--nova-lite":{"i":"itv","t":1,"r":1},"amazon--nova-micro":{"t":1},"amazon--nova-pro":{"i":"itv","t":1},"amazon.nova-2-lite-v1:0":{"i":"iptv","t":1,"r":1},"amazon.nova-lite-v1:0":{"i":"iptv","t":1},"amazon.nova-lite-v1:0@us":{"i":"ipt","t":1},"amazon.nova-micro-v1:0":{"t":1},"amazon.nova-micro-v1:0@us":{"t":1},"amazon.nova-pro-v1:0":{"i":"iptv","t":1},"amazon.nova-pro-v1:0@us":{"i":"ipt","t":1},"anthropic--claude-3-haiku":{"i":"ipt","t":1},"anthropic--claude-3-opus":{"i":"ipt","t":1},"anthropic--claude-3-sonnet":{"i":"ipt","t":1},"anthropic--claude-3.5-sonnet":{"i":"ipt","t":1},"anthropic--claude-3.7-sonnet":{"i":"ipt","t":1,"r":1},"anthropic--claude-4-opus":{"i":"ipt","t":1,"r":1},"anthropic--claude-4-sonnet":{"i":"ipt","t":1,"r":1},"anthropic--claude-4.5-haiku":{"i":"ipt","t":1,"r":1},"anthropic--claude-4.5-opus":{"i":"ipt","t":1,"r":1},"anthropic--claude-4.5-sonnet":{"i":"ipt","t":1,"r":1},"anthropic--claude-4.6-opus":{"i":"ipt","t":1,"r":1},"anthropic--claude-4.6-sonnet":{"i":"ipt","t":1,"r":1},"anthropic--claude-4.7-opus":{"i":"ipt","t":1,"r":1},"anthropic--claude-4.8-opus":{"i":"ipt","t":1,"r":1},"anthropic-claude-3-opus":{"i":"it","t":1},"anthropic-claude-3.5-haiku":{"t":1},"anthropic-claude-3.5-sonnet":{"i":"it","t":1},"anthropic-claude-3.7-sonnet":{"i":"it","t":1,"r":1},"anthropic-claude-4.1-opus":{"i":"it","t":1,"r":1},"anthropic-claude-4.5-haiku":{"i":"it","t":1,"r":1},"anthropic-claude-4.5-sonnet":{"i":"it","t":1,"r":1},"anthropic-claude-4.6-sonnet":{"i":"it","t":1,"r":1},"anthropic-claude-5-sonnet":{"t":1,"r":1},"anthropic-claude-fable-5":{"i":"it","t":1,"r":1},"anthropic-claude-fable-5.1":{"i":"it","t":1,"r":1},"anthropic-claude-haiku-4.5":{"i":"it","t":1,"r":1},"anthropic-claude-opus-4":{"i":"ipt","t":1,"r":1},"anthropic-claude-opus-4.5":{"i":"it","t":1,"r":1},"anthropic-claude-opus-4.6":{"i":"it","t":1,"r":1},"anthropic-claude-opus-4.7":{"i":"it","t":1,"r":1},"anthropic-claude-opus-4.8":{"i":"it","t":1,"r":1},"anthropic-claude-opus-5":{"i":"it","t":1,"r":1},"anthropic-claude-sonnet-4":{"i":"ipt","t":1,"r":1},"anthropic.claude-fable-5":{"i":"ipt","t":1,"r":1},"anthropic.claude-fable-5-1":{"i":"ipt","t":1,"r":1},"anthropic.claude-haiku-4-5-20251001-v1:0":{"i":"ipt","t":1,"r":1},"anthropic.claude-opus-4-1-20250805-v1:0":{"i":"ipt","t":1,"r":1},"anthropic.claude-opus-4-5-20251101-v1:0":{"i":"ipt","t":1,"r":1},"anthropic.claude-opus-4-6-v1":{"i":"ipt","t":1,"r":1},"anthropic.claude-opus-4-7":{"i":"ipt","t":1,"r":1},"anthropic.claude-opus-4-8":{"i":"ipt","t":1,"r":1},"anthropic.claude-opus-5":{"i":"ipt","t":1,"r":1},"anthropic.claude-sonnet-4-5-20250929-v1:0":{"i":"ipt","t":1,"r":1},"anthropic.claude-sonnet-4-6":{"i":"ipt","t":1,"r":1},"anthropic.claude-sonnet-5":{"i":"ipt","t":1,"r":1},"apac.amazon.nova-lite-v1:0":{"i":"iptv","t":1},"apac.amazon.nova-micro-v1:0":{"t":1},"apac.amazon.nova-pro-v1:0":{"i":"iptv","t":1},"apac.anthropic.claude-sonnet-4-20250514-v1:0":{"i":"ipt","t":1,"r":1},"apertus-70b":{"t":1,"r":1},"apertus-70b-instruct":{"t":1},"apertus-8b-instruct":{"t":1},"apertus-v1.5-70b":{"i":"ait","t":1},"apertus-v1.5-8b":{"i":"it"},"apodex_apodex-1.1-mini-gguf":{"i":"it"},"apriel-1.6-15b-thinker":{"i":"it"},"arcee-trinity-large-thinking":{"t":1,"r":1},"aria":{"i":"it"},"artemis-v1.1":{"i":"it","t":1,"r":1},"asi1-mini":{"i":"pt"},"atria-dawn-preview":{"t":1,"r":1,"f":1},"au.anthropic.claude-haiku-4-5-20251001-v1:0":{"i":"ipt","t":1,"r":1},"au.anthropic.claude-opus-4-6-v1":{"i":"ipt","t":1,"r":1},"au.anthropic.claude-opus-4-7":{"i":"ipt","t":1,"r":1},"au.anthropic.claude-opus-4-8":{"i":"ipt","t":1,"r":1},"au.anthropic.claude-opus-5":{"i":"ipt","t":1,"r":1},"au.anthropic.claude-sonnet-4-5-20250929-v1:0":{"i":"ipt","t":1,"r":1},"au.anthropic.claude-sonnet-4-6":{"i":"ipt","t":1,"r":1},"au.anthropic.claude-sonnet-5":{"i":"ipt","t":1,"r":1},"auto":{"i":"afiptv","t":1,"r":1,"f":1},"auto-beta":{"i":"afitv","t":1,"r":1},"auto-model":{"t":1,"f":1},"auto-model-basic":{"t":1},"auto-model-premium":{"t":1},"auto-model-standard":{"t":1},"autoglm-phone-9b":{"i":"it","t":1},"autoglm-phone-9b-multilingual":{"i":"it"},"aya-vision-32b":{"i":"it"},"baai_arex-turbo-gguf":{"i":"it"},"balanced":{"i":"it","t":1,"r":1},"bee-8b-rl":{"i":"it"},"bevformer":{"i":"v","f":1},"bge-m3":{"f":1},"bielik-11b-v2.6-instruct":{"t":1},"bielik-11b-v3.0-instruct":{"t":1},"big-pickle":{"t":1,"r":1,"f":1},"blip2-flan-t5-xl":{"i":"it"},"blip2-opt-2.7b":{"i":"it"},"blip2-opt-6.7b":{"i":"it"},"bodybuilder":{"f":1},"bonsai-27b-ternary-crack-gguf":{"i":"it"},"borealis-27b":{"i":"it"},"brick-complexity-pro":{"i":"it","t":1},"brick-v1-beta":{"i":"it","t":1,"f":1},"c4ai-aya-vision-32b":{"i":"it"},"c4ai-aya-vision-8b":{"i":"it"},"ca.amazon.nova-lite-v1:0":{"i":"iptv","t":1},"cerebras-llama-4-maverick-17b-128e-instruct":{"t":1,"f":1},"cerebras-llama-4-scout-17b-16e-instruct":{"t":1,"f":1},"chameleon-7b":{"i":"it"},"chandra":{"i":"it"},"chandra-ocr-2":{"i":"it"},"chandra-ocr-2-gguf":{"i":"it"},"chandra-ocr-2-nvfp4a16":{"i":"it"},"chatgpt-4o-latest":{"i":"it","t":1},"chatgpt-image-latest":{"i":"it"},"chatrex-7b":{"i":"it"},"cheap":{"i":"ipt","t":1,"r":1},"churro-3b":{"i":"it"},"claude-3-5-haiku":{"i":"ipt","t":1},"claude-3-7-sonnet-20250219":{"i":"ipt","t":1,"r":1},"claude-3-7-sonnet-latest":{"i":"ipt","t":1,"r":1},"claude-3-haiku":{"i":"ipt","t":1},"claude-3-haiku-20240307":{"i":"it","t":1},"claude-3.5-haiku":{"i":"it","t":1},"claude-3.5-sonnet":{"i":"it","t":1,"r":1},"claude-3.5-sonnet-v2":{"i":"it","t":1},"claude-3.7-sonnet":{"i":"ipt","t":1,"r":1},"claude-4-5-sonnet":{"i":"ipt","t":1,"r":1},"claude-4-6-sonnet":{"i":"ipt","t":1,"r":1},"claude-4.0-opus":{"i":"it","t":1,"r":1},"claude-4.0-sonnet":{"i":"it","t":1,"r":1},"claude-4.1-opus":{"i":"it","t":1,"r":1},"claude-4.5-haiku":{"i":"it","t":1,"r":1},"claude-4.5-opus":{"i":"it","t":1,"r":1},"claude-4.5-sonnet":{"i":"it","t":1,"r":1},"claude-code":{"t":1,"r":1},"claude-fable-5":{"i":"fipt","t":1,"r":1,"f":1},"claude-fable-5-1":{"i":"ipt","t":1,"r":1},"claude-fable-5-1@default":{"i":"ipt","t":1,"r":1},"claude-fable-5:batch":{"i":"fit","t":1,"r":1},"claude-fable-5.1":{"i":"fipt","t":1,"r":1},"claude-fable-5.1:batch":{"i":"fit","t":1,"r":1},"claude-fable-5.1@eu":{"i":"ipt","t":1,"r":1},"claude-fable-5@default":{"i":"ipt","t":1,"r":1},"claude-fable-5@eu":{"i":"ipt","t":1,"r":1},"claude-fable-latest":{"i":"fipt","t":1,"r":1},"claude-haiku-3":{"i":"ipt","t":1},"claude-haiku-3.5":{"i":"ipt","t":1},"claude-haiku-4-5":{"i":"ipt","t":1,"r":1},"claude-haiku-4-5-20251001":{"i":"ipt","t":1,"r":1},"claude-haiku-4-5@20251001":{"i":"ipt","t":1,"r":1},"claude-haiku-4-5@eu":{"i":"ipt","t":1,"r":1},"claude-haiku-4.5":{"i":"fipt","t":1,"r":1},"claude-haiku-4.5:batch":{"i":"fit","t":1,"r":1},"claude-haiku-4.5:thinking":{"i":"ipt","t":1,"r":1},"claude-haiku-latest":{"i":"fipt","t":1,"r":1},"claude-mythos-5":{"i":"ipt","t":1,"r":1},"claude-opus-4":{"i":"fipt","t":1,"r":1},"claude-opus-4-1":{"i":"ipt","t":1,"r":1},"claude-opus-4-1-20250805":{"i":"ipt","t":1,"r":1},"claude-opus-4-1-20250805-thinking":{"i":"it","t":1,"r":1},"claude-opus-4-1@20250805":{"i":"ipt","t":1,"r":1},"claude-opus-4-20250514":{"i":"ipt","t":1,"r":1},"claude-opus-4-5":{"i":"ipt","t":1,"r":1},"claude-opus-4-5-20251101":{"i":"ipt","t":1,"r":1},"claude-opus-4-5@20251101":{"i":"ipt","t":1,"r":1},"claude-opus-4-5@eu":{"i":"ipt","t":1,"r":1},"claude-opus-4-6":{"i":"ipt","t":1,"r":1},"claude-opus-4-6-think":{"i":"ipt","t":1,"r":1},"claude-opus-4-6@default":{"i":"ipt","t":1,"r":1},"claude-opus-4-6@eu":{"i":"ipt","t":1,"r":1},"claude-opus-4-7":{"i":"ipt","t":1,"r":1,"f":1},"claude-opus-4-7-think":{"i":"ipt","t":1,"r":1},"claude-opus-4-7-thinking":{"i":"ipt","t":1,"r":1},"claude-opus-4-7@default":{"i":"ipt","t":1,"r":1},"claude-opus-4-7@eu":{"i":"ipt","t":1,"r":1},"claude-opus-4-8":{"i":"ipt","t":1,"r":1,"f":1},"claude-opus-4-8-fast":{"i":"it","t":1,"r":1},"claude-opus-4-8-think":{"i":"it","t":1,"r":1},"claude-opus-4-8@default":{"i":"ipt","t":1,"r":1},"claude-opus-4-8@eu":{"i":"ipt","t":1,"r":1},"claude-opus-4:thinking":{"i":"ipt","t":1,"r":1},"claude-opus-4:thinking:1024":{"i":"ipt","t":1,"r":1},"claude-opus-4:thinking:32768":{"i":"ipt","t":1,"r":1},"claude-opus-4:thinking:8192":{"i":"ipt","t":1,"r":1},"claude-opus-4.1":{"i":"fipt","t":1,"r":1},"claude-opus-4.1:batch":{"i":"fit","t":1,"r":1},"claude-opus-4.1:thinking":{"i":"ipt","t":1,"r":1},"claude-opus-4.1:thinking:1024":{"i":"ipt","t":1,"r":1},"claude-opus-4.1:thinking:32768":{"i":"ipt","t":1,"r":1},"claude-opus-4.1:thinking:8192":{"i":"ipt","t":1,"r":1},"claude-opus-4.5":{"i":"fipt","t":1,"r":1},"claude-opus-4.5:batch":{"i":"fit","t":1,"r":1},"claude-opus-4.5:thinking":{"i":"ipt","t":1,"r":1},"claude-opus-4.6":{"i":"fipt","t":1,"r":1},"claude-opus-4.6:batch":{"i":"fit","t":1,"r":1},"claude-opus-4.6:thinking":{"i":"ipt","t":1,"r":1},"claude-opus-4.6:thinking:low":{"i":"ipt","t":1,"r":1},"claude-opus-4.6:thinking:max":{"i":"ipt","t":1,"r":1},"claude-opus-4.6:thinking:medium":{"i":"ipt","t":1,"r":1},"claude-opus-4.7":{"i":"fipt","t":1,"r":1},"claude-opus-4.7:batch":{"i":"fit","t":1,"r":1},"claude-opus-4.7:thinking":{"i":"ipt","t":1,"r":1},"claude-opus-4.8":{"i":"fipt","t":1,"r":1},"claude-opus-4.8-fast":{"i":"ipt","t":1,"r":1},"claude-opus-4.8:batch":{"i":"fit","t":1,"r":1},"claude-opus-4.8:thinking":{"i":"ipt","t":1,"r":1},"claude-opus-4@20250514":{"i":"ipt","t":1,"r":1},"claude-opus-5":{"i":"fipt","t":1,"r":1,"f":1},"claude-opus-5-fast":{"i":"ipt","t":1,"r":1},"claude-opus-5-thinking":{"i":"ipt","t":1,"r":1},"claude-opus-5:batch":{"i":"fit","t":1,"r":1},"claude-opus-5@default":{"i":"ipt","t":1,"r":1},"claude-opus-5@eu":{"i":"ipt","t":1,"r":1},"claude-opus-latest":{"i":"fipt","t":1,"r":1},"claude-opus4-5":{"i":"ipt","t":1,"r":1},"claude-opus4-6":{"i":"ipt","t":1,"r":1},"claude-opus4-7":{"i":"ipt","t":1,"r":1},"claude-opus4-8":{"i":"ipt","t":1,"r":1},"claude-sonnet-3.5":{"i":"ipt","t":1},"claude-sonnet-3.5-june":{"i":"ipt","t":1},"claude-sonnet-3.7":{"i":"ipt","t":1,"r":1},"claude-sonnet-4":{"i":"fipt","t":1,"r":1},"claude-sonnet-4-20250514":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-5":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-5-20250929":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-5-20250929-thinking":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-5@20250929":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-5@eu":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-6":{"i":"ipt","t":1,"r":1,"f":1},"claude-sonnet-4-6-think":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-6-thinking":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-6@default":{"i":"ipt","t":1,"r":1},"claude-sonnet-4-6@eu":{"i":"ipt","t":1,"r":1},"claude-sonnet-4:thinking":{"i":"ipt","t":1,"r":1},"claude-sonnet-4:thinking:1024":{"i":"ipt","t":1,"r":1},"claude-sonnet-4:thinking:32768":{"i":"ipt","t":1,"r":1},"claude-sonnet-4:thinking:64000":{"i":"ipt","t":1,"r":1},"claude-sonnet-4:thinking:8192":{"i":"ipt","t":1,"r":1},"claude-sonnet-4.5":{"i":"fipt","t":1,"r":1},"claude-sonnet-4.5:batch":{"i":"fit","t":1,"r":1},"claude-sonnet-4.5:thinking":{"i":"ipt","t":1,"r":1},"claude-sonnet-4.6":{"i":"fipt","t":1,"r":1},"claude-sonnet-4.6:batch":{"i":"fit","t":1,"r":1},"claude-sonnet-4.6:thinking":{"i":"ipt","t":1,"r":1},"claude-sonnet-4@20250514":{"i":"ipt","t":1,"r":1},"claude-sonnet-4@eu":{"i":"ipt","t":1,"r":1},"claude-sonnet-5":{"i":"fipt","t":1,"r":1,"f":1},"claude-sonnet-5-free":{"i":"ipt","t":1,"r":1,"f":1},"claude-sonnet-5:batch":{"i":"fit","t":1,"r":1},"claude-sonnet-5:thinking":{"i":"ipt","t":1,"r":1},"claude-sonnet-5@default":{"i":"ipt","t":1,"r":1},"claude-sonnet-5@eu":{"i":"ipt","t":1,"r":1},"claude-sonnet-latest":{"i":"fipt","t":1,"r":1},"claudinio":{"i":"aitv","t":1,"r":1},"claudius":{"i":"aitv","t":1,"r":1},"claw-high":{"t":1,"r":1},"claw-low":{"t":1,"r":1},"claw-medium":{"t":1,"r":1},"code-max":{"i":"it","t":1,"r":1},"code-prime":{"t":1,"r":1},"code-standard":{"t":1,"r":1},"codestral":{"t":1},"codestral-2501":{"t":1},"codestral-2508":{"i":"fpt","t":1},"codestral-2508:batch":{"i":"ft","t":1},"codestral-latest":{"t":1},"codex-mini":{"t":1,"r":1},"coding-glm-5.1":{"t":1,"r":1},"coding-glm-5.1-free":{"t":1,"r":1,"f":1},"coding-minimax-m2.7":{"t":1,"r":1},"coding-minimax-m2.7-free":{"t":1,"r":1,"f":1},"coding-minimax-m2.7-highspeed":{"t":1,"r":1},"coding-router":{"t":1,"r":1},"coding-router:high":{"t":1,"r":1},"coding-router:low":{"t":1,"r":1},"coding-router:max":{"t":1,"r":1},"coding-router:medium":{"t":1,"r":1},"coding-xiaomi-mimo-v2.5":{"i":"aitv","t":1,"r":1},"coding-xiaomi-mimo-v2.5-pro":{"t":1,"r":1},"cogito-v2-1-671b":{"r":1},"cohere--command-a-reasoning":{"t":1,"r":1},"cohere-command-a":{"t":1,"r":1},"cohere-embed-v-4-0":{"i":"it"},"command-a":{"t":1},"command-a-03-2025":{"t":1},"command-a-plus-05-2026":{"i":"it","t":1,"r":1},"command-a-plus-05-2026-bf16":{"i":"it"},"command-a-reasoning-08-2025":{"t":1,"r":1},"command-a-translate-08-2025":{"t":1},"command-a-vision-07-2025":{"i":"it"},"command-r-08-2024":{"t":1},"command-r-plus-08-2024":{"t":1},"command-r7b-12-2024":{"t":1},"command-r7b-arabic-02-2025":{"t":1},"cosmos-predict1-5b":{"i":"itv","f":1},"cosmos-reason1-7b":{"i":"it"},"cosmos-reason2-2b":{"i":"it"},"cosmos-reason2-32b":{"i":"it"},"cosmos-reason2-8b":{"i":"itv","t":1,"r":1,"f":1},"cosmos-transfer1-7b":{"i":"itv","f":1},"cosmos-transfer2_5-2b":{"i":"itv","f":1},"custom":{"i":"it","t":1,"f":1},"cyber-tiel-coder-35b-a3b-gguf":{"i":"it"},"cyber-tiel-coder-35b-a3b-gguf-mtp":{"i":"it"},"cydonia-24b-v4.1":{"t":1},"dall-e-3":{"t":1},"dam-3b":{"i":"it"},"dam-3b-self-contained":{"i":"it"},"darkc0de_muse-glimmer-30b-heretic-gguf":{"i":"it"},"databricks-claude-haiku-4-5":{"i":"ipt","t":1,"r":1},"databricks-claude-opus-4-1":{"i":"ipt","t":1,"r":1},"databricks-claude-opus-4-5":{"i":"ipt","t":1,"r":1},"databricks-claude-opus-4-6":{"i":"ipt","t":1,"r":1},"databricks-claude-opus-4-7":{"i":"ipt","t":1,"r":1},"databricks-claude-sonnet-4":{"i":"ipt","t":1,"r":1},"databricks-claude-sonnet-4-5":{"i":"ipt","t":1,"r":1},"databricks-claude-sonnet-4-6":{"i":"ipt","t":1,"r":1},"databricks-deepseek-v4-flash-0731":{"t":1,"r":1},"databricks-deepseek-v4-pro-0813":{"t":1,"r":1},"databricks-gemini-2-5-flash":{"i":"aiptv","t":1,"r":1},"databricks-gemini-2-5-pro":{"i":"aiptv","t":1,"r":1},"databricks-gemini-3-1-flash-lite":{"i":"aiptv","t":1,"r":1},"databricks-gemini-3-1-pro":{"i":"aiptv","t":1,"r":1},"databricks-gemini-3-flash":{"i":"aiptv","t":1,"r":1},"databricks-gemini-3-pro":{"i":"aiptv","t":1,"r":1},"databricks-glm-5-2":{"t":1,"r":1},"databricks-gpt-5":{"i":"it","t":1,"r":1},"databricks-gpt-5-1":{"i":"it","t":1,"r":1},"databricks-gpt-5-2":{"i":"it","t":1,"r":1},"databricks-gpt-5-4":{"i":"ipt","t":1,"r":1},"databricks-gpt-5-4-mini":{"i":"it","t":1,"r":1},"databricks-gpt-5-4-nano":{"i":"it","t":1,"r":1},"databricks-gpt-5-5":{"i":"ipt","t":1,"r":1},"databricks-gpt-5-6-luna":{"i":"ipt","t":1,"r":1},"databricks-gpt-5-6-sol":{"i":"ipt","t":1,"r":1},"databricks-gpt-5-6-terra":{"i":"ipt","t":1,"r":1},"databricks-gpt-5-mini":{"i":"it","t":1,"r":1},"databricks-gpt-5-nano":{"i":"it","t":1,"r":1},"databricks-gpt-oss-120b":{"t":1,"r":1},"databricks-gpt-oss-120b@eu":{"t":1,"r":1},"databricks-gpt-oss-20b":{"t":1,"r":1},"databricks-gpt-oss-20b@eu":{"t":1,"r":1},"databricks-inkling":{"i":"it","t":1,"r":1},"databricks-kimi-k2-7-code":{"i":"itv","t":1,"r":1},"deep-deepseek-v4-flash":{"t":1,"r":1},"deep-deepseek-v4-pro":{"t":1,"r":1},"deep-research-max-preview-04-2026":{"i":"aiptv","t":1,"r":1},"deep-research-preview-04-2026":{"i":"aiptv","t":1,"r":1},"deepseek-3.2":{"t":1,"r":1},"deepseek-4-flash":{"t":1},"deepseek-chat":{"i":"pt","t":1},"deepseek-chat-cheaper":{"i":"pt","t":1},"deepseek-chat-v3-0324":{"t":1},"deepseek-chat-v3.1":{"t":1,"r":1},"deepseek-flash":{"i":"it","t":1,"r":1},"deepseek-flash-latest":{"i":"it","t":1,"r":1},"deepseek-latest":{"t":1,"r":1},"deepseek-math-v2":{"r":1},"deepseek-ocr":{"i":"it","f":1},"deepseek-ocr-2":{"i":"it","f":1},"deepseek-ocr-2-6bit":{"i":"it"},"deepseek-pro-latest":{"t":1,"r":1},"deepseek-r1":{"t":1,"r":1,"f":1},"deepseek-r1-0528":{"t":1,"r":1},"deepseek-r1-0528-qwen3-8b":{"r":1},"deepseek-r1-distill-llama-70b":{"t":1,"r":1},"deepseek-r1-distill-llama-70b-abliterated":{"r":1},"deepseek-r1-distill-llama-8b":{"t":1,"r":1,"f":1},"deepseek-r1-distill-qwen-1-5b":{"t":1,"r":1,"f":1},"deepseek-r1-distill-qwen-14b":{"t":1,"r":1},"deepseek-r1-distill-qwen-32b":{"t":1,"r":1},"deepseek-r1-distill-qwen-32b-abliterated":{"r":1},"deepseek-r1-distill-qwen-7b":{"t":1,"r":1},"deepseek-r1-turbo":{"t":1,"r":1},"deepseek-reasoner":{"t":1,"r":1},"deepseek-tng-r1t2-chimera":{"t":1},"deepseek-v3":{"t":1,"f":1},"deepseek-v3-0324":{"t":1},"deepseek-v3-1":{"t":1,"r":1},"deepseek-v3-2":{"t":1,"r":1},"deepseek-v3-2-exp":{"t":1},"deepseek-v3-turbo":{"t":1},"deepseek-v3.1":{"i":"pt","t":1,"r":1},"deepseek-v3.1-maas":{"i":"pt","t":1,"r":1},"deepseek-v3.1-terminus":{"t":1,"r":1},"deepseek-v3.1-terminus-thinking":{"r":1},"deepseek-v3.1-terminus:thinking":{"t":1},"deepseek-v3.1:thinking":{"t":1},"deepseek-v3.2":{"i":"ipt","t":1,"r":1,"f":1},"deepseek-v3.2-251201":{"t":1,"r":1},"deepseek-v3.2-exp":{"t":1,"r":1},"deepseek-v3.2-exp-thinking":{"r":1},"deepseek-v3.2-maas":{"i":"pt","t":1,"r":1},"deepseek-v3.2-nvfp4":{"t":1,"r":1},"deepseek-v3.2-speciale":{"r":1},"deepseek-v3.2-tee":{"t":1,"r":1},"deepseek-v3.2-thinking":{"t":1,"r":1},"deepseek-v3.2:thinking":{"i":"pt","t":1,"r":1},"deepseek-v4-1-flash":{"i":"it","t":1,"r":1},"deepseek-v4-flash":{"i":"it","t":1,"r":1,"f":1},"deepseek-v4-flash-0423":{"t":1,"r":1},"deepseek-v4-flash-0731":{"t":1,"r":1,"f":1},"deepseek-v4-flash-0731-284b":{"t":1,"r":1},"deepseek-v4-flash-0731-fast":{"t":1,"r":1},"deepseek-v4-flash-0731-tee":{"t":1,"r":1},"deepseek-v4-flash-0731:batch":{"t":1,"r":1},"deepseek-v4-flash-0731:thinking":{"t":1,"r":1},"deepseek-v4-flash-0731@eu":{"t":1,"r":1},"deepseek-v4-flash-el":{"t":1,"r":1},"deepseek-v4-flash-flex":{"t":1,"r":1},"deepseek-v4-flash-free":{"t":1,"r":1,"f":1},"deepseek-v4-flash-ga-260731":{"t":1,"r":1},"deepseek-v4-flash-latest":{"t":1,"r":1},"deepseek-v4-flash-vision-exp":{"i":"it","t":1,"r":1},"deepseek-v4-flash-vision-exp-ablit-exl3-kalibrated":{"i":"it"},"deepseek-v4-flash-vision-exp-abliterated":{"i":"it"},"deepseek-v4-flash-vision-exp-fp8-dspark":{"i":"it"},"deepseek-v4-flash-vision-exp-gguf":{"i":"it"},"deepseek-v4-flash-vision-exp:batch":{"i":"it","t":1,"r":1},"deepseek-v4-flash:0731":{"t":1,"r":1},"deepseek-v4-flash:free":{"t":1,"r":1,"f":1},"deepseek-v4-flash:thinking":{"t":1,"r":1},"deepseek-v4-pro":{"t":1,"r":1,"f":1},"deepseek-v4-pro-0423":{"t":1,"r":1},"deepseek-v4-pro-0813":{"t":1,"r":1,"f":1},"deepseek-v4-pro-0813:batch":{"t":1,"r":1},"deepseek-v4-pro-0813:thinking":{"t":1,"r":1},"deepseek-v4-pro-0813@eu":{"t":1,"r":1},"deepseek-v4-pro-el":{"t":1,"r":1},"deepseek-v4-pro-ga-260813":{"t":1,"r":1},"deepseek-v4-pro:0813":{"t":1,"r":1},"deepseek-v4-pro:free":{"t":1,"r":1,"f":1},"deepseek-v4-pro:thinking":{"t":1,"r":1},"deepseek-v4-pro@eu":{"t":1,"r":1},"deepseek-v4.1-flash":{"i":"it","t":1,"r":1,"f":1},"deepseek-v4.1-flash-fp8-gguf":{"i":"it"},"deepseek-v4.1-flash:thinking":{"i":"it","t":1,"r":1},"deepseek-v4.1-flash@eu":{"i":"it","t":1,"r":1},"deepseek-v4p1-flash":{"i":"it","t":1,"r":1},"deepseek-vl-1.3b-chat":{"i":"it"},"deepseek-vl-7b-chat":{"i":"it"},"deepseek-vl2-tiny":{"i":"it"},"deepseek.r1-v1:0":{"r":1},"deepseek.v3-v1:0":{"t":1,"r":1},"deepseek.v3.2":{"t":1,"r":1},"devstral-2":{"t":1},"devstral-2-123b-instruct-2512":{"t":1},"devstral-2-123b-instruct-2512-int4-autoround":{"t":1,"f":1},"devstral-2512":{"i":"fpt","t":1},"devstral-latest":{"t":1},"devstral-latest@eu":{"t":1},"devstral-medium-2507":{"t":1},"devstral-medium-latest":{"t":1},"devstral-small-2":{"i":"it","t":1},"devstral-small-2-24b-instruct-2512-4bit":{"i":"it"},"devstral-small-2505":{"t":1},"devstral-small-2507":{"t":1},"diegocropper":{"i":"it"},"diffusiongemma-26b-a4b-it":{"i":"it","t":1,"r":1},"diffusiongemma-26b-a4b-it-fp8-dynamic":{"i":"it"},"diffusiongemma-26b-a4b-it-gguf":{"i":"it"},"diffusiongemma-26b-a4b-it-nvfp4":{"i":"it"},"dirk-qwen3.8-27b-gguf":{"i":"it"},"dola-seed-2.0-code":{"i":"it"},"dola-seed-2.0-pro":{"r":1},"dots-3-note-preview:free":{"i":"it","t":1,"r":1,"f":1},"dots.mocr":{"i":"it"},"dots.ocr":{"i":"it"},"doubao-1.5-pro-32k":{"t":1},"doubao-1.5-thinking-pro":{"t":1,"r":1},"doubao-1.5-vision-pro":{"i":"itv"},"doubao-1.5-vision-pro-32k":{"i":"it"},"doubao-seed-1-6":{"t":1,"r":1},"doubao-seed-1-6-251015":{"t":1,"r":1},"doubao-seed-1-6-flash":{"i":"it","t":1},"doubao-seed-1-6-flash-250828":{"i":"it","t":1,"r":1},"doubao-seed-1-6-thinking-250715":{"i":"it","t":1,"r":1},"doubao-seed-1-6-vision":{"i":"it","t":1},"doubao-seed-1-6-vision-250815":{"i":"it","t":1,"r":1},"doubao-seed-1-8":{"i":"it","t":1,"r":1},"doubao-seed-1-8-251215":{"i":"it","t":1},"doubao-seed-1-8-251228":{"i":"it","t":1,"r":1},"doubao-seed-1.6":{"i":"itv","t":1,"r":1},"doubao-seed-1.6-flash":{"i":"itv","t":1,"r":1},"doubao-seed-1.6-thinking":{"i":"itv","t":1,"r":1},"doubao-seed-1.8":{"i":"itv","t":1,"r":1},"doubao-seed-2-0-code-preview":{"i":"itv","t":1,"r":1},"doubao-seed-2-0-code-preview-260215":{"i":"itv","t":1,"r":1},"doubao-seed-2-0-lite-260428":{"i":"itv","t":1,"r":1},"doubao-seed-2-0-mini-260428":{"i":"itv","t":1,"r":1},"doubao-seed-2-0-pro":{"i":"itv","t":1,"r":1},"doubao-seed-2-0-pro-260215":{"i":"itv","t":1,"r":1},"doubao-seed-2-1-pro-260628":{"i":"itv","t":1,"r":1},"doubao-seed-2-1-turbo-260628":{"i":"itv","t":1,"r":1},"doubao-seed-2.0-code":{"i":"itv","t":1,"r":1},"doubao-seed-2.0-lite":{"i":"itv","t":1,"r":1,"f":1},"doubao-seed-2.0-mini":{"i":"itv","t":1,"r":1},"doubao-seed-2.0-pro":{"i":"itv","t":1,"r":1},"doubao-seed-2.1-pro":{"i":"itv","t":1,"r":1},"doubao-seed-2.1-turbo":{"i":"itv","t":1,"r":1,"f":1},"doubao-seed-character":{"i":"itv","t":1,"r":1},"doubao-seed-character-260628":{"i":"itv","t":1,"r":1},"doubao-seed-code":{"i":"it","t":1,"r":1},"doubao-seed-evolving":{"i":"itv","t":1,"r":1,"f":1},"dracarys-llama-3.1-70b-instruct":{"t":1,"f":1},"droplychee-2.2":{"i":"it"},"duo-chat-fable-5":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-fable-5-1":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-1":{"i":"it","t":1,"r":1,"f":1},"duo-chat-gpt-5-2":{"i":"it","t":1,"r":1,"f":1},"duo-chat-gpt-5-2-codex":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-3-codex":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-4":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-4-mini":{"i":"it","t":1,"r":1,"f":1},"duo-chat-gpt-5-4-nano":{"i":"it","t":1,"r":1,"f":1},"duo-chat-gpt-5-5":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-6-luna":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-6-sol":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-6-terra":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-gpt-5-codex":{"i":"it","t":1,"r":1,"f":1},"duo-chat-gpt-5-mini":{"i":"it","t":1,"r":1,"f":1},"duo-chat-gpt-6-astra":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-haiku-4-5":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-opus-4-5":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-opus-4-6":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-opus-4-7":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-opus-4-8":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-opus-5":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-sonnet-4-5":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-sonnet-4-6":{"i":"ipt","t":1,"r":1,"f":1},"duo-chat-sonnet-5":{"i":"ipt","t":1,"r":1,"f":1},"e2e":{"i":"ipt","t":1,"r":1},"eagle2.5-8b":{"i":"it"},"echo":{"t":1,"r":1},"efficient":{"i":"it","t":1,"r":1},"elevenlabs-music":{"t":1},"elevenlabs-v2.5-turbo":{"t":1},"elevenlabs-v3":{"t":1},"emu3-chat-hf":{"i":"it"},"endless-frontier_bigbang-v1-gguf":{"i":"it"},"ernie-4.5-21b-a3b":{"t":1},"ernie-4.5-21b-a3b-thinking":{"r":1},"ernie-4.5-300b-a47b":{"t":1},"ernie-4.5-300b-a47b-paddle":{"t":1},"ernie-4.5-vl-28b-a3b":{"i":"it","t":1,"r":1},"ernie-4.5-vl-28b-a3b-pt":{"i":"it"},"ernie-4.5-vl-28b-a3b-thinking":{"i":"itv","t":1,"r":1},"ernie-4.5-vl-424b-a47b":{"i":"it","t":1,"r":1},"ernie-5.0-thinking-preview":{"i":"itv","t":1,"r":1},"ernie-5.1:thinking":{"r":1},"ernie-x1.1-preview":{"i":"pt"},"esm2-650m":{"f":1},"esmfold":{"f":1},"eu.amazon.nova-2-lite-v1:0":{"i":"iptv","t":1,"r":1},"eu.amazon.nova-lite-v1:0":{"i":"iptv","t":1},"eu.amazon.nova-micro-v1:0":{"t":1},"eu.amazon.nova-pro-v1:0":{"i":"iptv","t":1},"eu.anthropic.claude-fable-5":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-haiku-4-5-20251001-v1:0":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-opus-4-5-20251101-v1:0":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-opus-4-6-v1":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-opus-4-7":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-opus-4-8":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-opus-5":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-sonnet-4-20250514-v1:0":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-sonnet-4-5-20250929-v1:0":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-sonnet-4-6":{"i":"ipt","t":1,"r":1},"eu.anthropic.claude-sonnet-5":{"i":"ipt","t":1,"r":1},"eu.mistral.pixtral-large-2502-v1:0":{"i":"it","t":1},"exaone-4.5-33b":{"i":"it"},"exaone-4.5-33b-awq":{"i":"it"},"exaone-4.5-33b-fp8":{"i":"it"},"fara1.5-27b-gguf":{"i":"it"},"fara1.5-4b-gguf":{"i":"it"},"fara1.5-9b-gguf":{"i":"it"},"fast":{"i":"ipt","t":1,"r":1},"faster-whisper-large-v3":{"i":"a","f":1},"fastvlm-7b":{"i":"it"},"florence-2-base":{"i":"it"},"florence-2-base-ft":{"i":"it"},"florence-2-base-promptgen-v2.0":{"i":"it"},"florence-2-large":{"i":"it"},"florence-2-large-ft":{"i":"it"},"florence-2-vqajp2":{"i":"it"},"flux_1-kontext-dev":{"i":"it","f":1},"flux_1-schnell":{"f":1},"flux_2-klein-4b":{"i":"it","f":1},"flux.1-dev":{"f":1},"free":{"i":"it","t":1,"r":1,"f":1},"frontier":{"i":"ipt","t":1,"r":1},"fugu":{"i":"it","t":1,"r":1},"fugu-max":{"i":"fipt","t":1,"r":1},"fugu-ultra":{"i":"it","t":1,"r":1},"fugu-ultra-20260615":{"i":"it","t":1,"r":1},"fugu-ultra-v1-0":{"i":"it","t":1,"r":1},"fugu-ultra-v1-1":{"i":"it","t":1,"r":1},"fugu-ultra-v1.1":{"i":"it","t":1,"r":1},"fugu-ultra-v2":{"i":"fipt","t":1,"r":1},"fugu-ultra-v2-0":{"i":"it","t":1,"r":1},"fugu-ultra-v2.0":{"i":"it","t":1,"r":1},"fusion":{"i":"ipt","t":1,"r":1},"fusion-flash":{"t":1,"r":1},"fusion-mini":{"i":"ipt","t":1,"r":1},"fuyu-8b":{"i":"it"},"gelab-zero-4b-preview":{"i":"it","t":1},"gemini-2-5-flash":{"i":"aiptv","t":1,"r":1,"f":1},"gemini-2-5-flash-lite":{"i":"aiptv","t":1,"r":1,"f":1},"gemini-2.0-flash":{"i":"aitv","t":1},"gemini-2.0-flash-lite":{"i":"aitv","t":1,"r":1},"gemini-2.0-pro-exp-02-05":{"i":"ait"},"gemini-2.0-pro-reasoner":{"i":"at"},"gemini-2.5-computer-use-preview-10-2025":{"i":"it","t":1,"r":1},"gemini-2.5-flash":{"i":"afiptv","t":1,"r":1},"gemini-2.5-flash-image":{"i":"aiptv","r":1},"gemini-2.5-flash-lite":{"i":"afiptv","t":1,"r":1},"gemini-2.5-flash-lite-preview-06-17":{"i":"aitv","t":1,"r":1},"gemini-2.5-flash-lite-preview-09-2025":{"i":"aiptv","t":1,"r":1},"gemini-2.5-flash-lite-preview-09-2025-thinking":{"i":"aipt","t":1,"r":1},"gemini-2.5-flash-lite:batch":{"i":"afitv","t":1,"r":1},"gemini-2.5-flash-lite@eu":{"i":"aiptv","t":1,"r":1},"gemini-2.5-flash-nothink":{"i":"it","t":1},"gemini-2.5-flash-nothinking":{"i":"aiptv"},"gemini-2.5-flash-preview-04-17":{"i":"ait","r":1},"gemini-2.5-flash-preview-04-17:thinking":{"i":"ait","r":1},"gemini-2.5-flash-preview-05-20":{"i":"aitv","t":1,"r":1},"gemini-2.5-flash-preview-05-20:thinking":{"i":"it","r":1},"gemini-2.5-flash-preview-09-2025":{"i":"aipt","t":1,"r":1},"gemini-2.5-flash-preview-09-2025-thinking":{"i":"aipt","t":1,"r":1},"gemini-2.5-flash:batch":{"i":"afitv","t":1,"r":1},"gemini-2.5-flash@eu":{"i":"aiptv","t":1,"r":1},"gemini-2.5-pro":{"i":"afiptv","t":1,"r":1},"gemini-2.5-pro-exp-03-25":{"i":"ait","r":1},"gemini-2.5-pro-preview":{"i":"afipt","t":1,"r":1},"gemini-2.5-pro-preview-03-25":{"i":"ait","r":1},"gemini-2.5-pro-preview-05-06":{"i":"ait","r":1},"gemini-2.5-pro-preview-06-05":{"i":"aitv","t":1,"r":1},"gemini-2.5-pro:batch":{"i":"afitv","t":1,"r":1},"gemini-2.5-pro@eu":{"i":"aiptv","t":1,"r":1},"gemini-3-1-flash-lite":{"i":"aiptv","t":1,"r":1,"f":1},"gemini-3-1-flash-tts":{"f":1},"gemini-3-1-pro":{"i":"aiptv","t":1,"r":1,"f":1},"gemini-3-1-pro-preview":{"i":"aiptv","t":1,"r":1},"gemini-3-5-flash":{"i":"aiptv","t":1,"r":1,"f":1},"gemini-3-5-flash-lite":{"i":"aiptv","t":1,"r":1},"gemini-3-6-flash":{"i":"aiptv","t":1,"r":1,"f":1},"gemini-3-7-flash":{"i":"aiptv","t":1,"r":1,"f":1},"gemini-3-8-flash":{"i":"aitv","t":1,"r":1},"gemini-3-flash":{"i":"aiptv","t":1,"r":1},"gemini-3-flash-preview":{"i":"afiptv","t":1,"r":1},"gemini-3-flash-preview-thinking":{"i":"aitv","r":1},"gemini-3-flash-preview:batch":{"i":"afitv","t":1,"r":1},"gemini-3-pro":{"i":"aiptv","t":1,"r":1},"gemini-3-pro-image":{"i":"ipt","t":1,"r":1},"gemini-3-pro-image-preview":{"i":"ipt","r":1},"gemini-3-pro-preview":{"i":"aiptv","t":1,"r":1},"gemini-3.0-flash-preview":{"i":"aiptv","t":1,"r":1},"gemini-3.0-pro-image-preview":{"i":"it"},"gemini-3.0-pro-preview":{"i":"aiptv","t":1,"r":1},"gemini-3.1-flash-image":{"i":"iptv","t":1,"r":1},"gemini-3.1-flash-image-preview":{"i":"ipt","r":1},"gemini-3.1-flash-lite":{"i":"afiptv","t":1,"r":1},"gemini-3.1-flash-lite-image":{"i":"ipt","t":1,"r":1},"gemini-3.1-flash-lite-preview":{"i":"afiptv","t":1,"r":1},"gemini-3.1-flash-lite:batch":{"i":"afitv","t":1,"r":1},"gemini-3.1-flash-lite@eu":{"i":"aiptv","t":1,"r":1},"gemini-3.1-flash-lite@us":{"i":"aiptv","t":1,"r":1},"gemini-3.1-flash-live-preview":{"i":"aitv","t":1,"r":1},"gemini-3.1-flash-tts-preview":{"r":1},"gemini-3.1-pro":{"i":"aiptv","t":1,"r":1},"gemini-3.1-pro-preview":{"i":"afiptv","t":1,"r":1},"gemini-3.1-pro-preview-customtools":{"i":"afiptv","t":1,"r":1},"gemini-3.1-pro-preview-high":{"i":"aitv","t":1,"r":1},"gemini-3.1-pro-preview-low":{"i":"ait","t":1,"r":1},"gemini-3.1-pro-preview:batch":{"i":"afitv","t":1,"r":1},"gemini-3.5-flash":{"i":"afiptv","t":1,"r":1},"gemini-3.5-flash-lite":{"i":"afiptv","t":1,"r":1},"gemini-3.5-flash-lite:batch":{"i":"afitv","t":1,"r":1},"gemini-3.5-flash-lite@eu":{"i":"aiptv","t":1,"r":1},"gemini-3.5-flash-lite@us":{"i":"aiptv","t":1,"r":1},"gemini-3.5-flash-thinking":{"i":"aiptv","t":1,"r":1},"gemini-3.5-flash:batch":{"i":"afitv","t":1,"r":1},"gemini-3.5-flash@eu":{"i":"aiptv","t":1,"r":1},"gemini-3.5-flash@us":{"i":"aiptv","t":1,"r":1},"gemini-3.5-live-translate-preview":{"i":"a"},"gemini-3.5-transcribe":{"i":"a"},"gemini-3.5-transcribe-live":{"i":"a"},"gemini-3.6-flash":{"i":"afiptv","t":1,"r":1},"gemini-3.6-flash:batch":{"i":"afitv","t":1,"r":1},"gemini-3.6-flash@eu":{"i":"aiptv","t":1,"r":1},"gemini-3.6-flash@us":{"i":"aiptv","t":1,"r":1},"gemini-3.7-flash":{"i":"afiptv","t":1,"r":1},"gemini-3.7-flash-eu":{"i":"aiptv","t":1,"r":1},"gemini-3.7-flash:batch":{"i":"afitv","t":1,"r":1},"gemini-3.7-flash@eu":{"i":"aiptv","t":1,"r":1},"gemini-3.7-flash@us":{"i":"aiptv","t":1,"r":1},"gemini-3.8-flash":{"i":"afiptv","t":1,"r":1},"gemini-3.8-flash:batch":{"i":"afitv","t":1,"r":1},"gemini-3.8-flash@eu":{"i":"aiptv","t":1,"r":1},"gemini-3.8-flash@us":{"i":"aiptv","t":1,"r":1},"gemini-3.8-live":{"i":"at"},"gemini-3.8-live-extended-thinking":{"i":"at"},"gemini-deep-research":{"i":"itv","t":1,"r":1},"gemini-embedding-2":{"i":"aiptv"},"gemini-exp-1206":{"i":"ait"},"gemini-flash-latest":{"i":"afiptv","t":1,"r":1},"gemini-flash-lite-latest":{"i":"aiptv","t":1,"r":1},"gemini-omni-flash-preview":{"i":"iptv","r":1},"gemini-pro-latest":{"i":"afiptv","t":1,"r":1},"gemini-robotics-er-1.6-preview":{"i":"aitv","t":1,"r":1},"gemma-2-2b-it":{"t":1,"f":1},"gemma-3":{"i":"it","t":1},"gemma-3-12b":{"i":"it","t":1},"gemma-3-12b-it":{"i":"ipt","t":1,"f":1},"gemma-3-12b-it-4bit":{"i":"it"},"gemma-3-12b-it-gguf":{"i":"it"},"gemma-3-12b-it-int4-awq":{"i":"it"},"gemma-3-12b-it-lenientchatfix":{"i":"it"},"gemma-3-12b-it-qat-4bit":{"i":"it"},"gemma-3-12b-it-qat-gguf":{"i":"it"},"gemma-3-12b-it-qat-q4_0-unquantized":{"i":"it"},"gemma-3-12b-it-quantized-w4a16":{"i":"it"},"gemma-3-12b-it-quantized.w4a16":{"i":"it"},"gemma-3-12b-pt":{"i":"it"},"gemma-3-27b":{"i":"it","f":1},"gemma-3-27b-it":{"i":"ipt","t":1,"r":1},"gemma-3-27b-it-abliterated-gguf":{"i":"it"},"gemma-3-27b-it-fp8-dynamic":{"i":"it"},"gemma-3-27b-it-gguf":{"i":"it"},"gemma-3-27b-it-gptq-4b-128g":{"i":"it"},"gemma-3-27b-it-int4-awq":{"i":"it"},"gemma-3-27b-it-qat-4bit":{"i":"it"},"gemma-3-27b-it-qat-w4a16-g128":{"i":"it"},"gemma-3-27b-it-quantized.w4a16":{"i":"it"},"gemma-3-27b-lenientchatfix":{"i":"it"},"gemma-3-27b-pt":{"i":"it"},"gemma-3-4b-it":{"i":"ipt","t":1,"f":1},"gemma-3-4b-it-8bit":{"i":"it"},"gemma-3-4b-it-gguf":{"i":"it"},"gemma-3-4b-it-qat-4bit":{"i":"it"},"gemma-3-4b-it-qat-compressed-tensors":{"i":"it"},"gemma-3-4b-it-qat-gguf":{"i":"it"},"gemma-3-4b-it-unsloth-bnb-4bit":{"i":"it"},"gemma-3-4b-it-vl-heretic-4-horsemen-uncensored":{"i":"it"},"gemma-3-4b-pt":{"i":"it","t":1,"r":1},"gemma-3-gaia-pt-br-4b-it":{"i":"it"},"gemma-3-tiny-random":{"i":"it"},"gemma-3n-e2b-it":{"i":"it","t":1,"f":1},"gemma-3n-e2b-it-gguf":{"i":"it"},"gemma-3n-e4b-it":{"i":"it","t":1,"f":1},"gemma-3n-e4b-it-gguf":{"i":"it"},"gemma-3n-e4b-it-mlx-4bit":{"i":"it"},"gemma-3n-e4b-it-mlx-6bit":{"i":"it"},"gemma-3n-e4b-it-mlx-8bit":{"i":"it"},"gemma-3n-e4b-it-mlx-bf16":{"i":"it"},"gemma-4":{"i":"it","t":1,"r":1},"gemma-4-12b-awq":{"i":"it"},"gemma-4-12b-it":{"i":"aitv","t":1,"r":1},"gemma-4-12b-it-gguf":{"i":"it"},"gemma-4-12b-it-nvfp4":{"i":"it"},"gemma-4-12b-it-qat-4bit":{"i":"it"},"gemma-4-12b-it-semancer":{"i":"it","t":1,"r":1},"gemma-4-12b-it-station-keeper":{"i":"it","t":1,"r":1},"gemma-4-12b-it-uncensored-gguf":{"i":"it"},"gemma-4-26b-a4b":{"i":"itv","t":1,"r":1},"gemma-4-26b-a4b-it":{"i":"iptv","t":1,"r":1},"gemma-4-26b-a4b-it-4bit":{"i":"it"},"gemma-4-26b-a4b-it-awq-4bit":{"i":"it"},"gemma-4-26b-a4b-it-awq-8bit":{"i":"it"},"gemma-4-26b-a4b-it-chimerax":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-it-darksoul":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-it-fp8-dynamic":{"i":"it"},"gemma-4-26b-a4b-it-gguf":{"i":"it"},"gemma-4-26b-a4b-it-luminous":{"i":"it","t":1},"gemma-4-26b-a4b-it-mlx-4bit":{"i":"it"},"gemma-4-26b-a4b-it-mlx-5bit":{"i":"it"},"gemma-4-26b-a4b-it-mlx-6bit":{"i":"it"},"gemma-4-26b-a4b-it-mlx-8bit":{"i":"it"},"gemma-4-26b-a4b-it-moonlight":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-it-musica":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-it-nvfp4":{"i":"it"},"gemma-4-26b-a4b-it-opusdistill":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-it-qat-awq-int4":{"i":"it"},"gemma-4-26b-a4b-it-qat-gguf":{"i":"it"},"gemma-4-26b-a4b-it-qat-mlx-4bit":{"i":"it"},"gemma-4-26b-a4b-it-qat-q4_0-gguf":{"i":"it"},"gemma-4-26b-a4b-it-qat-q4_0-uncensored-heretic-nvfp4":{"i":"it"},"gemma-4-26b-a4b-it-qat-q4_0-unquantized":{"i":"it"},"gemma-4-26b-a4b-it-shadowsiren":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-it-ultra-uncensored-heretic-gguf":{"i":"it"},"gemma-4-26b-a4b-it-uncensored-heretic-gguf":{"i":"it"},"gemma-4-26b-a4b-it-w4a16":{"i":"it"},"gemma-4-26b-a4b-it:free":{"i":"itv","t":1,"r":1,"f":1},"gemma-4-26b-a4b-it:thinking":{"i":"itv","t":1,"r":1},"gemma-4-26b-a4b-meromero":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-meromero:thinking":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-uncensored":{"i":"it","t":1,"r":1},"gemma-4-26b-a4b-uncensored:thinking":{"i":"it","t":1,"r":1},"gemma-4-31b":{"i":"it","t":1,"r":1,"f":1},"gemma-4-31b-claude-4.6-opus-reasoning-distilled":{"i":"it","t":1,"r":1},"gemma-4-31b-cognitive-unshackled":{"i":"it","t":1,"r":1},"gemma-4-31b-darkidol":{"i":"it","t":1,"r":1},"gemma-4-31b-garnetv2":{"i":"it","t":1,"r":1},"gemma-4-31b-it":{"i":"aiptv","t":1,"r":1,"f":1},"gemma-4-31b-it-4bit":{"i":"it"},"gemma-4-31b-it-abliterated-heretic-awq-w4a16":{"i":"it"},"gemma-4-31b-it-awq":{"i":"it"},"gemma-4-31b-it-awq-4bit":{"i":"it"},"gemma-4-31b-it-darkidol":{"i":"it","t":1,"r":1},"gemma-4-31b-it-fabled":{"i":"it","t":1,"r":1},"gemma-4-31b-it-fp8":{"i":"it","t":1,"r":1,"f":1},"gemma-4-31b-it-fp8-block":{"i":"it"},"gemma-4-31b-it-fp8-dynamic":{"i":"it"},"gemma-4-31b-it-garnet":{"i":"it","t":1,"r":1},"gemma-4-31b-it-gembrain":{"i":"it","t":1,"r":1},"gemma-4-31b-it-gemsicle":{"i":"it","t":1,"r":1},"gemma-4-31b-it-gguf":{"i":"it"},"gemma-4-31b-it-isometry":{"i":"it","t":1,"r":1},"gemma-4-31b-it-mlx-4bit":{"i":"it"},"gemma-4-31b-it-mlx-5bit":{"i":"it"},"gemma-4-31b-it-mlx-6bit":{"i":"it"},"gemma-4-31b-it-mlx-8bit":{"i":"it"},"gemma-4-31b-it-novelist":{"i":"it","t":1,"r":1},"gemma-4-31b-it-nvfp4":{"i":"it"},"gemma-4-31b-it-qat-awq-int4":{"i":"it"},"gemma-4-31b-it-qat-gguf":{"i":"it"},"gemma-4-31b-it-qat-q4_0-gguf":{"i":"it"},"gemma-4-31b-it-qat-q4_0-unquantized-assistant":{"i":"it"},"gemma-4-31b-it-qat-w4a16-ct":{"i":"it"},"gemma-4-31b-it-uncensored-heretic":{"i":"it"},"gemma-4-31b-it-uncensored-heretic-gguf":{"i":"it"},"gemma-4-31b-it-unsloth-bnb-4bit":{"i":"it"},"gemma-4-31b-it:free":{"i":"itv","t":1,"r":1,"f":1},"gemma-4-31b-it:thinking":{"i":"itv","t":1,"r":1},"gemma-4-31b-jang_4m-crack":{"i":"it"},"gemma-4-31b-meromero-v2":{"i":"it","t":1,"r":1},"gemma-4-31b-meromero-v2:thinking":{"i":"it","t":1,"r":1},"gemma-4-31b-queen":{"i":"it","t":1,"r":1},"gemma-4-31b-turbo-tee":{"i":"it","t":1,"r":1},"gemma-4-e2b-it":{"i":"ait","t":1,"r":1},"gemma-4-e2b-it-4bit":{"i":"it"},"gemma-4-e2b-it-gguf":{"i":"it"},"gemma-4-e2b-it-nvfp4":{"i":"it"},"gemma-4-e2b-it-qat-mobile":{"i":"it"},"gemma-4-e2b-it-unsloth-bnb-4bit":{"i":"it"},"gemma-4-e2b-uncensored-hauhaucs-aggressive":{"i":"it"},"gemma-4-e4b-it":{"i":"ait","t":1,"r":1},"gemma-4-e4b-it-4bit":{"i":"it"},"gemma-4-e4b-it-awq-4bit":{"i":"it"},"gemma-4-e4b-it-gguf":{"i":"it"},"gemma-4-e4b-it-iq4_xs":{"f":1},"gemma-4-e4b-it-mlx-4bit":{"f":1},"gemma-4-e4b-it-nvfp4":{"i":"it"},"gemma-4-e4b-it-nvfp4a16":{"i":"it"},"gemma-4-e4b-it-qat-mobile":{"i":"it"},"gemma-4-e4b-it-unsloth-bnb-4bit":{"i":"it"},"gemma-4-e4b-it-w4a16-autoround-gptq":{"i":"it"},"gemma-4-e4b-uncensored-hauhaucs-aggressive":{"i":"it"},"gemma-4-moe":{"i":"it"},"gemma-4-ortenzya-the-creative-wordsmith-31b-it-uncensored-heretic-gguf":{"i":"it"},"gemma-4-uncensored":{"i":"it","t":1},"gemma4":{"i":"it","t":1,"r":1,"f":1},"gemma4-12b-qat-uncensored-hauhaucs-balanced":{"i":"it"},"gemma4-26b":{"i":"it","t":1,"r":1},"gemma4-26b-a4b-it-qat-w4a16-ct":{"i":"it"},"gemma4-26b-a4b-qat-uncensored-hauhaucs-balanced-mtp":{"i":"it"},"gemma4-26b-a4b-uncensored-hauhaucs-balanced":{"i":"it"},"gemma4-31b":{"i":"it","t":1,"r":1,"f":1},"gemma4-31b-qat-uncensored-hauhaucs-balanced-mtp":{"i":"it"},"gemma4-31b:thinking":{"i":"it","t":1,"r":1},"gemma4:31b":{"i":"it","t":1,"r":1},"gliese-qwen3.5-9b-abliterated-caption":{"i":"it"},"gliguard-llmguardrails-300m":{"t":1},"gliner-pii":{"f":1},"gliner2-base-v1":{"t":1},"gliner2-large-v1":{"t":1},"gliner2-multi-large-v1":{"t":1},"gliner2-multi-v1":{"t":1},"gliner2-privacy-filter-pii-multi":{"t":1},"glm-4-32b-0414-128k":{"t":1},"glm-4-5-flash":{"t":1,"r":1,"f":1},"glm-4-6v-flash":{"i":"iptv","t":1,"r":1,"f":1},"glm-4-7-flash":{"t":1,"r":1,"f":1},"glm-4-7-flash:free":{"t":1,"r":1,"f":1},"glm-4.1v-9b-thinking":{"i":"it"},"glm-4.1v-thinking-flash":{"i":"it"},"glm-4.1v-thinking-flashx":{"i":"it"},"glm-4.5":{"t":1,"r":1,"f":1},"glm-4.5-air":{"t":1,"r":1},"glm-4.5-air:thinking":{"t":1,"r":1},"glm-4.5-airx":{"t":1},"glm-4.5-flash":{"t":1,"r":1,"f":1},"glm-4.5-flash:free":{"t":1,"r":1,"f":1},"glm-4.5-fp8":{"t":1,"r":1},"glm-4.5-x":{"t":1,"r":1},"glm-4.5:thinking":{"r":1},"glm-4.5v":{"i":"itv","t":1,"r":1},"glm-4.5v:thinking":{"i":"it","r":1},"glm-4.6":{"t":1,"r":1,"f":1},"glm-4.6-derestricted-v5":{"t":1,"r":1},"glm-4.6-original":{"t":1,"r":1},"glm-4.6-turbo:thinking":{"r":1},"glm-4.6:thinking":{"t":1,"r":1},"glm-4.6v":{"i":"itv","t":1,"r":1},"glm-4.6v-flash":{"i":"itv","t":1,"r":1},"glm-4.6v-flash-free":{"i":"itv","t":1,"r":1,"f":1},"glm-4.6v-flash-gguf":{"i":"it"},"glm-4.6v-flash-mlx-4bit":{"i":"it"},"glm-4.6v-flash-mlx-6bit":{"i":"it"},"glm-4.6v-flash-mlx-8bit":{"i":"it"},"glm-4.6v-flashx":{"i":"it","t":1,"r":1},"glm-4.6v-fp8":{"i":"it"},"glm-4.6v-original":{"i":"it"},"glm-4.7":{"i":"it","t":1,"r":1,"f":1},"glm-4.7-flash":{"t":1,"r":1,"f":1},"glm-4.7-flash-free":{"t":1,"r":1,"f":1},"glm-4.7-flash-original":{"t":1,"r":1},"glm-4.7-flash-original:thinking":{"t":1,"r":1},"glm-4.7-flash:thinking":{"t":1,"r":1},"glm-4.7-flashx":{"t":1,"r":1},"glm-4.7-free":{"t":1,"r":1,"f":1},"glm-4.7-maas":{"i":"pt","t":1,"r":1},"glm-4.7-n":{"t":1,"r":1},"glm-4.7-original":{"t":1,"r":1},"glm-4.7-original:thinking":{"t":1,"r":1},"glm-4.7:thinking":{"t":1,"r":1},"glm-5":{"t":1,"r":1,"f":1},"glm-5-1":{"t":1,"r":1,"f":1},"glm-5-2":{"t":1,"r":1,"f":1},"glm-5-2-260617":{"t":1,"r":1},"glm-5-3":{"t":1,"r":1,"f":1},"glm-5-3-flash":{"i":"iptv","t":1,"r":1,"f":1},"glm-5-fp8":{"t":1,"r":1},"glm-5-free":{"t":1,"r":1,"f":1},"glm-5-maas":{"t":1,"r":1},"glm-5-original":{"t":1,"r":1},"glm-5-original:thinking":{"t":1,"r":1},"glm-5-turbo":{"t":1,"r":1,"f":1},"glm-5:thinking":{"t":1,"r":1},"glm-5.1":{"t":1,"r":1,"f":1},"glm-5.1-fp8":{"t":1,"r":1},"glm-5.1-tee":{"t":1,"r":1},"glm-5.1-thinking":{"t":1,"r":1},"glm-5.1:thinking":{"t":1,"r":1},"glm-5.1@eu":{"t":1,"r":1},"glm-5.2":{"i":"it","t":1,"r":1,"f":1},"glm-5.2-caveman":{"t":1,"r":1},"glm-5.2-caveman-lite":{"t":1,"r":1},"glm-5.2-caveman-ultra":{"t":1,"r":1},"glm-5.2-fast":{"i":"it","t":1,"r":1},"glm-5.2-flex":{"t":1,"r":1},"glm-5.2-fp8":{"t":1,"r":1},"glm-5.2-free":{"t":1,"r":1,"f":1},"glm-5.2-highspeed":{"t":1,"r":1,"f":1},"glm-5.2-honey":{"t":1,"r":1},"glm-5.2-honey-lite":{"t":1,"r":1},"glm-5.2-honey-ultra":{"t":1,"r":1},"glm-5.2-nitro":{"t":1,"r":1},"glm-5.2-ponytail":{"t":1,"r":1},"glm-5.2-ponytail-lite":{"t":1,"r":1},"glm-5.2-ponytail-ultra":{"t":1,"r":1},"glm-5.2-short":{"t":1,"r":1},"glm-5.2-short-fast":{"t":1,"r":1},"glm-5.2-short-fast-flex":{"t":1,"r":1},"glm-5.2-short-flex":{"t":1,"r":1},"glm-5.2-tee":{"t":1,"r":1},"glm-5.2-vision-nvfp4":{"i":"it"},"glm-5.2:batch":{"t":1,"r":1},"glm-5.2:free":{"t":1,"r":1,"f":1},"glm-5.2:thinking":{"t":1,"r":1},"glm-5.2@eu":{"t":1,"r":1},"glm-5.3":{"i":"it","t":1,"r":1,"f":1},"glm-5.3-fast":{"i":"it","t":1,"r":1},"glm-5.3-flash":{"i":"iptv","t":1,"r":1,"f":1},"glm-5.3-flash-bf16":{"i":"it"},"glm-5.3-flash-fp4":{"i":"itv","t":1,"r":1},"glm-5.3-flash-free":{"i":"iptv","t":1,"r":1,"f":1},"glm-5.3-flash-mlx":{"i":"it"},"glm-5.3-flash-nvfp4":{"i":"it"},"glm-5.3-flash-tr3-4bpw":{"i":"it"},"glm-5.3-flash-uncensored":{"i":"it","t":1,"r":1},"glm-5.3-flash-uncensored-gguf":{"i":"it"},"glm-5.3-flash:batch":{"i":"itv","t":1,"r":1},"glm-5.3-flash@eu":{"i":"iptv","t":1,"r":1},"glm-5.3-fp4":{"t":1,"r":1},"glm-5.3-free":{"t":1,"r":1,"f":1},"glm-5.3-highspeed":{"t":1,"r":1,"f":1},"glm-5.3:batch":{"t":1,"r":1},"glm-5.3:thinking":{"t":1,"r":1},"glm-5.3@eu":{"t":1,"r":1},"glm-5p2":{"t":1,"r":1},"glm-5p2-fast":{"t":1,"r":1},"glm-5p3":{"t":1,"r":1},"glm-5p3-fast":{"t":1,"r":1},"glm-5p3-flash":{"i":"it","t":1,"r":1},"glm-5v-turbo":{"i":"aiptv","t":1,"r":1,"f":1},"glm-5v-turbo:thinking":{"i":"itv","t":1,"r":1},"glm-fast-latest":{"t":1,"r":1},"glm-flash-latest":{"i":"itv","t":1,"r":1},"glm-latest":{"t":1,"r":1},"glm-z1-airx":{"t":1},"glm5.2":{"t":1,"r":1},"glm5.2-fast":{"t":1,"r":1},"glm5.3":{"t":1,"r":1,"f":1},"glm5.3-754b":{"t":1,"r":1},"glm5.3-flash":{"i":"it","t":1,"r":1,"f":1},"global.amazon.nova-2-lite-v1:0":{"i":"iptv","t":1,"r":1},"global.anthropic.claude-fable-5":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-fable-5-1":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-haiku-4-5-20251001-v1:0":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-opus-4-5-20251101-v1:0":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-opus-4-6-v1":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-opus-4-7":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-opus-4-8":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-opus-5":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-sonnet-4-20250514-v1:0":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-sonnet-4-5-20250929-v1:0":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-sonnet-4-6":{"i":"ipt","t":1,"r":1},"global.anthropic.claude-sonnet-5":{"i":"ipt","t":1,"r":1},"global.openai.gpt-5.6-luna":{"i":"it","t":1,"r":1},"global.openai.gpt-5.6-sol":{"i":"it","t":1,"r":1},"global.openai.gpt-5.6-terra":{"i":"it","t":1,"r":1},"global.openai.gpt-6-astra":{"i":"it","t":1,"r":1},"global.xai.grok-4.6":{"i":"it","t":1,"r":1},"google_gemma-3-12b-it-gguf":{"i":"it"},"google_gemma-3-27b-it-gguf":{"i":"it"},"google_gemma-3-4b-it-gguf":{"i":"it"},"google_gemma-4-26b-a4b-it-gguf":{"i":"it"},"google_gemma-4-31b-it-gguf":{"i":"it"},"google_gemma-4-e2b-it-gguf":{"i":"it"},"google_gemma-4-e4b-it-gguf":{"i":"it"},"google-gemma-3-27b-it":{"i":"it","t":1},"google-gemma-4-26b-a4b-it":{"i":"itv","t":1,"r":1},"google-gemma-4-31b-it":{"i":"itv","t":1,"r":1},"google-paligemma":{"i":"it","f":1},"google.gemma-3-12b-it":{"i":"it"},"google.gemma-3-12b-it@us":{"i":"it"},"google.gemma-3-27b-it":{"i":"it"},"google.gemma-3-27b-it@us":{"i":"it"},"google.gemma-3-4b-it":{"i":"it"},"google.gemma-3-4b-it@us":{"i":"it"},"google.gemma-4-26b-a4b":{"i":"itv","t":1,"r":1},"google.gemma-4-31b":{"i":"itv","t":1,"r":1},"google.gemma-4-e2b":{"i":"aitv","t":1,"r":1},"got-ocr-2.0-hf":{"i":"it"},"got-ocr2_0":{"i":"it"},"gpt-3.5-turbo":{"i":"ipt","t":1},"gpt-3.5-turbo-0613":{"i":"pt","t":1},"gpt-3.5-turbo-16k":{"i":"pt","t":1},"gpt-3.5-turbo-instruct":{"i":"ipt","t":1},"gpt-3.5-turbo-raw":{"i":"it","t":1},"gpt-3.5-turbo:batch":{"t":1},"gpt-4":{"i":"pt","t":1},"gpt-4-classic":{"i":"it","t":1},"gpt-4-classic-0314":{"i":"it","t":1},"gpt-4-turbo":{"i":"ipt","t":1},"gpt-4-turbo-vision":{"i":"it","t":1},"gpt-4-turbo:batch":{"i":"it","t":1},"gpt-4.1":{"i":"fipt","t":1},"gpt-4.1-fast":{"i":"ipt","t":1},"gpt-4.1-mini":{"i":"fipt","t":1},"gpt-4.1-mini-2025-04-14":{"i":"it","t":1},"gpt-4.1-mini-fast":{"i":"ipt","t":1},"gpt-4.1-mini:batch":{"i":"fit","t":1},"gpt-4.1-mini@eu":{"i":"ipt","t":1},"gpt-4.1-nano":{"i":"fipt","t":1},"gpt-4.1-nano-fast":{"i":"ipt","t":1},"gpt-4.1-nano:batch":{"i":"fit","t":1},"gpt-4.1-nano@eu":{"i":"it","t":1},"gpt-4.1:batch":{"i":"fit","t":1},"gpt-4.1@eu":{"i":"ipt","t":1},"gpt-4o":{"i":"fipt","t":1},"gpt-4o-2024-05-13":{"i":"fipt","t":1},"gpt-4o-2024-08-06":{"i":"fipt","t":1},"gpt-4o-2024-11-20":{"i":"afipt","t":1},"gpt-4o-aug":{"i":"it","t":1},"gpt-4o-fast":{"i":"ipt","t":1},"gpt-4o-mini":{"i":"fipt","t":1},"gpt-4o-mini-2024-07-18":{"i":"fipt","t":1},"gpt-4o-mini-fast":{"i":"ipt","t":1},"gpt-4o-mini-search":{"t":1},"gpt-4o-mini-transcribe":{"i":"at","t":1},"gpt-4o-mini:batch":{"i":"fit","t":1},"gpt-4o-mini@eu":{"i":"ipt","t":1},"gpt-4o-search":{"t":1},"gpt-4o-transcribe":{"i":"at","t":1},"gpt-4o:batch":{"i":"fit","t":1},"gpt-5":{"i":"fipt","t":1,"r":1},"gpt-5-1":{"i":"it","t":1,"r":1},"gpt-5-2":{"i":"it","t":1,"r":1},"gpt-5-3-codex":{"i":"ipt","t":1,"r":1},"gpt-5-4":{"i":"ipt","t":1,"r":1},"gpt-5-4-mini":{"i":"it","t":1,"r":1,"f":1},"gpt-5-4-nano":{"i":"it","t":1,"r":1},"gpt-5-5":{"i":"ipt","t":1,"r":1,"f":1},"gpt-5-5-pro":{"i":"ipt","t":1,"r":1},"gpt-5-6-luna":{"i":"ipt","t":1,"r":1,"f":1},"gpt-5-6-sol":{"i":"ipt","t":1,"r":1,"f":1},"gpt-5-6-terra":{"i":"ipt","t":1,"r":1,"f":1},"gpt-5-chat":{"i":"it","t":1},"gpt-5-chat-latest":{"i":"ipt","t":1,"r":1},"gpt-5-codex":{"i":"ipt","t":1,"r":1},"gpt-5-fast":{"i":"ipt","t":1,"r":1},"gpt-5-image":{"i":"fipt","r":1},"gpt-5-image-mini":{"i":"fipt","r":1},"gpt-5-mini":{"i":"fipt","t":1,"r":1},"gpt-5-mini-fast":{"i":"ipt","t":1,"r":1},"gpt-5-mini:batch":{"i":"fit","t":1,"r":1},"gpt-5-mini@eu":{"i":"it","t":1,"r":1},"gpt-5-nano":{"i":"fipt","t":1,"r":1},"gpt-5-nano:batch":{"i":"fit","t":1,"r":1},"gpt-5-nano@eu":{"i":"it","t":1,"r":1},"gpt-5-pro":{"i":"fipt","t":1,"r":1},"gpt-5-pro:batch":{"i":"fit","t":1,"r":1},"gpt-5-thinking":{"i":"it","t":1,"r":1},"gpt-5:batch":{"i":"fit","t":1,"r":1},"gpt-5.1":{"i":"afipt","t":1,"r":1},"gpt-5.1-2025-11-13":{"t":1,"r":1},"gpt-5.1-chat":{"i":"ipt","t":1},"gpt-5.1-chat-latest":{"i":"ipt","t":1,"r":1},"gpt-5.1-codex":{"i":"aipt","t":1,"r":1},"gpt-5.1-codex-max":{"i":"ipt","t":1,"r":1},"gpt-5.1-codex-mini":{"i":"ipt","t":1,"r":1},"gpt-5.1-instant":{"i":"it","t":1,"r":1},"gpt-5.1-thinking":{"i":"ipt","t":1,"r":1},"gpt-5.1-thinking-fast":{"i":"ipt","t":1,"r":1},"gpt-5.1:batch":{"i":"fit","t":1,"r":1},"gpt-5.1@eu":{"i":"it","t":1,"r":1},"gpt-5.2":{"i":"fipt","t":1,"r":1},"gpt-5.2-chat":{"i":"fipt","t":1},"gpt-5.2-chat-latest":{"i":"ipt","t":1,"r":1},"gpt-5.2-codex":{"i":"ipt","t":1,"r":1},"gpt-5.2-fast":{"i":"ipt","t":1,"r":1},"gpt-5.2-instant":{"i":"it","t":1},"gpt-5.2-pro":{"i":"fipt","t":1,"r":1},"gpt-5.2-pro:batch":{"i":"fit","t":1,"r":1},"gpt-5.2:batch":{"i":"fit","t":1,"r":1},"gpt-5.3-chat":{"t":1},"gpt-5.3-chat-latest":{"i":"ipt","t":1,"r":1},"gpt-5.3-codex":{"i":"fipt","t":1,"r":1},"gpt-5.3-codex-fast":{"i":"ipt","t":1,"r":1},"gpt-5.3-codex-spark":{"i":"ipt","t":1,"r":1,"f":1},"gpt-5.3-codex-xhigh":{"i":"ipt","t":1,"r":1},"gpt-5.3-instant":{"i":"it","t":1},"gpt-5.4":{"i":"fipt","t":1,"r":1},"gpt-5.4-fast":{"i":"ipt","t":1,"r":1},"gpt-5.4-image-2":{"i":"fipt","r":1},"gpt-5.4-mini":{"i":"fipt","t":1,"r":1},"gpt-5.4-mini-fast":{"i":"ipt","t":1,"r":1},"gpt-5.4-mini:batch":{"i":"fit","t":1,"r":1},"gpt-5.4-nano":{"i":"fipt","t":1,"r":1},"gpt-5.4-nano:batch":{"i":"fit","t":1,"r":1},"gpt-5.4-pro":{"i":"fipt","t":1,"r":1},"gpt-5.4-pro:batch":{"i":"fit","t":1,"r":1},"gpt-5.4:batch":{"i":"fit","t":1,"r":1},"gpt-5.4:free":{"i":"ipt","t":1,"r":1,"f":1},"gpt-5.4@eu":{"i":"ipt","t":1,"r":1},"gpt-5.5":{"i":"fipt","t":1,"r":1},"gpt-5.5-fast":{"i":"ipt","t":1,"r":1},"gpt-5.5-instant":{"i":"ipt","t":1,"r":1},"gpt-5.5-pro":{"i":"fipt","t":1,"r":1},"gpt-5.5-pro:batch":{"i":"fit","t":1,"r":1},"gpt-5.5:batch":{"i":"fit","t":1,"r":1},"gpt-5.5:free":{"i":"ipt","t":1,"r":1,"f":1},"gpt-5.5@eu":{"i":"ipt","t":1,"r":1},"gpt-5.6":{"i":"ipt","t":1,"r":1},"gpt-5.6-luna":{"i":"fipt","t":1,"r":1},"gpt-5.6-luna-fast":{"i":"ipt","t":1,"r":1},"gpt-5.6-luna-pro":{"i":"fipt","t":1,"r":1},"gpt-5.6-luna-pro:batch":{"i":"fit","t":1,"r":1},"gpt-5.6-luna:batch":{"i":"fit","t":1,"r":1},"gpt-5.6-luna@eu":{"i":"ipt","t":1,"r":1},"gpt-5.6-sol":{"i":"fipt","t":1,"r":1},"gpt-5.6-sol-discounted":{"i":"ipt","t":1,"r":1},"gpt-5.6-sol-fast":{"i":"ipt","t":1,"r":1},"gpt-5.6-sol-pro":{"i":"fipt","t":1,"r":1},"gpt-5.6-sol-pro:batch":{"i":"fit","t":1,"r":1},"gpt-5.6-sol:batch":{"i":"fit","t":1,"r":1},"gpt-5.6-sol:official":{"i":"ipt","t":1,"r":1},"gpt-5.6-sol@eu":{"i":"ipt","t":1,"r":1},"gpt-5.6-terra":{"i":"fipt","t":1,"r":1},"gpt-5.6-terra-fast":{"i":"ipt","t":1,"r":1},"gpt-5.6-terra-pro":{"i":"fipt","t":1,"r":1},"gpt-5.6-terra-pro:batch":{"i":"fit","t":1,"r":1},"gpt-5.6-terra:batch":{"i":"fit","t":1,"r":1},"gpt-5.6-terra@eu":{"i":"ipt","t":1,"r":1},"gpt-5@eu":{"i":"it","t":1,"r":1},"gpt-6-astra":{"i":"fipt","t":1,"r":1},"gpt-6-astra-fast":{"i":"ipt","t":1,"r":1},"gpt-6-astra-pro":{"i":"fipt","t":1,"r":1},"gpt-6-astra-pro:batch":{"i":"fit","t":1,"r":1},"gpt-6-astra:batch":{"i":"fit","t":1,"r":1},"gpt-6-astra:official":{"i":"ipt","t":1,"r":1},"gpt-astra-latest":{"i":"fipt","t":1,"r":1},"gpt-audio":{"i":"apt","t":1},"gpt-audio-mini":{"i":"apt","t":1},"gpt-chat-latest":{"i":"fipt","t":1,"r":1},"gpt-image-1":{"i":"it","t":1},"gpt-image-1-mini":{"i":"it","t":1},"gpt-image-1.5":{"i":"it"},"gpt-image-2":{"i":"it","f":1},"gpt-latest":{"i":"ipt","t":1,"r":1},"gpt-live-1":{"i":"at"},"gpt-luna-latest":{"i":"fipt","t":1,"r":1},"gpt-mini-latest":{"i":"fipt","t":1,"r":1},"gpt-oss-120b":{"i":"it","t":1,"r":1,"f":1},"gpt-oss-120b-cs":{"t":1,"r":1},"gpt-oss-120b-high-throughput":{"t":1,"r":1},"gpt-oss-120b-maas":{"t":1,"r":1},"gpt-oss-120b:batch":{"t":1,"r":1},"gpt-oss-20b":{"i":"it","t":1,"r":1,"f":1},"gpt-oss-20b-maas":{"t":1,"r":1},"gpt-oss-safeguard-120b":{"t":1,"r":1},"gpt-oss-safeguard-20b":{"t":1,"r":1},"gpt-oss:120b":{"t":1,"r":1,"f":1},"gpt-oss:20b":{"t":1,"r":1},"gpt-pro-latest":{"i":"ipt","t":1,"r":1},"gpt-realtime-1.5":{"i":"ait","t":1},"gpt-realtime-2":{"i":"at"},"gpt-realtime-2.1":{"i":"ait","t":1,"r":1},"gpt-realtime-mini":{"i":"at"},"gpt-realtime-whisper":{"i":"a"},"gpt-sol-latest":{"i":"fipt","t":1,"r":1},"gpt-terra-latest":{"i":"fipt","t":1,"r":1},"granite-4-h-small":{"t":1},"granite-4.0-h-micro":{"t":1},"granite-4.1-8b":{"t":1},"granite-4.2-8b":{"t":1,"r":1},"granite-docling-258m":{"i":"it"},"granite-vision-4.1-4b":{"i":"it"},"green-l":{"i":"it","t":1},"green-l-raw":{"i":"it","t":1},"green-r":{"i":"it","t":1,"r":1},"green-r-raw":{"i":"it","t":1,"r":1},"green-s":{"i":"a"},"green-s-pro":{"i":"a"},"greg-1-mini":{"i":"it"},"grok-3":{"t":1},"grok-3-mini":{"t":1,"r":1},"grok-4":{"i":"it","t":1,"r":1},"grok-4-0709":{"i":"it","t":1,"r":1},"grok-4-1-fast-non-reasoning":{"i":"it","t":1},"grok-4-1-fast-reasoning":{"i":"it","t":1,"r":1},"grok-4-20":{"i":"it","t":1,"r":1},"grok-4-20-beta-0309-non-reasoning":{"i":"ipt","t":1},"grok-4-20-beta-0309-reasoning":{"i":"ipt","t":1,"r":1},"grok-4-20-multi-agent":{"i":"it","r":1},"grok-4-20-non-reasoning":{"i":"ipt","t":1},"grok-4-20-reasoning":{"i":"ipt","t":1,"r":1},"grok-4-3":{"i":"iptv","t":1,"r":1},"grok-4-5":{"i":"it","t":1,"r":1,"f":1},"grok-4-6":{"i":"it","t":1,"r":1,"f":1},"grok-4-fast":{"i":"aitv","t":1,"r":1},"grok-4-fast-non-reasoning":{"i":"aitv","t":1},"grok-4-fast-reasoning":{"i":"aitv","t":1,"r":1},"grok-4.1":{"i":"it","t":1},"grok-4.1-fast":{"i":"it","t":1,"r":1},"grok-4.1-fast-non-reasoning":{"i":"aiptv","t":1},"grok-4.1-fast-reasoning":{"i":"aiptv","t":1,"r":1},"grok-4.2-beta":{"i":"it","t":1,"r":1},"grok-4.2-fast":{"i":"itv","t":1,"r":1},"grok-4.2-fast-non-reasoning":{"i":"itv","t":1},"grok-4.20":{"i":"fipt","t":1,"r":1},"grok-4.20-0309-non-reasoning":{"i":"ipt","t":1},"grok-4.20-0309-reasoning":{"i":"ipt","t":1,"r":1},"grok-4.20-beta-0309-reasoning":{"i":"it","t":1,"r":1},"grok-4.20-multi-agent":{"i":"fipt","t":1,"r":1},"grok-4.20-multi-agent-0309":{"i":"ipt","r":1},"grok-4.20-multi-agent-beta":{"i":"ipt","t":1,"r":1},"grok-4.20-non-reasoning":{"i":"ipt","t":1},"grok-4.20-non-reasoning-beta":{"i":"ipt","t":1},"grok-4.20-reasoning":{"i":"ipt","t":1,"r":1},"grok-4.20-reasoning-beta":{"i":"ipt","t":1,"r":1},"grok-4.3":{"i":"fipt","t":1,"r":1},"grok-4.3:batch":{"i":"fit","t":1,"r":1},"grok-4.5":{"i":"fipt","t":1,"r":1},"grok-4.6":{"i":"fipt","t":1,"r":1},"grok-build-0-1":{"i":"ipt","t":1,"r":1,"f":1},"grok-build-0.1":{"i":"fipt","t":1,"r":1},"grok-code":{"t":1,"r":1,"f":1},"grok-code-fast-1":{"i":"it","t":1,"r":1},"grok-imagine-image":{"i":"ipt"},"grok-imagine-image-2-0":{"i":"it","f":1},"grok-imagine-image-2.0":{"i":"ipt"},"grok-imagine-image-quality":{"i":"ipt"},"grok-imagine-video":{"i":"iptv"},"grok-imagine-video-1.5":{"i":"aipt"},"grok-latest":{"i":"fipt","t":1,"r":1},"grok-stt":{"i":"a"},"grok-voice-think-fast-1.0":{"i":"at"},"grok-voice-think-fast-2.0":{"i":"at"},"groq-llama-4-maverick-17b-128e-instruct":{"t":1,"f":1},"happyhorse-1.1-i2v":{"i":"it","f":1},"happyhorse-1.1-r2v":{"i":"it","f":1},"happyhorse-1.1-t2v":{"f":1},"hash-medgemma-4b-16bit-eng-swa-it":{"i":"it"},"hermes-2-pro-llama-3-8b":{"t":1},"hermes-3-llama-3.1-70b":{"t":1},"hermes-4-405b":{"t":1,"r":1},"hermes-high":{"t":1,"r":1},"hermes-low":{"t":1,"r":1},"hermes-medium":{"t":1,"r":1},"hermes3.6-35b-a3b-uncensored-genesis-nvfp4-gguf":{"i":"it"},"holo-3.1-0.8b":{"i":"it"},"holo-3.1-35b-a3b-gguf":{"i":"it"},"holo2-30b-a3b":{"i":"it","t":1,"r":1},"holo2-4b":{"i":"it"},"holo3-35b-a3b":{"i":"it","t":1,"r":1},"holo3-35b-a3b:thinking":{"i":"it","t":1,"r":1},"huihui-deepseek-v4-flash-vision-exp-abliterated-gguf":{"i":"it"},"huihui-gemma-4-26b-a4b-it-abliterated-gguf":{"i":"it"},"huihui-mistral-small-3.2-24b-instruct-2506-abliterated-q4_k_m-gguf":{"i":"it"},"huihui-qwen3-vl-30b-a3b-instruct-abliterated-gguf":{"i":"it"},"huihui-qwen3-vl-4b-instruct-abliterated":{"i":"it"},"huihui-qwen3-vl-4b-instruct-abliterated-gguf":{"i":"it"},"huihui-qwen3-vl-8b-instruct-abliterated":{"i":"it"},"huihui-qwen3.5-27b-abliterated":{"i":"it"},"huihui-qwen3.5-4b-abliterated":{"i":"it"},"huihui-qwen3.5-9b-abliterated":{"i":"it"},"huihui-qwen3.6-27b-abliterated-awq-mtp":{"i":"it"},"huihui-qwen3.6-27b-abliterated-mtp-gguf":{"i":"it"},"huihui-qwen3.6-35b-a3b-abliterated-mtp-gguf":{"i":"it"},"huihui-qwen3.6-35b-a3b-claude-4.7-opus-abliterated-mtp-gguf":{"i":"it"},"huihui-qwen3.8-27b-abliterated":{"i":"it"},"huihui-qwen3.8-27b-abliterated-awq-mtp":{"i":"it"},"huihui-qwen3.8-27b-abliterated-gguf":{"i":"it"},"huihui-qwen3.8-flash-next-abliterated-gguf":{"i":"it"},"hunyuan-2.0-instruct":{"t":1,"f":1},"hunyuan-2.0-thinking":{"t":1,"r":1,"f":1},"hunyuan-a13b-instruct":{"t":1,"r":1},"hunyuan-t1":{"t":1,"r":1,"f":1},"hunyuan-turbos":{"t":1,"f":1},"hunyuanocr":{"i":"it"},"hy-mt2-plus":{"t":1},"hy3":{"t":1,"r":1,"f":1},"hy3-free":{"t":1,"r":1,"f":1},"hy3-preview":{"t":1,"r":1,"f":1},"hy3-preview-free":{"t":1,"r":1,"f":1},"hy3:free":{"t":1,"r":1,"f":1},"hy4-preview":{"t":1,"r":1},"hyperclovax-seed-think-32b":{"i":"it"},"idefics2-8b":{"i":"it"},"idefics3-8b-llama3":{"i":"it"},"ideogram":{"i":"it","t":1},"ideogram-v2":{"i":"it","t":1},"ideogram-v2a":{"t":1},"ideogram-v2a-turbo":{"t":1},"imagen-3":{"t":1},"imagen-3-fast":{"t":1},"imagen-4":{"t":1},"imagen-4-fast":{"t":1},"imagen-4-ultra":{"t":1},"in.openai.gpt-5.6-luna":{"i":"ipt","t":1,"r":1},"in.openai.gpt-5.6-terra":{"i":"ipt","t":1,"r":1},"infinity-parser2-flash":{"i":"it"},"infinity-parser2-pro":{"i":"it"},"infinity-parser2-pro-awq-w4a16":{"i":"it"},"inkling":{"i":"aipt","t":1,"r":1,"f":1},"inkling-256k":{"i":"it","t":1,"r":1},"inkling-gguf":{"i":"it"},"inkling-nvfp4":{"i":"ait","t":1,"r":1},"inkling-small":{"i":"aipt","t":1,"r":1},"inkling-small-gguf":{"i":"it"},"inkling-small-nvfp4":{"i":"it"},"inkling-small:free":{"i":"ait","t":1,"r":1,"f":1},"inkling-small:thinking":{"i":"ait","t":1,"r":1},"inkling:batch":{"i":"ait","t":1,"r":1},"inkling:free":{"i":"ait","t":1,"r":1,"f":1},"inkling:peft:262144":{"i":"it","t":1,"r":1},"inkling:thinking":{"i":"ait","t":1,"r":1},"instructblip-flan-t5-xl":{"i":"it"},"instructblip-vicuna-7b":{"i":"it"},"interfaze-beta":{"i":"ipt","r":1},"intern-s1":{"i":"it"},"intern-s1-mini":{"i":"it"},"internvl-chat-v1-2":{"i":"it"},"internvl-chat-v1-5":{"i":"it"},"internvl2_5-2b":{"i":"it"},"internvl2_5-2b-mpo-hf":{"i":"it"},"internvl2_5-4b":{"i":"it"},"internvl2_5-8b":{"i":"it"},"internvl2-1b":{"i":"it"},"internvl2-26b":{"i":"it"},"internvl2-2b":{"i":"it"},"internvl2-4b":{"i":"it"},"internvl2-8b":{"i":"it"},"internvl3_5-1b":{"i":"it"},"internvl3_5-2b-hf":{"i":"it"},"internvl3_5-30b-a3b":{"i":"it"},"internvl3_5-38b":{"i":"it"},"internvl3_5-4b":{"i":"it"},"internvl3_5-4b-hf":{"i":"it"},"internvl3_5-8b":{"i":"it"},"internvl3_5-8b-hf":{"i":"it"},"internvl3_5-gpt-oss-20b-a4b-preview":{"i":"it"},"internvl3_5-gpt-oss-20b-a4b-preview-hf":{"i":"it"},"internvl3-14b":{"i":"it"},"internvl3-14b-hf":{"i":"it"},"internvl3-1b":{"i":"it"},"internvl3-1b-hf":{"i":"it"},"internvl3-2b":{"i":"it"},"internvl3-2b-hf":{"i":"it"},"internvl3-38b":{"i":"it"},"internvl3-78b":{"i":"it"},"internvl3-8b":{"i":"it"},"internvl3-8b-hf":{"i":"it"},"jan-v2-vl-high-gguf":{"i":"it"},"jp.amazon.nova-2-lite-v1:0":{"i":"iptv","t":1,"r":1},"jp.anthropic.claude-haiku-4-5-20251001-v1:0":{"i":"ipt","t":1,"r":1},"jp.anthropic.claude-opus-4-7":{"i":"ipt","t":1,"r":1},"jp.anthropic.claude-opus-4-8":{"i":"ipt","t":1,"r":1},"jp.anthropic.claude-opus-5":{"i":"ipt","t":1,"r":1},"jp.anthropic.claude-sonnet-4-5-20250929-v1:0":{"i":"ipt","t":1,"r":1},"jp.anthropic.claude-sonnet-4-6":{"i":"ipt","t":1,"r":1},"jp.anthropic.claude-sonnet-5":{"i":"ipt","t":1,"r":1},"k3":{"i":"itv","t":1,"r":1,"f":1},"k3-256k":{"i":"it","t":1,"r":1,"f":1},"kanana-1.5-v-3b-instruct":{"i":"it"},"kat-coder-air-v2.5":{"i":"it","t":1,"r":1},"kat-coder-pro":{"t":1},"kat-coder-pro-v1":{"r":1},"kat-coder-pro-v2":{"t":1,"r":1},"kat-coder-pro-v2.5":{"i":"it","t":1,"r":1},"kb-whisper-large":{"i":"a"},"kdl-frontier-parser-nano":{"i":"it"},"kimi-fast-latest":{"i":"it","t":1,"r":1},"kimi-for-coding":{"i":"itv","t":1,"r":1,"f":1},"kimi-for-coding-highspeed":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2":{"t":1,"f":1},"kimi-k2_6":{"i":"it","t":1,"r":1},"kimi-k2-0711":{"t":1},"kimi-k2-0905":{"t":1,"f":1},"kimi-k2-0905-preview":{"t":1},"kimi-k2-5":{"i":"it","t":1,"r":1},"kimi-k2-6":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2-6:free":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2-7-code":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2-7-code-highspeed":{"i":"itv","t":1,"r":1},"kimi-k2-7-code:free":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2-instruct":{"t":1},"kimi-k2-instruct-0711":{"t":1},"kimi-k2-instruct-0905":{"t":1,"f":1},"kimi-k2-instruct-fast":{"i":"pt"},"kimi-k2-thinking":{"t":1,"r":1},"kimi-k2-thinking-maas":{"t":1,"r":1},"kimi-k2-thinking-turbo":{"t":1,"r":1},"kimi-k2-turbo-preview":{"t":1},"kimi-k2.5":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2.5-free":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2.5-fw":{"i":"it","t":1,"f":1},"kimi-k2.5:thinking":{"i":"it","t":1,"r":1},"kimi-k2.6":{"i":"iptv","t":1,"r":1,"f":1},"kimi-k2.6-fast":{"i":"it","t":1,"r":1},"kimi-k2.6-gguf":{"i":"it"},"kimi-k2.6-nitro":{"i":"itv","t":1,"r":1},"kimi-k2.6-tee":{"i":"itv","t":1,"r":1},"kimi-k2.6:thinking":{"i":"it","t":1,"r":1},"kimi-k2.6@eu":{"i":"itv","t":1,"r":1},"kimi-k2.7-code":{"i":"iptv","t":1,"r":1,"f":1},"kimi-k2.7-code-fast":{"i":"it","t":1,"r":1},"kimi-k2.7-code-flex":{"i":"it","t":1,"r":1},"kimi-k2.7-code-free":{"i":"itv","t":1,"r":1,"f":1},"kimi-k2.7-code-gguf":{"i":"it"},"kimi-k2.7-code-highspeed":{"i":"iptv","t":1,"r":1},"kimi-k2.7-code-nitro":{"i":"itv","t":1,"r":1},"kimi-k2.7-code@eu":{"i":"itv","t":1,"r":1},"kimi-k2p6":{"i":"it","t":1,"r":1},"kimi-k2p7-code":{"i":"it","t":1,"r":1},"kimi-k3":{"i":"iptv","t":1,"r":1,"f":1},"kimi-k3-eco":{"i":"itv","t":1,"r":1},"kimi-k3-fast":{"i":"iptv","t":1,"r":1},"kimi-k3-fast-api":{"i":"it","t":1,"r":1},"kimi-k3-flex":{"i":"it","t":1,"r":1},"kimi-k3-free":{"i":"itv","t":1,"r":1,"f":1},"kimi-k3-gguf":{"i":"it"},"kimi-k3-tee":{"i":"itv","t":1,"r":1},"kimi-k3:batch":{"i":"itv","t":1,"r":1},"kimi-k3@eu":{"i":"itv","t":1,"r":1},"kimi-latest":{"i":"itv","t":1,"r":1},"kimi-vl-a3b-instruct":{"i":"it"},"kimi-vl-a3b-thinking":{"i":"it"},"kimi-vl-a3b-thinking-2506":{"i":"it"},"kling-v2-6":{"i":"itv"},"kloker":{"t":1},"kloker-integration-architect":{"t":1},"kloker-integration-developer":{"t":1},"kosmos-2.5":{"i":"it"},"l3-70b-euryale-v2.1":{"t":1},"l3-8b-stheno-v3.2":{"t":1},"l3.1-euryale-70b":{"t":1},"l31-70b-euryale-v2.2":{"t":1},"labs-devstral-small-2512":{"i":"it","t":1,"f":1},"laguna-m.1":{"t":1,"r":1,"f":1},"laguna-s-2.1":{"t":1,"r":1,"f":1},"laguna-s-2.1-free":{"t":1,"r":1,"f":1},"laguna-s-2.1:free":{"t":1,"r":1,"f":1},"laguna-s-2.1:thinking":{"t":1,"r":1},"laguna-xs-2.1":{"t":1,"r":1,"f":1},"laguna-xs-2.1:free":{"t":1,"r":1,"f":1},"laguna-xs.2":{"r":1,"f":1},"large":{"t":1,"r":1},"leanstral-1-5":{"t":1,"f":1},"leanstral-1-5@eu":{"t":1,"f":1},"leanstral-1.5-119b-a6b-nvfp4":{"i":"it"},"lfm-2.5-2.6b":{"t":1,"r":1},"lfm-2.5-2.6b:free":{"t":1,"r":1,"f":1},"lfm2-24b-a2b":{"r":1},"lfm2-vl-1.6b":{"i":"it"},"lfm2-vl-1.6b-gguf":{"i":"it"},"lfm2-vl-450m":{"i":"it"},"lfm2.5-vl-1.6b":{"i":"it"},"lfm2.5-vl-1.6b-gguf":{"i":"it"},"lfm2.5-vl-3b":{"i":"it"},"lfm2.5-vl-3b-gguf":{"i":"it"},"lfm2.5-vl-450m":{"i":"it"},"lfm2.5-vl-450m-gguf":{"i":"it"},"libra-llava-rad":{"i":"it"},"libra-v1.0-7b":{"i":"it"},"lift":{"i":"it"},"lightonocr-2-1b":{"i":"it","t":1},"lightonocr-2-1b-bbox":{"i":"it"},"lightonocr-2-1b-bbox-soup":{"i":"it"},"ling-1t":{"t":1},"ling-2.6-1t":{"t":1},"ling-2.6-flash":{"t":1},"ling-2.6-flash-free":{"t":1,"f":1},"ling-3.0-flash":{"t":1,"r":1},"ling-3.0-flash-fin":{"t":1,"r":1,"f":1},"ling-3.0-flash-fin-free":{"t":1,"r":1,"f":1},"ling-3.0-flash-fin:free":{"t":1,"r":1,"f":1},"ling-3.0-flash-free":{"t":1,"r":1,"f":1},"ling-3.0-flash-sante":{"t":1,"r":1,"f":1},"ling-3.0-flash-sante-free":{"t":1,"r":1,"f":1},"ling-3.0-flash-sante:free":{"t":1,"r":1,"f":1},"ling-3.0-flash-vl":{"i":"itv","t":1,"r":1,"f":1},"ling-3.0-flash-vl-free":{"i":"it","t":1,"r":1,"f":1},"ling-3.0-flash-vl:free":{"i":"itv","t":1,"r":1,"f":1},"ling-3.0-flash:thinking":{"t":1,"r":1},"ling-3.0-tiny":{"t":1,"r":1,"f":1},"ling-3.0-tiny-free":{"t":1,"r":1,"f":1},"ling-flash-2.0":{"t":1},"llada-v":{"i":"it"},"llama-3_2-nemoretriever-300m-embed-v1":{"f":1},"llama-3-3-70b-instruct":{"t":1},"llama-3.1-405b-instruct":{"t":1,"r":1},"llama-3.1-70b":{"t":1},"llama-3.1-70b-instruct":{"t":1,"f":1},"llama-3.1-8b":{"t":1},"llama-3.1-8b-cs":{"t":1},"llama-3.1-8b-instant":{"t":1},"llama-3.1-8b-instruct":{"t":1,"r":1,"f":1},"llama-3.1-8b-instruct-turbo":{"t":1},"llama-3.1-nemotron-70b-instruct":{"t":1,"f":1},"llama-3.1-nemotron-nano-8b-v1":{"t":1,"r":1,"f":1},"llama-3.1-nemotron-nano-vl-8b-v1":{"i":"it","t":1,"r":1,"f":1},"llama-3.1-nemotron-safety-guard-8b-v3":{"f":1},"llama-3.1-nemotron-ultra-253b-v1":{"t":1,"r":1,"f":1},"llama-3.2-11b-vision-instruct":{"i":"it","t":1,"f":1},"llama-3.2-1b-instruct":{"t":1,"r":1,"f":1},"llama-3.2-3b":{"t":1},"llama-3.2-3b-instruct":{"i":"pt","t":1,"r":1,"f":1},"llama-3.2-90b-vision-instruct":{"i":"it","t":1,"f":1},"llama-3.3-70b":{"t":1,"f":1},"llama-3.3-70b-instruct":{"t":1,"f":1},"llama-3.3-70b-instruct-fp8":{"t":1},"llama-3.3-70b-instruct-fp8-dynamic":{"t":1},"llama-3.3-70b-instruct-fp8-fast":{"t":1},"llama-3.3-70b-instruct-maas":{"t":1},"llama-3.3-70b-instruct-turbo":{"t":1},"llama-3.3-70b-versatile":{"t":1},"llama-3.3-8b-instruct":{"t":1,"f":1},"llama-3.3-nemotron-super-49b-v1":{"t":1,"r":1,"f":1},"llama-3.3-nemotron-super-49b-v1.5":{"t":1,"r":1,"f":1},"llama-4-maverick":{"i":"it","t":1,"f":1},"llama-4-maverick-17b-128e-instruct":{"i":"it","t":1,"f":1},"llama-4-maverick-17b-128e-instruct-fp8":{"i":"it","t":1,"f":1},"llama-4-maverick-17b-128e-instruct-maas":{"i":"it","t":1},"llama-4-maverick-17b-instruct":{"i":"it","t":1},"llama-4-scout":{"i":"it","t":1,"f":1},"llama-4-scout-17b-16e-instruct":{"i":"it","t":1},"llama-4-scout-17b-16e-instruct-fp8":{"i":"it","t":1,"f":1},"llama-4-scout-17b-16e-instruct-gguf":{"i":"it"},"llama-4-scout-17b-16e-instruct-quantized.w4a16":{"i":"it"},"llama-4-scout-17b-instruct":{"i":"it"},"llama-guard-4":{"i":"it"},"llama-guard-4-12b":{"i":"it","f":1},"llama-joycaption-beta-one-hf-llava":{"i":"it"},"llama-nemotron-embed-vl-1b-v2":{"i":"it","f":1},"llama-nemotron-rerank-vl-1b-v2":{"i":"it","f":1},"llama3-3-70b":{"t":1},"llama3-8b-instruct":{"t":1},"llama3-llava-next-8b-hf":{"i":"it"},"llama3.3-70b-instruct":{"t":1},"llama3.3:70b":{"t":1,"f":1},"llava-1.5-13b-hf":{"i":"it"},"llava-1.5-7b-hf":{"i":"it"},"llava-interleave-qwen-0.5b-hf":{"i":"it"},"llava-llama-3-8b-v1_1-transformers":{"i":"it"},"llava-med-v1.5-mistral-7b":{"i":"it"},"llava-onevision-1.5-8b-instruct":{"i":"it"},"llava-onevision-2-8b-instruct":{"i":"it"},"llava-onevision-qwen2-0.5b-ov-hf":{"i":"it"},"llava-onevision-qwen2-7b-ov-hf":{"i":"it"},"llava-v1.5-13b":{"i":"it"},"llava-v1.5-7b":{"i":"it"},"llava-v1.6-34b":{"i":"it"},"llava-v1.6-mistral-7b":{"i":"it"},"llava-v1.6-mistral-7b-hf":{"i":"it"},"llava-v1.6-vicuna-7b":{"i":"it"},"llava-v1.6-vicuna-7b-hf":{"i":"it"},"locateanything-3b":{"i":"it"},"longcat-2.0":{"t":1,"r":1},"longcat-2.0-free":{"t":1,"r":1,"f":1},"longcat-2.0:thinking":{"t":1,"r":1},"longcat-flash-lite":{"t":1},"lucid-origin":{"i":"it"},"lucid-realism":{"i":"it"},"lucidnova-rf1-100b":{"t":1,"r":1},"lucidquery-agi-01-frontier":{"i":"it","t":1,"r":1},"lucidquery-agi-01-swift":{"i":"it","t":1,"r":1},"lucidquery-nexus-coder":{"t":1,"r":1},"lynkr-auto":{"t":1,"f":1},"lyria":{"t":1},"lyria-3-clip-preview":{"i":"it","f":1},"lyria-3-pro-preview":{"i":"it","f":1},"m2-her":{"t":1,"r":1},"m3":{"i":"itv","t":1,"r":1},"mage-vl":{"i":"it"},"magistral-medium":{"t":1,"r":1},"magistral-medium-latest":{"i":"it","t":1,"r":1},"magistral-small":{"t":1,"r":1},"magistral-small-2506":{"t":1,"r":1,"f":1},"magnum-v4-72b":{"i":"pt"},"magpie-tts-zeroshot":{"i":"at","f":1},"mai-code-1-flash-picker":{"t":1,"r":1},"mai-code-1.1-flash":{"i":"ipt","t":1,"r":1},"medgemma-1.5-4b-it":{"i":"it"},"medgemma-1.5-4b-it-gguf":{"i":"it"},"medgemma-27b-it":{"i":"it"},"medgemma-4b":{"i":"it"},"medgemma-4b-it":{"i":"it"},"medgemma-4b-it-gguf":{"i":"it"},"mellum2-12b-a2.5b-instruct":{"t":1},"mercury-2":{"t":1,"r":1},"mercury-2-5":{"t":1,"r":1},"mercury-2.5":{"t":1,"r":1},"mercury-2.5-preview":{"t":1,"r":1},"mercury-coder-small":{"t":1},"mercury-edit-2":{"r":1},"meta-llama-3_1-8b-instruct-gguf":{"t":1,"f":1},"meta-llama-3_3-70b-instruct":{"t":1},"meta-llama-3-1-8b-instruct":{"t":1},"meta-llama-3-3-70b-instruct":{"t":1},"meta-llama-3.1-405b-instruct-turbo":{"t":1},"meta-llama-3.1-8b-instruct":{"t":1},"meta-llama-3.3-70b-instruct":{"t":1},"meta.llama3-1-70b-instruct-v1:0":{"t":1},"meta.llama3-1-8b-instruct-v1:0":{"t":1},"meta.llama3-3-70b-instruct-v1:0":{"t":1},"meta.llama4-maverick-17b-instruct-v1:0":{"i":"it","t":1},"meta.llama4-scout-17b-instruct-v1:0":{"i":"it","t":1},"mimo-v2-5":{"i":"aitv","t":1,"r":1,"f":1},"mimo-v2-5-pro":{"t":1,"r":1,"f":1},"mimo-v2-5:free":{"i":"aitv","t":1,"r":1,"f":1},"mimo-v2-flash":{"t":1,"r":1,"f":1},"mimo-v2-flash-free":{"t":1,"r":1,"f":1},"mimo-v2-omni":{"i":"aiptv","t":1,"r":1},"mimo-v2-omni-free":{"i":"aipt","t":1,"r":1,"f":1},"mimo-v2-pro":{"t":1,"r":1,"f":1},"mimo-v2-pro-free":{"t":1,"r":1,"f":1},"mimo-v2-tts":{"f":1},"mimo-v2.5":{"i":"aitv","t":1,"r":1,"f":1},"mimo-v2.5-free":{"i":"aitv","t":1,"r":1,"f":1},"mimo-v2.5-pro":{"i":"at","t":1,"r":1,"f":1},"mimo-v2.5-pro-ultraspeed":{"t":1,"r":1},"mimo-v2.5-pro:thinking":{"t":1,"r":1},"mimo-v2.5-tts":{"f":1},"mimo-v2.5-tts-voiceclone":{"f":1},"mimo-v2.5-tts-voicedesign":{"f":1},"mimo-v2.5:thinking":{"i":"aitv","t":1,"r":1},"mimo-v25":{"i":"aitv","t":1,"r":1,"f":1},"mimo-vl-7b-rl-2508-bnb-4bit-fp4":{"i":"it"},"mineru2.5-pro-2604-1.2b":{"i":"it"},"mineru2.5-pro-2605-1.2b":{"i":"it"},"mini_lm_l12_v2":{"f":1},"mini-internvl-chat-2b-v1-5":{"i":"it"},"minicpm-llama3-v-2_5":{"i":"it"},"minicpm-v-2_6":{"i":"it"},"minicpm-v-4":{"i":"it"},"minicpm-v-4_5":{"i":"it"},"minicpm-v-4_5-awq":{"i":"it"},"minicpm-v-4_5-gguf":{"i":"it"},"minicpm-v-4.5":{"t":1},"minicpm-v-4.6":{"i":"it"},"minicpm-v-4.6-awq":{"i":"it"},"minicpm-v-4.6-bnb":{"i":"it"},"minicpm-v-4.6-gguf":{"i":"it"},"minicpm-v-4.6-gptq":{"i":"it"},"minicpm-v-4.6-thinking":{"i":"it"},"minicpm-v-4.6-thinking-awq":{"i":"it"},"minicpm-v-4.6-thinking-bnb":{"i":"it"},"minicpm-v-4.6-thinking-gptq":{"i":"it"},"minicpm5-2b":{"t":1,"r":1},"minimax-01":{"i":"ipt"},"minimax-h3":{"i":"it"},"minimax-h3-max":{"i":"it"},"minimax-latest":{"i":"it","t":1,"r":1},"minimax-m1":{"t":1,"r":1},"minimax-m1-80k":{"t":1,"r":1},"minimax-m2":{"t":1,"r":1,"f":1},"minimax-m2_5-high-throughput":{"t":1,"r":1},"minimax-m2-5":{"t":1},"minimax-m2-7":{"t":1,"r":1,"f":1},"minimax-m2-7-highspeed":{"t":1,"r":1,"f":1},"minimax-m2.1":{"t":1,"r":1,"f":1},"minimax-m2.1-free":{"t":1,"r":1,"f":1},"minimax-m2.1-lightning":{"t":1,"r":1},"minimax-m2.5":{"i":"it","t":1,"r":1,"f":1},"minimax-m2.5-free":{"t":1,"r":1,"f":1},"minimax-m2.5-highspeed":{"t":1,"r":1,"f":1},"minimax-m2.5-lightning":{"t":1,"r":1},"minimax-m2.7":{"t":1,"r":1,"f":1},"minimax-m2.7-highspeed":{"t":1,"r":1,"f":1},"minimax-m2.7-turbo":{"t":1,"r":1},"minimax-m2.7:free":{"t":1,"r":1,"f":1},"minimax-m25":{"t":1,"r":1},"minimax-m27":{"t":1,"r":1},"minimax-m2p7":{"t":1,"r":1},"minimax-m3":{"i":"iptv","t":1,"r":1,"f":1},"minimax-m3-fp8-dynamic":{"i":"it"},"minimax-m3-free":{"i":"itv","t":1,"r":1,"f":1},"minimax-m3-mxfp4":{"i":"it"},"minimax-m3-mxfp8":{"i":"it"},"minimax-m3-preview":{"i":"itv","t":1,"r":1},"minimax-m3:batch":{"i":"itv","t":1,"r":1},"minimax-m3:thinking":{"i":"it","t":1,"r":1},"minimax-m3@eu":{"i":"itv","t":1,"r":1},"minimax-text-01":{"t":1,"r":1},"minimax-vl-01":{"i":"it"},"minimax.minimax-m2":{"t":1,"r":1},"minimax.minimax-m2.1":{"t":1,"r":1},"minimax.minimax-m2.5":{"t":1,"r":1},"ministral-14b":{"i":"ipt","t":1},"ministral-14b-2512":{"i":"it","t":1},"ministral-14b-instruct-2512":{"i":"it","t":1,"f":1},"ministral-3-14b-instruct-2512":{"i":"it","t":1},"ministral-3-14b-reasoning-2512":{"i":"it","t":1,"r":1},"ministral-3-3b-reasoning-2512":{"i":"it","t":1,"r":1},"ministral-3-8b-instruct-2512":{"i":"it","t":1},"ministral-3b":{"t":1},"ministral-3b-2512":{"i":"it","t":1},"ministral-3b-latest":{"t":1},"ministral-8b":{"t":1},"ministral-8b-2512":{"i":"it","t":1},"ministral-8b-2512:batch":{"i":"it","t":1},"ministral-8b-instruct-2410":{"t":1},"ministral-8b-latest":{"t":1},"mistral-3":{"i":"it"},"mistral-3-14b":{"t":1},"mistral-7b-instruct-v0.2":{"i":"pt"},"mistral-7b-instruct-v0.3":{"t":1,"r":1,"f":1},"mistral-code-agent-latest":{"t":1},"mistral-code-latest":{"t":1},"mistral-large":{"i":"fpt","t":1},"mistral-large-2402":{"i":"pt","t":1,"r":1},"mistral-large-2407":{"i":"fpt","t":1},"mistral-large-2411":{"t":1},"mistral-large-2512":{"i":"fipt","t":1},"mistral-large-2512:batch":{"i":"fit","t":1},"mistral-large-3":{"i":"it","t":1},"mistral-large-3-675b-instruct-2512":{"i":"it","t":1,"f":1},"mistral-large-3-fp8":{"i":"it","t":1},"mistral-large-3:675b":{"i":"it","t":1},"mistral-large-instruct-2411":{"i":"it","t":1},"mistral-large-latest":{"i":"ipt","t":1},"mistral-large:free":{"i":"it","t":1,"f":1},"mistral-large2":{"i":"it","t":1},"mistral-medium":{"i":"it","t":1},"mistral-medium-2505":{"i":"it","t":1},"mistral-medium-2508":{"i":"it","t":1},"mistral-medium-2604":{"i":"it","t":1,"r":1},"mistral-medium-3":{"i":"fipt","t":1},"mistral-medium-3-5":{"i":"fipt","t":1,"r":1},"mistral-medium-3-5:batch":{"i":"fit","t":1,"r":1},"mistral-medium-3-5:free":{"i":"it","t":1,"r":1,"f":1},"mistral-medium-3-5@eu":{"i":"it","t":1,"r":1},"mistral-medium-3-instruct":{"i":"it","f":1},"mistral-medium-3.1":{"i":"fipt","t":1},"mistral-medium-3.1:batch":{"i":"fit","t":1},"mistral-medium-3.5":{"i":"it","t":1,"r":1},"mistral-medium-3.5-128b":{"i":"it","t":1,"r":1,"f":1},"mistral-medium-3.5:thinking":{"i":"it","t":1,"r":1},"mistral-medium-latest":{"i":"it","t":1,"r":1},"mistral-medium-latest@eu":{"i":"it","t":1},"mistral-nemo":{"i":"it","t":1},"mistral-nemo-12b-instruct":{"t":1},"mistral-nemo-instruct-2407":{"t":1},"mistral-nemotron":{"t":1,"f":1},"mistral-saba":{"i":"fpt","t":1},"mistral-small":{"i":"it","t":1},"mistral-small-24b-instruct-2501":{"t":1},"mistral-small-2503":{"i":"it","t":1},"mistral-small-2506":{"i":"it","t":1},"mistral-small-2603":{"i":"it","t":1,"r":1},"mistral-small-2603:batch":{"i":"it","t":1,"r":1},"mistral-small-2603@eu":{"i":"it","t":1,"r":1},"mistral-small-3-1-24b-instruct-2503":{"i":"it","t":1},"mistral-small-3-2-24b-instruct":{"i":"it","t":1},"mistral-small-3.1-24b-instruct":{"i":"it","t":1},"mistral-small-3.1-24b-instruct-2503-gptq-4b-128g":{"i":"it"},"mistral-small-3.2-24b-instruct":{"i":"it","t":1},"mistral-small-3.2-24b-instruct-2506":{"i":"it","t":1,"r":1,"f":1},"mistral-small-3.2-24b-instruct-2506-gguf":{"i":"it"},"mistral-small-3.2-24b-instruct-2506-mlx-4bit":{"i":"it"},"mistral-small-3.2-24b-instruct-2506-mlx-6bit":{"i":"it"},"mistral-small-3.2-24b-instruct-2506-mlx-8bit":{"i":"it"},"mistral-small-4":{"i":"it","t":1},"mistral-small-4-119b":{"i":"it","t":1,"r":1},"mistral-small-4-119b-2603":{"i":"it","t":1,"r":1,"f":1},"mistral-small-4-119b-2603:thinking":{"i":"it","t":1,"r":1},"mistral-small-latest":{"i":"it","t":1,"r":1},"mistral.devstral-2-123b":{"t":1},"mistral.magistral-small-2509":{"i":"it","t":1,"r":1},"mistral.ministral-3-14b-instruct":{"i":"it","t":1},"mistral.ministral-3-3b-instruct":{"i":"it","t":1},"mistral.ministral-3-8b-instruct":{"i":"it","t":1},"mistral.mistral-large-3-675b-instruct":{"i":"it","t":1},"mistral.pixtral-large-2502-v1:0":{"i":"it","t":1},"mistral.pixtral-large-2502-v1:0@us":{"t":1},"mistral.voxtral-mini-3b-2507":{"i":"at","t":1},"mistral.voxtral-mini-3b-2507@us":{"i":"at"},"mistral.voxtral-small-24b-2507":{"i":"at","t":1},"mistral.voxtral-small-24b-2507@us":{"i":"at"},"mistral4-119b":{"i":"it","t":1,"r":1},"mistralai_ministral-3-3b-instruct-2512-gguf":{"i":"it"},"mistralai_mistral-small-3.2-24b-instruct-2506-gguf":{"i":"it"},"mistralai--mistral-medium":{"i":"it","t":1,"r":1},"mistralai--mistral-medium-instruct":{"i":"it","t":1},"mistralai--mistral-small":{"i":"it","t":1,"r":1},"mixtral-8x22b-instruct":{"i":"fpt","t":1,"f":1},"mixtral-8x7b-instruct":{"t":1,"f":1},"mixtral-8x7b-instruct-v0.1":{"i":"pt","r":1},"mm-poly-8b":{"i":"itv"},"model-router":{"i":"it","t":1},"molmo-7b-d-0924":{"i":"it"},"molmo2-4b":{"i":"it"},"molmo2-8b":{"i":"it"},"molmo2-o-7b":{"i":"it"},"monet-7b":{"i":"it"},"moondream2":{"i":"it"},"moondream3-preview":{"i":"it"},"moondream3.1-9b-a2b":{"i":"it"},"moonshot-kimi-k2-instruct":{"t":1},"moonshot.kimi-k2-thinking":{"t":1,"r":1},"moonshotai.kimi-k2.5":{"i":"it","t":1,"r":1},"motif-3":{"r":1},"muse-glimmer-30b":{"i":"ipt","t":1,"r":1,"f":1},"muse-glimmer-30b-4bit":{"i":"it"},"muse-glimmer-30b-abliterated-gguf":{"i":"it"},"muse-glimmer-30b-assistant":{"i":"it"},"muse-glimmer-30b-executorch-pte":{"i":"it"},"muse-glimmer-30b-fp8-block":{"i":"it"},"muse-glimmer-30b-gguf":{"i":"it"},"muse-glimmer-30b-heretic-uncensored-gguf":{"i":"it"},"muse-glimmer-30b-int4":{"i":"it"},"muse-glimmer-30b-nvfp4":{"i":"it"},"muse-glimmer-30b-nvfp4-w4a4":{"i":"it"},"muse-glimmer-30b-tr":{"i":"it","t":1,"r":1},"muse-glimmer-30b-unsloth-bnb-4bit":{"i":"it"},"muse-glimmer-30b:batch":{"i":"it","t":1,"r":1},"muse-glimmer-nvfp4":{"i":"it"},"muse-image-1.0":{"i":"it"},"muse-spark-1-1":{"i":"aitv","t":1,"r":1},"muse-spark-1-2":{"i":"aitv","t":1,"r":1},"muse-spark-1-3":{"i":"itv","t":1,"r":1},"muse-spark-1.1":{"i":"afiptv","t":1,"r":1},"muse-spark-1.2":{"i":"afiptv","t":1,"r":1},"muse-spark-1.2-contributor":{"i":"afiptv","t":1,"r":1},"muse-spark-1.2-contributor-free":{"i":"aiptv","t":1,"r":1,"f":1},"muse-spark-1.3":{"i":"afiptv","t":1,"r":1},"muse-spark-1.3-contributor":{"i":"afiptv","t":1,"r":1},"muse-spark-1.3-contributor-free":{"i":"aiptv","t":1,"r":1,"f":1},"nail-qwen3.6-35b-a3b-gguf":{"i":"it"},"nail-qwen3.6-35b-a3b-gguf-mtp":{"i":"it"},"namazu":{"i":"ipt","t":1,"r":1},"nano-banana":{"i":"it","t":1},"nano-banana-pro":{"i":"it","t":1},"nano-gpt-help":{"f":1},"nanonets-ocr-s":{"i":"it"},"nanonets-ocr-s-gguf":{"i":"it"},"nanonets-ocr2-3b":{"i":"it"},"nemotron-120b-a12b":{"t":1,"r":1},"nemotron-3_5-lightning":{"t":1,"r":1},"nemotron-3-120b-a12b":{"t":1,"r":1},"nemotron-3-content-safety":{"f":1},"nemotron-3-nano-30b":{"t":1,"r":1},"nemotron-3-nano-30b-a3b":{"t":1,"r":1,"f":1},"nemotron-3-nano-omni":{"i":"itv","t":1,"r":1},"nemotron-3-nano-omni-30b-a3b-reasoning":{"i":"aitv","t":1,"r":1,"f":1},"nemotron-3-nano-omni-30b-a3b-reasoning-bf16":{"t":1,"r":1},"nemotron-3-nano-omni-30b-a3b-reasoning:free":{"i":"aitv","t":1,"r":1,"f":1},"nemotron-3-nano-omni-reasoning-30b-a3b":{"i":"aitv","t":1,"r":1},"nemotron-3-nano-omni@eu":{"t":1,"r":1},"nemotron-3-nano:30b":{"t":1,"r":1},"nemotron-3-super":{"t":1,"r":1},"nemotron-3-super-120b-a12b":{"t":1,"r":1,"f":1},"nemotron-3-super-120b-a12b:free":{"t":1,"r":1,"f":1},"nemotron-3-super-120b-a12b:thinking":{"r":1},"nemotron-3-super-free":{"t":1,"r":1,"f":1},"nemotron-3-ultra":{"t":1,"r":1},"nemotron-3-ultra-550b":{"i":"it","t":1,"r":1},"nemotron-3-ultra-550b-a55b":{"t":1,"r":1,"f":1},"nemotron-3-ultra-550b-a55b:free":{"t":1,"r":1,"f":1},"nemotron-3-ultra-550b-a55b:thinking":{"t":1,"r":1},"nemotron-3-ultra-free":{"t":1,"r":1,"f":1},"nemotron-3-ultra-nvfp4":{"t":1,"r":1},"nemotron-3.5-content-safety":{"i":"it","r":1,"f":1},"nemotron-3.5-content-safety:free":{"i":"it","r":1,"f":1},"nemotron-3.5-lightning":{"t":1,"r":1},"nemotron-3.5-lightning-30b-a3b":{"t":1,"r":1,"f":1},"nemotron-3.5-lightning-free":{"t":1,"r":1,"f":1},"nemotron-3.5-lightning:free":{"t":1,"r":1,"f":1},"nemotron-3.5-lightning:thinking":{"t":1,"r":1},"nemotron-cascade-2-30b-a3b":{"t":1,"r":1},"nemotron-content-safety-reasoning-4b":{"r":1,"f":1},"nemotron-lightning-3.5-30b-a3b":{"t":1,"r":1},"nemotron-lightning-3p5-30b-a3b":{"t":1,"r":1},"nemotron-mini-4b-instruct":{"t":1,"f":1},"nemotron-nano-12b-v2-vl":{"i":"itv","t":1,"r":1,"f":1},"nemotron-nano-9b-v2":{"t":1,"r":1},"nemotron-nano-v2-12b":{"i":"it","t":1,"r":1},"nemotron-voicechat":{"i":"at","t":1,"f":1},"neosmith.intelligent-basic":{"i":"it","t":1,"r":1},"neosmith.intelligent-maestro":{"i":"it","t":1,"r":1},"neosmith.intelligent-pro":{"i":"it","t":1,"r":1},"neosmith.neolite":{"i":"it","t":1,"r":1},"nex-agi_nex-n2.5-mini-gguf":{"i":"it"},"nex-n2.5-mini:free":{"i":"it","t":1,"r":1,"f":1},"nex-n2.5-pro:free":{"i":"it","t":1,"r":1,"f":1},"north-micro-vision-instruct":{"i":"it"},"north-mini-code-1-0":{"t":1,"r":1,"f":1},"north-mini-code-free":{"t":1,"r":1,"f":1},"north-mini-code:free":{"t":1,"r":1,"f":1},"nova-2-lite":{"i":"ipt","t":1,"r":1},"nova-2-lite-v1":{"i":"fiptv","t":1,"r":1,"f":1},"nova-2-pro-v1":{"i":"iptv","t":1,"r":1,"f":1},"nova-lite":{"i":"iptv","t":1},"nova-lite-v1":{"i":"ipt","t":1,"r":1},"nova-micro":{"t":1},"nova-micro-v1":{"i":"it","t":1,"r":1},"nova-premier-v1":{"i":"it","t":1},"nova-pro":{"i":"iptv","t":1},"nova-pro-v1":{"i":"ipt","t":1,"r":1},"nuextract-2.0-2b":{"i":"it"},"nuextract3-gguf":{"i":"it"},"nuextract3-w4a16":{"i":"it"},"nv-embed-v1":{"f":1},"nv-embedcode-7b-v1":{"f":1},"nvidia-nemotron-3-nano-30b-a3b":{"t":1,"r":1},"nvidia-nemotron-3-nano-30b-a3b-bf16":{"t":1,"r":1},"nvidia-nemotron-3-nano-30b-a3b-fp8":{"t":1,"r":1},"nvidia-nemotron-3-super-120b":{"t":1,"r":1},"nvidia-nemotron-3-super-120b-a12b":{"t":1,"r":1},"nvidia-nemotron-3-super-120b-a12b-fp8":{"t":1,"r":1},"nvidia-nemotron-3-super-120b-a12b-nvfp4":{"t":1,"r":1},"nvidia-nemotron-3-ultra":{"r":1},"nvidia-nemotron-3-ultra-550b-a55b":{"t":1,"r":1},"nvidia-nemotron-3-ultra-550b-a55b-bf16":{"t":1,"r":1},"nvidia-nemotron-3.5-lightning-30b-a3b":{"t":1,"r":1},"nvidia-nemotron-3.5-lightning-30b-a3b-bf16":{"t":1,"r":1},"nvidia-nemotron-nano-12b-v2-vl-bf16":{"i":"it"},"nvidia-nemotron-nano-12b-v2-vl-fp8":{"i":"it"},"nvidia-nemotron-nano-12b-v2-vl-nvfp4-qad":{"i":"it"},"nvidia-nemotron-nano-9b-v2":{"t":1,"r":1,"f":1},"nvidia-nemotron-parse-2.0":{"i":"it"},"nvidia-nemotron-parse-v1.1":{"i":"it"},"nvidia-nemotron-parse-v1.2":{"i":"it"},"nvidia.nemotron-nano-12b-v2":{"i":"it","t":1},"nvidia.nemotron-nano-3-30b":{"t":1,"r":1},"nvidia.nemotron-nano-9b-v2":{"t":1},"nvidia.nemotron-super-3-120b":{"t":1,"r":1},"nvlm-d-72b":{"i":"it"},"o1":{"i":"fipt","t":1,"r":1},"o1-pro":{"i":"fipt","t":1,"r":1},"o3":{"i":"fipt","t":1,"r":1},"o3-deep-research":{"t":1,"r":1},"o3-fast":{"i":"ipt","t":1,"r":1},"o3-mini":{"i":"fipt","t":1,"r":1},"o3-mini-high":{"i":"fipt","t":1,"r":1},"o3-mini-low":{"t":1,"r":1},"o3-mini:batch":{"i":"ft","t":1,"r":1},"o3-pro":{"i":"fipt","t":1,"r":1},"o3-pro-2025-06-10":{"t":1,"r":1},"o3:batch":{"i":"fit","t":1,"r":1},"o4-mini":{"i":"fipt","t":1,"r":1},"o4-mini-deep-research":{"t":1,"r":1},"o4-mini-fast":{"i":"ipt","t":1,"r":1},"o4-mini-high":{"i":"fipt","t":1,"r":1},"o4-mini:batch":{"i":"fit","t":1,"r":1},"o4-mini@eu":{"i":"it","t":1,"r":1},"olafangensan-glm-4.7-flash-heretic":{"t":1,"r":1},"olmocr-2-7b-1025":{"i":"it"},"olmocr-2-7b-1025-fp8":{"i":"it"},"olmocr-7b-0225-preview":{"i":"it"},"olmocr-7b-0825-fp8":{"i":"it"},"omen-alpha":{"i":"it","t":1,"r":1},"open-mistral-7b":{"t":1},"open-mistral-nemo":{"t":1},"open-mixtral-8x22b":{"t":1},"open-mixtral-8x7b":{"t":1},"openai-gpt-4.1":{"i":"ipt","t":1},"openai-gpt-4o":{"i":"it","t":1},"openai-gpt-4o-2024-11-20":{"i":"it","t":1},"openai-gpt-4o-mini":{"i":"it","t":1,"r":1},"openai-gpt-4o-mini-2024-07-18":{"i":"it","t":1},"openai-gpt-5":{"i":"it","t":1,"r":1},"openai-gpt-5-mini":{"i":"it","t":1,"r":1},"openai-gpt-5-nano":{"i":"it","t":1,"r":1},"openai-gpt-5.1":{"i":"it","t":1,"r":1},"openai-gpt-5.1-codex-max":{"i":"it","t":1,"r":1},"openai-gpt-5.2":{"i":"it","t":1,"r":1},"openai-gpt-5.2-pro":{"i":"it","t":1,"r":1},"openai-gpt-5.3-codex":{"i":"it","t":1,"r":1},"openai-gpt-5.4":{"i":"ipt","t":1,"r":1},"openai-gpt-5.4-mini":{"i":"it","t":1,"r":1},"openai-gpt-5.4-nano":{"i":"it","t":1,"r":1},"openai-gpt-5.4-pro":{"i":"it","t":1,"r":1},"openai-gpt-5.5":{"i":"ipt","t":1,"r":1},"openai-gpt-5.6-luna":{"i":"ipt","t":1,"r":1},"openai-gpt-5.6-sol":{"i":"ipt","t":1,"r":1},"openai-gpt-5.6-terra":{"i":"ipt","t":1,"r":1},"openai-gpt-52":{"t":1,"r":1},"openai-gpt-53-codex":{"i":"it","t":1,"r":1},"openai-gpt-54":{"i":"it","t":1,"r":1},"openai-gpt-54-mini":{"i":"it","t":1,"r":1},"openai-gpt-54-pro":{"i":"it","t":1,"r":1},"openai-gpt-55":{"i":"it","t":1,"r":1},"openai-gpt-55-pro":{"i":"it","t":1,"r":1},"openai-gpt-56-luna":{"i":"it","t":1,"r":1},"openai-gpt-56-luna-pro":{"i":"it","t":1,"r":1},"openai-gpt-56-sol":{"i":"it","t":1,"r":1},"openai-gpt-56-sol-pro":{"i":"it","t":1,"r":1},"openai-gpt-56-terra":{"i":"it","t":1,"r":1},"openai-gpt-56-terra-pro":{"i":"it","t":1,"r":1},"openai-gpt-6-astra":{"i":"it","t":1,"r":1},"openai-gpt-6-astra-pro":{"i":"it","t":1,"r":1},"openai-gpt-image-1":{"i":"it"},"openai-gpt-image-1.5":{"i":"it"},"openai-gpt-image-2":{"i":"it"},"openai-gpt-oss-120b":{"t":1,"r":1},"openai-gpt-oss-20b":{"t":1,"r":1},"openai-o1":{"i":"it","t":1,"r":1},"openai-o3":{"i":"it","t":1,"r":1},"openai-o3-mini":{"i":"it","t":1,"r":1},"openai.gpt-5.4":{"i":"ipt","t":1,"r":1},"openai.gpt-5.5":{"i":"ipt","t":1,"r":1},"openai.gpt-5.6-luna":{"i":"ipt","t":1,"r":1},"openai.gpt-5.6-sol":{"i":"ipt","t":1,"r":1},"openai.gpt-5.6-terra":{"i":"ipt","t":1,"r":1},"openai.gpt-6-astra":{"i":"ipt","t":1,"r":1},"openai.gpt-oss-120b":{"t":1,"r":1},"openai.gpt-oss-120b-1:0":{"t":1,"r":1},"openai.gpt-oss-20b":{"t":1,"r":1},"openai.gpt-oss-20b-1:0":{"t":1,"r":1},"openai.gpt-oss-safeguard-120b":{"t":1,"r":1},"openai.gpt-oss-safeguard-20b":{"t":1,"r":1},"openai.gpt-oss-safeguard-20b@us":{"r":1},"openreasoning-nemotron-32b":{"r":1},"openvla-7b-finetuned-libero-spatial":{"i":"it"},"orcarouter_qwen3.8-27b-uncensored-gguf":{"i":"it"},"ornith-1.0-35b-fp8":{"i":"it","t":1,"r":1,"f":1},"ornith-1.0-35b-nvfp4":{"i":"it"},"ornith-1.5-35b-a3b":{"i":"it","t":1,"r":1},"ornith-1.5-35b-a3b-abliterated-gguf":{"i":"it"},"ornith-1.5-35b-a3b-abliterated-mtp-ud-apex-gguf":{"i":"it"},"ornith-1.5-35b-a3b-gguf":{"i":"it"},"ornith-1.5-35b-a3b-uncensored-gguf":{"i":"it"},"ornith-1.5-35b-a3b:thinking":{"i":"it","t":1,"r":1},"ornith-1.5-35b-mtp-ud-apex-gguf":{"i":"it"},"ornith-1.5-9b-gguf":{"i":"it"},"ornith-1.5-9b-mtp-gguf":{"i":"it"},"ornith-1.5-9b-uncensored-gguf":{"i":"it"},"osmosis-structure-0.6b":{"t":1},"ovis2-1b":{"i":"it"},"ovis2-1b-hf":{"i":"it"},"ovis2-4b":{"i":"it"},"ovisocr2":{"i":"it"},"ox-alpha-free":{"i":"itv","t":1,"r":1,"f":1},"paddleocr-vl":{"i":"it"},"paddleocr-vl-1.5":{"i":"it","f":1},"paddleocr-vl-1.6":{"i":"it"},"paligemma-3b-ft-cococap-448":{"i":"it"},"paligemma-3b-mix-224":{"i":"it"},"paligemma-3b-pt-224":{"i":"it"},"paligemma2-3b-ft-docci-448":{"i":"it"},"paligemma2-3b-mix-224":{"i":"it"},"paligemma2-3b-pt-224":{"i":"it"},"palmyra-x4":{"t":1},"palmyra-x5":{"t":1},"pareto-code":{"f":1},"perceptron-mk1":{"i":"itv","r":1},"phi-3.5-vision-instruct":{"i":"it"},"phi-4-mini":{"t":1},"phi-4-mini-instruct":{"t":1,"f":1},"phi-4-mini-reasoning":{"t":1,"r":1},"phi-4-multimodal":{"i":"ait"},"phi-4-multimodal-instruct":{"f":1},"phi-4-reasoning":{"r":1},"phi-4-reasoning-plus":{"r":1},"pixtral-12b":{"i":"it","t":1},"pixtral-12b-2409":{"i":"it","t":1,"r":1},"pixtral-large-2502":{"i":"ipt","t":1,"r":1},"pixtral-large-latest":{"i":"it","t":1},"pokee-isaac":{"t":1,"r":1},"procvlm-2b":{"i":"it"},"q-realign-lite-4b":{"i":"it"},"q-realign-mini-0.8b":{"i":"it"},"qari-ocr-v0.3-vl-2b-instruct":{"i":"it"},"qianfan-ocr":{"i":"it"},"qvq-max":{"i":"it","t":1,"r":1},"qwable-9b-claude-fable-5-gguf":{"i":"it"},"qwen_qwen2.5-vl-7b-instruct-gguf":{"i":"it"},"qwen_qwen3-vl-2b-instruct-gguf":{"i":"it"},"qwen_qwen3-vl-30b-a3b-instruct-gguf":{"i":"it"},"qwen_qwen3.5-0.8b-gguf":{"i":"it"},"qwen_qwen3.5-122b-a10b-gguf":{"i":"it"},"qwen_qwen3.5-27b-gguf":{"i":"it"},"qwen_qwen3.5-2b-gguf":{"i":"it"},"qwen_qwen3.5-35b-a3b-gguf":{"i":"it"},"qwen_qwen3.5-4b-gguf":{"i":"it"},"qwen_qwen3.5-9b-gguf":{"i":"it"},"qwen_qwen3.6-27b-gguf":{"i":"it"},"qwen_qwen3.6-35b-a3b-gguf":{"i":"it"},"qwen-2.5-14b-instruct":{"t":1},"qwen-2.5-72b-instruct":{"t":1},"qwen-2.5-7b-instruct":{"t":1},"qwen-2.5-7b-vision-instruct":{"i":"it","t":1},"qwen-2.5-coder-32b":{"t":1},"qwen-3-14b":{"t":1,"r":1},"qwen-3-235b":{"t":1,"r":1},"qwen-3-30b":{"t":1,"r":1},"qwen-3-32b":{"t":1,"r":1},"qwen-3-6-plus":{"i":"iptv","t":1,"r":1},"qwen-3-7-max":{"i":"itv","t":1,"r":1},"qwen-3-7-plus":{"i":"itv","t":1,"r":1},"qwen-3-8-2-4t-a95b":{"t":1,"r":1},"qwen-3-8-27b":{"i":"itv","t":1,"r":1},"qwen-3-8-flash":{"i":"itv","t":1,"r":1},"qwen-3-8-max":{"i":"itv","t":1,"r":1},"qwen-3.6-max-preview":{"t":1,"r":1},"qwen-3.6-plus":{"i":"itv","t":1,"r":1},"qwen-3.8-27b":{"i":"it","t":1,"r":1},"qwen-coder-plus":{"t":1},"qwen-deep-research":{"t":1},"qwen-doc-turbo":{"t":1},"qwen-flash":{"t":1,"r":1},"qwen-image":{"i":"it","f":1},"qwen-image-2.0":{"f":1},"qwen-image-2.0-pro":{"f":1},"qwen-image-bench":{"i":"it"},"qwen-image-edit":{"i":"it","f":1},"qwen-long":{"i":"pt","t":1},"qwen-math-plus":{"t":1},"qwen-math-turbo":{"t":1},"qwen-max":{"t":1},"qwen-max-2025-01-25":{"t":1},"qwen-max-latest":{"i":"it","t":1,"r":1},"qwen-omni-turbo":{"i":"aitv","t":1},"qwen-omni-turbo-realtime":{"i":"ait","t":1},"qwen-plus":{"t":1,"r":1},"qwen-plus-2025-07-28":{"t":1},"qwen-plus-character":{"t":1},"qwen-plus-character-ja":{"t":1},"qwen-plus-latest":{"i":"it","t":1},"qwen-sea-lion-v4-8b-vl":{"i":"it"},"qwen-turbo":{"t":1,"r":1},"qwen-vl-max":{"i":"itv","t":1},"qwen-vl-max-2025-01-25":{"i":"aitv","t":1},"qwen-vl-ocr":{"i":"it"},"qwen-vl-plus":{"i":"itv","t":1},"qwen.qwen3-235b-a22b-2507-v1:0":{"t":1},"qwen.qwen3-32b-v1:0":{"t":1,"r":1},"qwen.qwen3-coder-30b-a3b-v1:0":{"t":1},"qwen.qwen3-coder-480b-a35b-v1:0":{"t":1},"qwen.qwen3-coder-next":{"t":1},"qwen.qwen3-next-80b-a3b":{"t":1},"qwen.qwen3-vl-235b-a22b":{"i":"it","t":1},"qwen.qwen3-vl-embedding-2b-gguf":{"i":"it"},"qwen.qwen3.8-27b-gguf":{"i":"it"},"qwen2-5-14b-instruct":{"t":1},"qwen2-5-32b-instruct":{"t":1},"qwen2-5-72b-instruct":{"t":1},"qwen2-5-7b-instruct":{"t":1},"qwen2-5-coder-32b-instruct":{"t":1},"qwen2-5-coder-7b-instruct":{"t":1},"qwen2-5-math-72b-instruct":{"t":1},"qwen2-5-math-7b-instruct":{"t":1},"qwen2-5-omni-7b":{"i":"aitv","t":1},"qwen2-5-vl-72b-instruct":{"i":"it","t":1},"qwen2-5-vl-7b-instruct":{"i":"it","t":1},"qwen2-vl-2b-instruct":{"i":"it"},"qwen2-vl-2b-instruct-4bit":{"i":"it"},"qwen2-vl-2b-instruct-awq":{"i":"it"},"qwen2-vl-2b-instruct-gguf":{"i":"it"},"qwen2-vl-72b-instruct":{"i":"it"},"qwen2-vl-7b-instruct":{"i":"it"},"qwen2-vl-7b-instruct-awq":{"i":"it"},"qwen2.5-72b-instruct":{"t":1},"qwen2.5-7b-instruct":{"t":1},"qwen2.5-7b-instruct-turbo":{"t":1},"qwen2.5-coder-32b-instruct":{"t":1,"f":1},"qwen2.5-vl-32b-instruct":{"i":"it","t":1},"qwen2.5-vl-32b-instruct-awq":{"i":"it"},"qwen2.5-vl-32b-instruct-gguf":{"i":"it"},"qwen2.5-vl-3b-instruct":{"i":"it"},"qwen2.5-vl-3b-instruct-abliterated":{"i":"it"},"qwen2.5-vl-3b-instruct-awq":{"i":"it"},"qwen2.5-vl-3b-instruct-gguf":{"i":"it"},"qwen2.5-vl-3b-instruct-quantized.w8a8":{"i":"it"},"qwen2.5-vl-72b-instruct":{"i":"aitv","t":1,"r":1},"qwen2.5-vl-72b-instruct-awq":{"i":"it"},"qwen2.5-vl-72b-instruct-gguf":{"i":"it"},"qwen2.5-vl-7b-instruct":{"i":"aitv","t":1},"qwen2.5-vl-7b-instruct-abliterated":{"i":"it"},"qwen2.5-vl-7b-instruct-awq":{"i":"it"},"qwen2.5-vl-7b-instruct-bnb-4bit":{"i":"it"},"qwen2.5-vl-7b-instruct-gguf":{"i":"it"},"qwen2.5-vl-7b-instruct-quantized.w8a8":{"i":"it"},"qwen3_5-9b-mlx-4bit":{"i":"it","t":1,"f":1},"qwen3_5-9b-q4_k_m":{"i":"it","t":1,"f":1},"qwen3-1.7b-base":{"t":1,"r":1},"qwen3-14b":{"t":1,"r":1},"qwen3-14b-instruct":{"t":1},"qwen3-235b":{"t":1,"r":1,"f":1},"qwen3-235b-2507-cs":{"t":1,"r":1},"qwen3-235b-a22b":{"i":"pt","t":1,"r":1},"qwen3-235b-a22b-2507":{"t":1},"qwen3-235b-a22b-fp8":{"t":1,"r":1},"qwen3-235b-a22b-instruct":{"t":1,"f":1},"qwen3-235b-a22b-instruct-2507":{"t":1,"r":1,"f":1},"qwen3-235b-a22b-instruct-2507-maas":{"t":1,"r":1},"qwen3-235b-a22b-instruct-2507-tput":{"t":1},"qwen3-235b-a22b-thinking":{"i":"iptv","t":1,"r":1},"qwen3-235b-a22b-thinking-2507":{"t":1,"r":1,"f":1},"qwen3-235b-a22b-thinking-2507-tee":{"t":1,"r":1},"qwen3-30b-a3b":{"i":"it","t":1,"r":1},"qwen3-30b-a3b-2507":{"t":1,"f":1},"qwen3-30b-a3b-fp8":{"t":1,"r":1},"qwen3-30b-a3b-instruct-2507":{"t":1,"r":1,"f":1},"qwen3-30b-a3b-thinking-2507":{"t":1,"r":1,"f":1},"qwen3-32b":{"i":"pt","t":1,"r":1,"f":1},"qwen3-32b-cs":{"t":1,"r":1},"qwen3-32b-fp8":{"r":1},"qwen3-32b-tee":{"t":1,"r":1},"qwen3-4b-base":{"t":1,"r":1},"qwen3-4b-fp8":{"r":1},"qwen3-4b-instruct-2507":{"t":1,"r":1},"qwen3-5-122b-a10b":{"i":"itv","t":1,"r":1},"qwen3-5-27b":{"i":"itv","t":1,"r":1},"qwen3-5-35b-a3b":{"i":"itv","t":1,"r":1},"qwen3-5-397b-a17b":{"i":"itv","t":1,"r":1},"qwen3-5-4b":{"i":"itv","t":1,"r":1},"qwen3-5-9b":{"i":"itv","t":1,"r":1},"qwen3-5-flash":{"i":"itv","t":1,"r":1},"qwen3-5-plus":{"i":"itv","t":1,"r":1},"qwen3-6-27b":{"i":"itv","t":1,"r":1},"qwen3-6-35b":{"i":"aitv","r":1},"qwen3-6-35b-a3b":{"i":"it","t":1,"r":1},"qwen3-6-flash":{"i":"itv","t":1,"r":1},"qwen3-6-max-preview":{"t":1,"r":1},"qwen3-6-plus":{"i":"itv","t":1,"r":1},"qwen3-7-flash":{"i":"itv","t":1,"r":1},"qwen3-7-max":{"t":1,"r":1},"qwen3-7-plus":{"i":"itv","t":1,"r":1,"f":1},"qwen3-8-27b":{"i":"itv","t":1,"r":1},"qwen3-8-flash":{"i":"itv","t":1,"r":1},"qwen3-8-max":{"i":"iptv","t":1,"r":1,"f":1},"qwen3-8-max-0902":{"i":"itv","t":1,"r":1},"qwen3-8b":{"t":1,"r":1},"qwen3-8b-fp8":{"r":1},"qwen3-asr-flash":{"i":"a"},"qwen3-coder":{"i":"aitv","t":1,"r":1},"qwen3-coder-30b":{"t":1,"f":1},"qwen3-coder-30b-a3b":{"t":1,"r":1},"qwen3-coder-30b-a3b-instruct":{"t":1,"f":1},"qwen3-coder-480b-a35b-instruct":{"t":1,"f":1},"qwen3-coder-480b-a35b-instruct-fp8":{"t":1},"qwen3-coder-480b-a35b-instruct-int4-mixed-ar":{"t":1},"qwen3-coder-480b-a35b-instruct-turbo":{"t":1},"qwen3-coder-flash":{"t":1},"qwen3-coder-next":{"t":1,"r":1,"f":1},"qwen3-coder-next-fp8":{"t":1,"f":1},"qwen3-coder-next-fp8-no-thinking":{"t":1,"f":1},"qwen3-coder-next@eu":{"t":1},"qwen3-coder-plus":{"t":1,"f":1},"qwen3-coder:30b":{"t":1,"f":1},"qwen3-embedding-8b":{"f":1},"qwen3-livetranslate-flash-realtime":{"i":"aitv"},"qwen3-max":{"t":1,"r":1,"f":1},"qwen3-max-2025-09-23":{"t":1},"qwen3-max-2026-01-23":{"t":1,"f":1},"qwen3-max-preview":{"t":1,"f":1},"qwen3-max-thinking":{"t":1,"r":1},"qwen3-max@eu":{"t":1},"qwen3-next-80b":{"t":1},"qwen3-next-80b-a3b-instruct":{"i":"itv","t":1,"f":1},"qwen3-next-80b-a3b-thinking":{"t":1,"r":1},"qwen3-omni-30b-a3b-instruct":{"i":"aitv","t":1},"qwen3-omni-30b-a3b-thinking":{"i":"aitv","t":1,"r":1},"qwen3-omni-flash":{"i":"aitv","t":1,"r":1},"qwen3-omni-flash-realtime":{"i":"aitv","t":1},"qwen3-vl":{"i":"it"},"qwen3-vl-235b-a22b":{"i":"it","t":1,"r":1},"qwen3-vl-235b-a22b-instruct":{"i":"itv","t":1},"qwen3-vl-235b-a22b-instruct-fp8":{"i":"it","t":1},"qwen3-vl-235b-a22b-instruct-gguf":{"i":"it"},"qwen3-vl-235b-a22b-instruct-mxfp4":{"i":"it"},"qwen3-vl-235b-a22b-instruct-original":{"i":"it"},"qwen3-vl-235b-a22b-thinking":{"i":"itv","t":1,"r":1},"qwen3-vl-235b-a22b-thinking-gguf":{"i":"it"},"qwen3-vl-2b-instruct":{"i":"it"},"qwen3-vl-2b-instruct-awq-4bit":{"i":"it"},"qwen3-vl-2b-instruct-fp8":{"i":"it"},"qwen3-vl-2b-instruct-gguf":{"i":"it"},"qwen3-vl-2b-instruct-unsloth-bnb-4bit":{"i":"it"},"qwen3-vl-2b-thinking":{"i":"it"},"qwen3-vl-2b-thinking-gguf":{"i":"it"},"qwen3-vl-30b-a3b":{"i":"it","t":1,"r":1},"qwen3-vl-30b-a3b-instruct":{"i":"itv","t":1},"qwen3-vl-30b-a3b-instruct-awq-4bit":{"i":"it"},"qwen3-vl-30b-a3b-instruct-fp8":{"i":"it"},"qwen3-vl-30b-a3b-instruct-gguf":{"i":"it"},"qwen3-vl-30b-a3b-instruct-mlx-4bit":{"i":"it"},"qwen3-vl-30b-a3b-instruct-mlx-5bit":{"i":"it"},"qwen3-vl-30b-a3b-instruct-mlx-6bit":{"i":"it"},"qwen3-vl-30b-a3b-instruct-mlx-8bit":{"i":"it"},"qwen3-vl-30b-a3b-thinking":{"i":"itv","t":1,"r":1},"qwen3-vl-30b-a3b-thinking-fp8":{"i":"it"},"qwen3-vl-30b-a3b-thinking-gguf":{"i":"it"},"qwen3-vl-32b-instruct":{"i":"it","t":1},"qwen3-vl-32b-instruct-awq":{"i":"it"},"qwen3-vl-32b-instruct-fp8":{"i":"it"},"qwen3-vl-32b-instruct-gguf":{"i":"it"},"qwen3-vl-32b-thinking":{"i":"it","t":1,"r":1},"qwen3-vl-32b-thinking-fp8":{"i":"it"},"qwen3-vl-4b-instruct":{"i":"it"},"qwen3-vl-4b-instruct-4bit":{"i":"it"},"qwen3-vl-4b-instruct-awq-4bit":{"i":"it"},"qwen3-vl-4b-instruct-awq-8bit":{"i":"it"},"qwen3-vl-4b-instruct-fp8":{"i":"it"},"qwen3-vl-4b-instruct-gguf":{"i":"it"},"qwen3-vl-4b-instruct-mlx-4bit":{"i":"it"},"qwen3-vl-4b-instruct-mlx-5bit":{"i":"it"},"qwen3-vl-4b-instruct-mlx-6bit":{"i":"it"},"qwen3-vl-4b-instruct-mlx-8bit":{"i":"it"},"qwen3-vl-4b-instruct-unsloth-bnb-4bit":{"i":"it"},"qwen3-vl-4b-thinking":{"i":"it"},"qwen3-vl-8b-instruct":{"i":"itv","t":1},"qwen3-vl-8b-instruct-abliterated-v2-gguf":{"i":"it"},"qwen3-vl-8b-instruct-awq-4bit":{"i":"it"},"qwen3-vl-8b-instruct-bnb-4bit":{"i":"it"},"qwen3-vl-8b-instruct-fp8":{"i":"it"},"qwen3-vl-8b-instruct-gguf":{"i":"it"},"qwen3-vl-8b-instruct-mlx-4bit":{"i":"it"},"qwen3-vl-8b-instruct-mlx-5bit":{"i":"it"},"qwen3-vl-8b-instruct-mlx-6bit":{"i":"it"},"qwen3-vl-8b-instruct-mlx-8bit":{"i":"it"},"qwen3-vl-8b-instruct-unsloth-bnb-4bit":{"i":"it"},"qwen3-vl-8b-instruct-w8a8-llmcompressor":{"i":"it"},"qwen3-vl-8b-thinking":{"i":"it","t":1,"r":1},"qwen3-vl-8b-thinking-fp8":{"i":"it"},"qwen3-vl-8b-thinking-gguf":{"i":"it"},"qwen3-vl-embedding-8b":{"i":"it"},"qwen3-vl-flash":{"i":"it","t":1},"qwen3-vl-instruct":{"i":"it","t":1},"qwen3-vl-moe":{"i":"it"},"qwen3-vl-plus":{"i":"it","t":1,"r":1,"f":1},"qwen3-vl-thinking":{"i":"ipt","t":1,"r":1},"qwen3.5-0.8b":{"i":"it","t":1,"f":1},"qwen3.5-0.8b-base":{"i":"it"},"qwen3.5-0.8b-gguf":{"i":"it"},"qwen3.5-0.8b-mtp-gguf":{"i":"it"},"qwen3.5-0.8b-onnx":{"i":"it"},"qwen3.5-122b":{"i":"it","t":1,"r":1},"qwen3.5-122b-a10b":{"i":"aitv","t":1,"r":1,"f":1},"qwen3.5-122b-a10b-awq-4bit":{"i":"it"},"qwen3.5-122b-a10b-fp8":{"i":"it","t":1,"r":1},"qwen3.5-122b-a10b-gguf":{"i":"it"},"qwen3.5-122b-a10b-gptq-int4":{"i":"it"},"qwen3.5-122b-a10b-mtp-gguf":{"i":"it"},"qwen3.5-122b-a10b-uncensored-hauhaucs-aggressive":{"i":"it"},"qwen3.5-122b-a10b:thinking":{"t":1,"r":1},"qwen3.5-27b":{"i":"aitv","t":1,"r":1},"qwen3.5-27b-awq":{"i":"it"},"qwen3.5-27b-awq-4bit":{"i":"it"},"qwen3.5-27b-bluestar-v3-derestricted":{"i":"it","t":1,"r":1},"qwen3.5-27b-claude-4.6-opus-reasoning-distilled-gguf":{"i":"it"},"qwen3.5-27b-claude-4.6-opus-reasoning-distilled-v2-awq":{"i":"it"},"qwen3.5-27b-claude-4.6-opus-reasoning-distilled-v2-gguf":{"i":"it"},"qwen3.5-27b-fp8":{"i":"it"},"qwen3.5-27b-gguf":{"i":"it"},"qwen3.5-27b-gptq-int4":{"i":"it"},"qwen3.5-27b-heretic":{"i":"it"},"qwen3.5-27b-queen-derestricted":{"i":"it","t":1,"r":1},"qwen3.5-27b:thinking":{"i":"itv","t":1,"r":1},"qwen3.5-2b":{"i":"it","t":1,"r":1,"f":1},"qwen3.5-2b-awq-4bit":{"i":"it"},"qwen3.5-2b-base":{"i":"it"},"qwen3.5-2b-gguf":{"i":"it"},"qwen3.5-2b-mlx-4bit":{"i":"it"},"qwen3.5-2b-mtp-gguf":{"i":"it"},"qwen3.5-2b-nvfp4":{"i":"it"},"qwen3.5-35b-a3b":{"i":"aitv","t":1,"r":1},"qwen3.5-35b-a3b-awq":{"i":"it"},"qwen3.5-35b-a3b-awq-4bit":{"i":"it"},"qwen3.5-35b-a3b-base":{"i":"it"},"qwen3.5-35b-a3b-fp8":{"i":"it"},"qwen3.5-35b-a3b-gguf":{"i":"it"},"qwen3.5-35b-a3b-gptq-int4":{"i":"it"},"qwen3.5-35b-a3b-mtp-gguf":{"i":"it"},"qwen3.5-35b-a3b-nvfp4":{"i":"it"},"qwen3.5-35b-a3b-uncensored-hauhaucs-aggressive":{"i":"it"},"qwen3.5-35b-a3b:thinking":{"i":"itv","t":1,"r":1},"qwen3.5-397b-a17b":{"i":"aitv","t":1,"r":1,"f":1},"qwen3.5-397b-a17b-awq-4bit":{"i":"it"},"qwen3.5-397b-a17b-fp8":{"i":"it","t":1,"r":1},"qwen3.5-397b-a17b-gguf":{"i":"it"},"qwen3.5-397b-a17b-gptq-int4":{"i":"it"},"qwen3.5-397b-a17b-mxfp4":{"i":"it"},"qwen3.5-397b-a17b-tee":{"i":"it","t":1,"r":1},"qwen3.5-397b-a17b:free":{"i":"aitv","t":1,"r":1,"f":1},"qwen3.5-397b-a17b:thinking":{"i":"itv","t":1,"r":1},"qwen3.5-4b":{"i":"itv","t":1,"r":1,"f":1},"qwen3.5-4b-awq":{"i":"it"},"qwen3.5-4b-awq-4bit":{"i":"it"},"qwen3.5-4b-base":{"i":"it"},"qwen3.5-4b-claude-4.6-opus-reasoning-distilled-v2-gguf":{"i":"it"},"qwen3.5-4b-fp8-dynamic":{"i":"it"},"qwen3.5-4b-gguf":{"i":"it"},"qwen3.5-4b-mtp-gguf":{"i":"it"},"qwen3.5-4b-nvfp4":{"i":"it"},"qwen3.5-4b-quantized.w4a16":{"i":"it"},"qwen3.5-9b":{"i":"aitv","t":1,"r":1,"f":1},"qwen3.5-9b-4bit":{"i":"it"},"qwen3.5-9b-abliterated-gguf":{"i":"it"},"qwen3.5-9b-awq":{"i":"it"},"qwen3.5-9b-awq-4bit":{"i":"it"},"qwen3.5-9b-base":{"i":"it"},"qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored":{"i":"it"},"qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8":{"i":"it"},"qwen3.5-9b-claude-4.6-opus-reasoning-distilled":{"i":"it"},"qwen3.5-9b-claude-4.6-opus-reasoning-distilled-gguf":{"i":"it"},"qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2-gguf":{"i":"it"},"qwen3.5-9b-claude-4.6-os-auto-variable-heretic-uncensored-thinking-max-neocode-imatrix-gguf":{"i":"it"},"qwen3.5-9b-cold-fusion-gain-v1.0-uncensored-heretic-neo-max-imatrix-gguf":{"i":"it"},"qwen3.5-9b-deepseek-v4-flash-gguf":{"i":"it"},"qwen3.5-9b-fp8":{"i":"it"},"qwen3.5-9b-fp8-dynamic":{"i":"it"},"qwen3.5-9b-gguf":{"i":"it"},"qwen3.5-9b-glm5.1-distill-v1-gguf":{"i":"it"},"qwen3.5-9b-mlx-4bit":{"i":"it"},"qwen3.5-9b-mlx-8bit":{"i":"it"},"qwen3.5-9b-mtp-gguf":{"i":"it"},"qwen3.5-9b-nvfp4":{"i":"it"},"qwen3.5-9b-quantized.w4a16":{"i":"it"},"qwen3.5-9b-the-defiant-fable-uncensored-heretic-neo-imatrix-max-mtp-gguf":{"i":"it"},"qwen3.5-9b:batch":{"i":"itv","t":1,"r":1},"qwen3.5-flash":{"i":"iptv","t":1,"r":1},"qwen3.5-flash-02-23":{"i":"itv","t":1,"r":1},"qwen3.5-flash:thinking":{"i":"itv","r":1},"qwen3.5-moe":{"i":"it"},"qwen3.5-omni-flash":{"i":"aitv"},"qwen3.5-omni-plus":{"i":"aitv"},"qwen3.5-plus":{"i":"iptv","t":1,"r":1,"f":1},"qwen3.5-plus-02-15":{"i":"itv","t":1,"r":1},"qwen3.5-plus-20260420":{"i":"itv","t":1,"r":1},"qwen3.5-plus:thinking":{"i":"itv","r":1},"qwen3.5:397b":{"i":"it","t":1,"r":1},"qwen3.6":{"i":"it","t":1,"r":1,"f":1},"qwen3.6-27b":{"i":"aiptv","t":1,"r":1,"f":1},"qwen3.6-27b-4bit":{"i":"it"},"qwen3.6-27b-awq":{"i":"it"},"qwen3.6-27b-awq-int4":{"i":"it"},"qwen3.6-27b-awq-mtp":{"i":"it"},"qwen3.6-27b-fable-fusion-711-uncensored-heretic-nm-dau-neo-max-mtp-gguf":{"i":"it"},"qwen3.6-27b-fp8":{"i":"aitv","t":1,"r":1,"f":1},"qwen3.6-27b-gguf":{"i":"it"},"qwen3.6-27b-gptq-4bit":{"i":"it"},"qwen3.6-27b-gptq-int4":{"i":"it"},"qwen3.6-27b-gptq-pro-4bit":{"i":"it"},"qwen3.6-27b-heretic-uncensored-finetune-neo-code-di-imatrix-max-gguf":{"i":"it"},"qwen3.6-27b-int4-autoround":{"i":"it"},"qwen3.6-27b-mlx-4bit":{"i":"it"},"qwen3.6-27b-mlx-5bit":{"i":"it"},"qwen3.6-27b-mlx-6bit":{"i":"it"},"qwen3.6-27b-mlx-8bit":{"i":"it"},"qwen3.6-27b-mtp-gguf":{"i":"it"},"qwen3.6-27b-nvfp4":{"i":"it"},"qwen3.6-27b-tee":{"i":"it","t":1,"r":1},"qwen3.6-27b-uncensored-hauhaucs-aggressive":{"i":"it"},"qwen3.6-27b-uncensored-hauhaucs-balanced":{"i":"it"},"qwen3.6-27b-uncensored-heretic-v2-native-mtp-preserved-gguf":{"i":"it"},"qwen3.6-27b-v2-abliterated-uncensored-q4_k_m-gguf":{"i":"it"},"qwen3.6-27b:thinking":{"i":"itv","t":1,"r":1},"qwen3.6-35b":{"i":"it","t":1,"r":1},"qwen3.6-35b-a3b":{"i":"aitv","t":1,"r":1,"f":1},"qwen3.6-35b-a3b-4bit":{"i":"it"},"qwen3.6-35b-a3b-8bit":{"i":"it"},"qwen3.6-35b-a3b-awq":{"i":"it"},"qwen3.6-35b-a3b-awq-4bit":{"i":"it"},"qwen3.6-35b-a3b-fp8":{"i":"aitv","t":1,"r":1,"f":1},"qwen3.6-35b-a3b-fp8-no-thinking":{"i":"aitv","t":1,"f":1},"qwen3.6-35b-a3b-gguf":{"i":"it"},"qwen3.6-35b-a3b-gptq-int4":{"i":"it"},"qwen3.6-35b-a3b-heretic-nvfp4":{"i":"it"},"qwen3.6-35b-a3b-mlx-4bit":{"i":"it"},"qwen3.6-35b-a3b-mlx-6bit":{"i":"it"},"qwen3.6-35b-a3b-mlx-8bit":{"i":"it"},"qwen3.6-35b-a3b-mtp-gguf":{"i":"it"},"qwen3.6-35b-a3b-ninfer":{"i":"it"},"qwen3.6-35b-a3b-nvfp4":{"i":"it"},"qwen3.6-35b-a3b-nvfp4-fast":{"i":"it"},"qwen3.6-35b-a3b-ud-mlx-4bit":{"i":"it"},"qwen3.6-35b-a3b-uncensored":{"i":"it","t":1,"r":1},"qwen3.6-35b-a3b-uncensored-genesis-final-gguf":{"i":"it"},"qwen3.6-35b-a3b-uncensored-genesis-hermes-final-gguf":{"i":"it"},"qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive":{"i":"it"},"qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive-nvfp4":{"i":"it"},"qwen3.6-35b-a3b-uncensored-heretic-gguf":{"i":"it"},"qwen3.6-35b-a3b-uncensored-heretic-mlx-4bit":{"i":"it"},"qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-apex-gguf":{"i":"it"},"qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-gguf":{"i":"it"},"qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-gptq-int4":{"i":"it"},"qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-nvfp4-experts-only-gguf":{"i":"it"},"qwen3.6-35b-a3b-uncensored-heretic-nvfp4-experts-only-gguf":{"i":"it"},"qwen3.6-35b-a3b:thinking":{"i":"itv","t":1,"r":1},"qwen3.6-35b-fast":{"i":"it","t":1},"qwen3.6-40b-claude-4.6-opus-deckard-heretic-uncensored-thinking-neo-code-di-imatrix-max-gguf":{"i":"it"},"qwen3.6-40b-fable-fusion-6-core-deckard-eleanor-heretic-uncensored-nm-dau-neo-max-mtp-gguf":{"i":"it"},"qwen3.6-40b-grand-intelligence-fable-fusion-uncensored-heretic-nm-dau-neo-max-mtp-gguf":{"i":"it"},"qwen3.6-flash":{"i":"itv","t":1,"r":1,"f":1},"qwen3.6-max":{"t":1,"r":1},"qwen3.6-max-preview":{"t":1,"r":1},"qwen3.6-plus":{"i":"iptv","t":1,"r":1,"f":1},"qwen3.6-plus-free":{"i":"itv","t":1,"r":1,"f":1},"qwen3.6:27b":{"i":"it","t":1,"r":1,"f":1},"qwen3.7-flash":{"i":"iptv","t":1,"r":1},"qwen3.7-flash:thinking":{"i":"itv","t":1,"r":1},"qwen3.7-max":{"t":1,"r":1,"f":1},"qwen3.7-max-2026-06-08":{"t":1,"r":1},"qwen3.7-max:thinking":{"t":1,"r":1},"qwen3.7-plus":{"i":"iptv","t":1,"r":1,"f":1},"qwen3.7-plus:thinking":{"i":"itv","t":1,"r":1},"qwen3.8-2.4t-a95b":{"i":"it","t":1,"r":1},"qwen3.8-2.4t-a95b-nvfp4":{"t":1,"r":1},"qwen3.8-2.4t-a95b:batch":{"t":1,"r":1},"qwen3.8-2.4t-a95b@eu":{"t":1,"r":1},"qwen3.8-27b":{"i":"iptv","t":1,"r":1,"f":1},"qwen3.8-27b-4bit":{"i":"it"},"qwen3.8-27b-8bit":{"i":"it"},"qwen3.8-27b-abliterated-awq-mtp":{"i":"it"},"qwen3.8-27b-abliterated-gguf":{"i":"it"},"qwen3.8-27b-abliterated-nvfp4":{"i":"it"},"qwen3.8-27b-abliterated-uncensored-philadelphia-class":{"i":"it"},"qwen3.8-27b-aeon-ultimate-uncensored-attention8-bf16recurrence-vision-mtplx":{"i":"it"},"qwen3.8-27b-awq":{"i":"it"},"qwen3.8-27b-awq-4bit":{"i":"it"},"qwen3.8-27b-awq-bf16-int4":{"i":"it"},"qwen3.8-27b-awq-int4":{"i":"it"},"qwen3.8-27b-awq-mtp":{"i":"it"},"qwen3.8-27b-bf16":{"i":"it"},"qwen3.8-27b-bf16-int4-w4a16-g32-autoround":{"i":"it"},"qwen3.8-27b-cold-fusion-gain-v1.1-nm-dau-neo-max-mtp-gguf":{"i":"it"},"qwen3.8-27b-fable":{"i":"it","t":1,"r":1},"qwen3.8-27b-fable-distill-gguf":{"i":"it"},"qwen3.8-27b-fp8":{"i":"it","t":1,"r":1},"qwen3.8-27b-gguf":{"i":"it"},"qwen3.8-27b-gptq-4bit":{"i":"it"},"qwen3.8-27b-gptq-int4":{"i":"it"},"qwen3.8-27b-gptq-int4-fp8kv":{"i":"it"},"qwen3.8-27b-gptq-int8-mtp":{"i":"it"},"qwen3.8-27b-gptq-w4a16":{"i":"it"},"qwen3.8-27b-gsq-rco-gguf":{"i":"it"},"qwen3.8-27b-gsq-rco-iq3_xxs-uncensored":{"i":"it"},"qwen3.8-27b-heretic-ara":{"i":"it"},"qwen3.8-27b-heretic-ara-int8-w8a16-mtp":{"i":"it"},"qwen3.8-27b-heretic-ara-q4_k_m-mtp-gguf":{"i":"it"},"qwen3.8-27b-huihui-abliterated-nvfp4-ninfer":{"i":"it"},"qwen3.8-27b-i1-iq4_ks_kt-gguf":{"i":"it"},"qwen3.8-27b-imatrix-nvfp4-mtp-gguf":{"i":"it"},"qwen3.8-27b-int4":{"i":"it"},"qwen3.8-27b-int4-autoround":{"i":"it"},"qwen3.8-27b-int8-w8a16-dflash2":{"i":"it"},"qwen3.8-27b-int8-w8a16-mtp":{"i":"it"},"qwen3.8-27b-mixedint4-autoround":{"i":"it"},"qwen3.8-27b-mlx-4bit":{"i":"it"},"qwen3.8-27b-mlx-5bit":{"i":"it"},"qwen3.8-27b-mlx-6bit":{"i":"it"},"qwen3.8-27b-mlx-8bit":{"i":"it"},"qwen3.8-27b-mtp-gguf":{"i":"it"},"qwen3.8-27b-ninfer":{"i":"it"},"qwen3.8-27b-nvfp4":{"i":"it","t":1,"r":1},"qwen3.8-27b-nvfp4-bf16-lmhead":{"i":"it"},"qwen3.8-27b-nvfp4-mtp-q8attn-gguf":{"i":"it"},"qwen3.8-27b-nvfp4-ninfer":{"i":"it"},"qwen3.8-27b-nvfp4-rtx5090":{"i":"it"},"qwen3.8-27b-nvfp4-rtx5090-lmhead4":{"i":"it"},"qwen3.8-27b-obliterated":{"i":"it","t":1,"r":1},"qwen3.8-27b-obliterated:thinking":{"i":"it","t":1,"r":1},"qwen3.8-27b-omnimerge-v6-mtp-gguf":{"i":"it"},"qwen3.8-27b-optiq-4bit":{"i":"it"},"qwen3.8-27b-prismaaqua-5.5bit-vllm":{"i":"it"},"qwen3.8-27b-q3_k_l-gguf":{"i":"it"},"qwen3.8-27b-q3_k_m-gguf":{"i":"it"},"qwen3.8-27b-q4_k_m-gguf":{"i":"it"},"qwen3.8-27b-quark-awq-int4-w4a16":{"i":"it"},"qwen3.8-27b-quark-awq-mxfp4":{"i":"it"},"qwen3.8-27b-quasar-nvfp4":{"i":"it"},"qwen3.8-27b-queen":{"i":"it","t":1,"r":1},"qwen3.8-27b-ridge-gguf":{"i":"it"},"qwen3.8-27b-rocmi4-mtp-gguf":{"i":"it"},"qwen3.8-27b-tee":{"i":"it","t":1,"r":1},"qwen3.8-27b-turbo-fable-cold-fusion-735-882-heretic-uncensored-gguf-ultraoptimised-dspark-mtp":{"i":"it"},"qwen3.8-27b-turbo-fable-cold-fusion-735-882-heretic-uncensored-neo-coder-max-mtp-gguf":{"i":"it"},"qwen3.8-27b-turbo-fable-cold-fusion-735-882-heretic-uncensored-nm-dau-mxfp4-1m":{"i":"it"},"qwen3.8-27b-turbo-fable-cold-fusion-735-882-heretic-uncensored-nm-dau-nvfp4":{"i":"it"},"qwen3.8-27b-turbo-fable-cold-fusion-735-882-heretic-uncensored-nm-dau-nvfp4-1m":{"i":"it"},"qwen3.8-27b-twin-turbo-fable-cold-fusion-709-l-uncensored-nm-dau-neo-mtp-gguf":{"i":"it"},"qwen3.8-27b-ultra-uncensored-heretic-native-mtp-preserved-gguf":{"i":"it"},"qwen3.8-27b-ultra-uncensored-heretic-native-mtp-preserved-nvfp4-gguf":{"i":"it"},"qwen3.8-27b-uncensored":{"i":"it","t":1,"r":1},"qwen3.8-27b-uncensored-aggressive":{"i":"it"},"qwen3.8-27b-uncensored-aggressive-w4a16-awq":{"i":"it"},"qwen3.8-27b-uncensored-cyber-gguf":{"i":"it"},"qwen3.8-27b-uncensored-fp8":{"i":"it"},"qwen3.8-27b-uncensored-fp8-q4_k_m-gguf":{"i":"it"},"qwen3.8-27b-uncensored-gguf":{"i":"it"},"qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp-gguf":{"i":"it"},"qwen3.8-27b-uncensored-joyfox-aggressive":{"i":"it"},"qwen3.8-27b-uncensored-mlx":{"i":"it"},"qwen3.8-27b-uncensored-nvfp4":{"i":"it"},"qwen3.8-27b-uncensored-nvfp4-modelopt":{"i":"it"},"qwen3.8-27b-uncensored-nvfp4-rtx5090":{"i":"it"},"qwen3.8-27b-uncensored-orcarouter-gguf":{"i":"it"},"qwen3.8-27b-uncensored-orcarouter-mlx-4bit":{"i":"it"},"qwen3.8-27b-uncensored-orcarouter-mlx-8bit":{"i":"it"},"qwen3.8-27b-uncensored-q8_0-gguf":{"i":"it"},"qwen3.8-27b-uncensored-w4a16-autoround":{"i":"it"},"qwen3.8-27b-uncensored:thinking":{"i":"it","t":1,"r":1},"qwen3.8-27b-w4a16-autoround":{"i":"it"},"qwen3.8-27b-w4a16-autoround-gptq":{"i":"it"},"qwen3.8-27b-w4a16-awq":{"i":"it"},"qwen3.8-27b-w4a16-awq-gptq":{"i":"it"},"qwen3.8-27b-whitehat-gguf":{"i":"it"},"qwen3.8-27b-zerorefusal-ud-iq4_xs-mtp-gguf":{"i":"it"},"qwen3.8-27b:thinking":{"i":"itv","t":1,"r":1},"qwen3.8-9b-distill-fp8":{"i":"it"},"qwen3.8-flash":{"i":"iptv","t":1,"r":1,"f":1},"qwen3.8-flash-ciru-strix-iu4":{"i":"it"},"qwen3.8-flash-next":{"i":"itv","t":1,"r":1},"qwen3.8-flash-next-ds4-iq2":{"i":"it"},"qwen3.8-flash-next-fp8":{"i":"it"},"qwen3.8-flash-next-gguf":{"i":"it"},"qwen3.8-flash-next-gsq-rco-gguf":{"i":"it"},"qwen3.8-flash-next-mixed-quant-ssd-ple-gguf":{"i":"it"},"qwen3.8-flash-next-mlx-4bit":{"i":"it"},"qwen3.8-flash-next-mlx-mixed-2bit":{"i":"it"},"qwen3.8-flash-next-mlx-oq4-mtp":{"i":"it"},"qwen3.8-flash-next-nvfp4":{"i":"it"},"qwen3.8-flash-next-reap-288-mlx-4bit":{"i":"it"},"qwen3.8-flash-next-uncensored-fp8":{"i":"it"},"qwen3.8-flash-next-uncensored-gguf":{"i":"it"},"qwen3.8-flash-next-uncensored-mlx-serve-4bit":{"i":"it"},"qwen3.8-flash-next-uncensored-nvfp4":{"i":"it"},"qwen3.8-flash-next-w4a16":{"i":"it"},"qwen3.8-flash-next-w4a16-autoround":{"i":"it"},"qwen3.8-flash-next@eu":{"i":"itv","t":1,"r":1},"qwen3.8-max":{"i":"iptv","t":1,"r":1,"f":1},"qwen3.8-max-0902":{"i":"iptv","t":1,"r":1},"qwen3.8-max-preview":{"i":"itv","t":1,"r":1,"f":1},"qwen3.8-max:thinking":{"i":"iptv","t":1,"r":1},"qwen35-122b-a10b":{"t":1,"r":1},"qwen35-397b-a17b":{"i":"aitv","t":1,"r":1},"qwen3guard-gen-0.6b":{"f":1},"qwen3guard-gen-8b":{"f":1},"qwen3p7-plus":{"i":"it","t":1,"r":1},"qwen3p8-2p4t-a95b":{"t":1,"r":1},"qwen3p8-max":{"i":"it","t":1,"r":1},"qwen3vl-resume-parser":{"i":"it"},"qwopus3.5-9b-coder-gguf":{"i":"it"},"qwopus3.5-9b-coder-mtp-gguf":{"i":"it"},"qwopus3.6-27b-coder-compat-mtp-gguf":{"i":"it"},"qwopus3.6-27b-coder-mtp-gguf":{"i":"it"},"qwopus3.6-27b-coder-nvfp4":{"i":"it"},"qwopus3.6-27b-v1-preview-gguf":{"i":"it"},"qwopus3.6-27b-v2-mtp-gguf":{"i":"it"},"qwopus3.6-35b-a3b-coder-mtp-gguf":{"i":"it"},"qwopus3.6-35b-a3b-v1-gguf":{"i":"it"},"qwopus3.8-27b-flash-gguf":{"i":"it"},"qwq-32b":{"t":1,"r":1},"qwq-plus":{"t":1,"r":1},"qwythos-27b-v1-gguf":{"i":"it"},"qwythos-9b-claude-mythos-5-1m-gguf":{"i":"it"},"qwythos-9b-v2-gguf":{"i":"it"},"r-4b":{"i":"it"},"radialog-interactive-radiology-report-generation":{"i":"it"},"rax-4.5":{"i":"it"},"ray2":{"i":"it","t":1},"react-native-executorch-lfm-2.5":{"i":"it"},"reka-edge":{"i":"itv","t":1},"reka-flash-3":{"r":1},"relace-search":{"t":1},"remm-slerp-l2-13b":{"i":"pt"},"rerank-qa-mistral-4b":{"f":1},"ring-1t":{"t":1,"r":1},"ring-2.6-1t":{"t":1,"r":1},"ring-2.6-1t-free":{"t":1,"r":1,"f":1},"riva-translate-4b-instruct-v1.1":{"f":1},"rldx-1-vlm":{"i":"it"},"rnj-1-instruct":{"t":1},"roc":{"i":"itv","t":1,"r":1},"route-llm":{"i":"it","t":1},"runway":{"i":"it","t":1},"runway-gen-4-turbo":{"i":"it","t":1},"sakana-namazu":{"i":"fipt","t":1,"r":1},"sap-abap-1":{"t":1},"sarvam-105b":{"t":1,"r":1},"sarvam-30b":{"t":1,"r":1},"sarvam-m":{"t":1,"f":1},"seed-1-6-250615":{"i":"it","t":1,"r":1},"seed-1-6-250915":{"i":"it","t":1,"r":1},"seed-1-6-flash-250715":{"i":"it","t":1,"r":1},"seed-1-8-251228":{"i":"it","t":1,"r":1},"seed-1.6":{"i":"itv","t":1,"r":1},"seed-1.6-flash":{"i":"itv","t":1,"r":1},"seed-1.8":{"i":"it","t":1,"r":1},"seed-2-0-code":{"i":"itv","t":1,"r":1},"seed-2-0-lite":{"i":"itv","t":1,"r":1},"seed-2-0-mini":{"i":"itv","t":1,"r":1},"seed-2-0-pro":{"i":"itv","t":1,"r":1},"seed-2-1-turbo":{"i":"itv","t":1,"r":1},"seed-2.0-code":{"i":"itv","t":1,"r":1},"seed-2.0-lite":{"i":"itv","t":1,"r":1},"seed-2.0-mini":{"i":"itv","t":1,"r":1},"seed-2.0-pro":{"i":"itv","t":1,"r":1},"seed-2.1-turbo":{"i":"it","t":1,"r":1},"seed-oss-36b-instruct":{"t":1,"f":1},"seedance-2":{"i":"it"},"seedance-2.0":{"i":"it"},"seedance-2.0-fast":{"i":"it"},"seedance-2.0-mini":{"i":"it"},"sensenova-6.8-flash-lite":{"i":"it","t":1,"r":1,"f":1},"shieldgemma-2-4b-it":{"i":"it"},"signal-3.8-27b-gguf":{"i":"it"},"skyfall-36b-v2":{"i":"pt"},"skywork-r1v-38b":{"i":"it"},"small":{"i":"it","t":1,"r":1},"smoldocling-256m-preview":{"i":"it"},"smollm3-3b-base":{"t":1,"r":1},"smolvlm-256m-instruct":{"i":"it"},"smolvlm-500m-instruct":{"i":"it"},"smolvlm-instruct":{"i":"it"},"smolvlm2-2.2b-instruct":{"i":"it"},"smolvlm2-256m-video-instruct":{"i":"it"},"smolvlm2-500m-video-instruct":{"i":"it"},"snowflake-llama3.3-70b":{"t":1},"solar-10.7b-instruct":{"t":1,"f":1},"solar-mini":{"t":1},"solar-pro-3":{"t":1,"r":1},"solar-pro2":{"t":1,"r":1},"solar-pro3":{"t":1,"r":1},"solar-pro4":{"t":1,"r":1},"solar-pro4:thinking":{"t":1,"r":1},"sonar":{"i":"it","t":1},"sonar-deep-research":{"r":1},"sonar-pro":{"i":"it","t":1},"sonar-pro-search":{"i":"it","r":1},"sonar-reasoning":{"r":1},"sonar-reasoning-pro":{"i":"it","r":1},"sora-2":{"i":"it","t":1},"sora-2-pro":{"i":"it","t":1},"sparsedrive":{"i":"v","f":1},"stablediffusionxl":{"i":"it","t":1},"standardcompute":{"i":"it","t":1,"r":1,"f":1},"step-1-32k":{"t":1},"step-2-16k":{"t":1},"step-3":{"i":"it","t":1,"r":1},"step-3-5-flash":{"t":1,"r":1},"step-3-5-flash-2603":{"t":1,"r":1},"step-3-7-flash":{"i":"itv","t":1,"r":1,"f":1},"step-3-7-flash:free":{"i":"itv","t":1,"r":1,"f":1},"step-3.5-flash":{"i":"it","t":1,"r":1,"f":1},"step-3.5-flash-2603":{"t":1,"r":1},"step-3.7-flash":{"i":"itv","t":1,"r":1,"f":1},"step-3.7-flash-free":{"i":"itv","t":1,"r":1,"f":1},"step-3.7-flash-gguf":{"i":"it"},"step-3.7-flash-nvfp4":{"i":"it"},"step-3.7-flash:free":{"i":"itv","t":1,"r":1,"f":1},"step-3.7-flash:thinking":{"i":"itv","t":1,"r":1},"step-router-v1":{"t":1},"step3":{"i":"it"},"step3-vl-10b":{"i":"it"},"stepaudio-2.5-asr":{"i":"a"},"streampetr":{"i":"v","f":1},"studiovoice":{"f":1},"sunflower-qwen-9b-medical-16bit":{"i":"it"},"superqwen3.8-27b-abliterated-gguf":{"i":"it"},"surya-ocr-2":{"i":"it"},"surya-ocr-2-gguf":{"i":"it"},"swift-qwen3.8-27b-gguf":{"i":"it"},"synth":{"i":"ipt","t":1,"r":1},"synth-code":{"i":"ipt","t":1,"r":1},"synthetic-video-detector":{"i":"v","f":1},"t5gemma-2-1b-1b":{"i":"it"},"t5gemma-2-270m-270m":{"i":"it"},"t5gemma-2-4b-4b":{"i":"it"},"tako":{"t":1},"tc-code-latest":{"t":1,"f":1},"teleocr":{"i":"it"},"tencent_ui-mate-27b-gguf":{"i":"it"},"tencent_ui-mate-9b-gguf":{"i":"it"},"tess-4-27b-gguf":{"i":"it"},"texify":{"i":"it"},"text-max":{"i":"it","t":1,"r":1},"text-prime":{"t":1,"r":1},"text-standard":{"t":1,"r":1},"thesby_qwen2.5-vl-7b-nsfw-caption-v3-gguf":{"i":"it"},"thinkingcap-qwen3.6-27b-nvfp4":{"i":"it"},"thomsonreuters_thomson-1.0-small-gguf":{"i":"it"},"tiel-coder-35b-a3b-genesis-hermes-gguf":{"i":"it"},"tiel-coder-35b-a3b-gguf":{"i":"it"},"tiel-coder-35b-a3b-gguf-mtp":{"i":"it"},"tim-qwen3.6-27b":{"t":1,"r":1},"tiny-diffusiongemmaforblockdiffusion":{"i":"it"},"tiny-gemma3forconditionalgeneration":{"i":"it"},"tiny-gemma4forconditionalgeneration":{"i":"it"},"tiny-idefics3forconditionalgeneration":{"i":"it"},"tiny-internvlforconditionalgeneration":{"i":"it"},"tiny-lfm2vlforconditionalgeneration-2.5":{"i":"it"},"tiny-llavaforconditionalgeneration":{"i":"it"},"tiny-llavanextforconditionalgeneration":{"i":"it"},"tiny-museglimmerforconditionalgeneration":{"i":"it"},"tiny-qwen2_5_vlforconditionalgeneration":{"i":"it"},"tiny-qwen2vlforconditionalgeneration":{"i":"it"},"tiny-qwen3_5forconditionalgeneration":{"i":"it"},"tiny-qwen3_5forconditionalgeneration-3.8":{"i":"it"},"tiny-qwen3_5forconditionalgeneration-nothink":{"i":"it"},"tiny-qwen3_5forconditionalgeneration-think":{"i":"it"},"tiny-qwen3_5moeforconditionalgeneration-3.6":{"i":"it"},"tiny-qwen3vlforconditionalgeneration":{"i":"it"},"tiny-random-gemma4-e2b":{"i":"it"},"tiny-random-idefics":{"i":"it"},"tiny-random-internvl2":{"i":"it"},"tiny-random-llava":{"i":"it"},"tiny-random-llava-next-mistral":{"i":"it"},"tiny-random-phi-4-multimodal":{"i":"it"},"tiny-random-visionencoderdecodermodel-donut":{"i":"it"},"topazlabs":{"t":1},"transcribe-1":{"i":"a"},"transcribe-1-free":{"i":"a"},"translategemma-12b-it":{"i":"it"},"translategemma-27b-it":{"i":"it"},"translategemma-4b-it":{"i":"it"},"trendyol-asure-12b":{"i":"it"},"trinity-large-preview-free":{"t":1,"f":1},"trinity-large-thinking":{"t":1,"r":1},"trinity-mini":{"t":1,"r":1},"typhoon-ocr-3b":{"i":"it"},"typhoon-ocr-7b":{"i":"it"},"typhoon-ocr1.5-2b":{"i":"it"},"udop-large":{"i":"it"},"ui-tars-1.5-7b":{"i":"it"},"ui-tars-1.5-7b-gguf":{"i":"it"},"ui-venus-1.5-2b":{"i":"it"},"ukisai_swift-qwen3.8-27b-gguf":{"i":"it"},"umans-coder":{"i":"it","t":1,"r":1,"f":1},"umans-deepseek-v4-flash-0731":{"t":1,"r":1,"f":1},"umans-deepseek-v4-pro-0813":{"t":1,"r":1,"f":1},"umans-flash":{"i":"it","t":1,"r":1,"f":1},"umans-glm-5.2":{"i":"it","t":1,"r":1,"f":1},"umans-kimi-k2.7":{"i":"itv","t":1,"r":1,"f":1},"umans-kimi-k3":{"i":"it","t":1,"r":1,"f":1},"umans-qwen3.6-35b-a3b":{"i":"it","t":1,"r":1,"f":1},"unlimited-ocr":{"i":"it"},"unlimited-ocr-awq":{"i":"it"},"unlimited-ocr-gguf":{"i":"it"},"unseen_gemma_4_26b_nsfw-gguf":{"i":"it"},"unslopnemo-12b":{"t":1},"unslopnemo-12b-v4.1":{"i":"pt"},"us-gov.openai.gpt-oss-120b-1:0":{"t":1,"r":1},"us-gov.openai.gpt-oss-20b-1:0":{"t":1,"r":1},"us.amazon.nova-2-lite-v1:0":{"i":"iptv","t":1,"r":1},"us.amazon.nova-lite-v1:0":{"i":"iptv","t":1},"us.amazon.nova-micro-v1:0":{"t":1},"us.amazon.nova-premier-v1:0":{"i":"iptv","t":1},"us.amazon.nova-pro-v1:0":{"i":"iptv","t":1},"us.anthropic.claude-fable-5":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-fable-5-1":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-haiku-4-5-20251001-v1:0":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-opus-4-1-20250805-v1:0":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-opus-4-5-20251101-v1:0":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-opus-4-6-v1":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-opus-4-7":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-opus-4-8":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-opus-5":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-sonnet-4-20250514-v1:0":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-sonnet-4-5-20250929-v1:0":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-sonnet-4-6":{"i":"ipt","t":1,"r":1},"us.anthropic.claude-sonnet-5":{"i":"ipt","t":1,"r":1},"us.deepseek.r1-v1:0":{"r":1},"us.meta.llama3-1-70b-instruct-v1:0":{"t":1},"us.meta.llama3-1-8b-instruct-v1:0":{"t":1},"us.meta.llama3-3-70b-instruct-v1:0":{"t":1},"us.meta.llama4-maverick-17b-instruct-v1:0":{"i":"it","t":1},"us.meta.llama4-scout-17b-instruct-v1:0":{"i":"it","t":1},"us.mistral.pixtral-large-2502-v1:0":{"i":"it","t":1},"us.openai.gpt-5.6-luna":{"i":"it","t":1,"r":1},"us.openai.gpt-5.6-sol":{"i":"it","t":1,"r":1},"us.openai.gpt-5.6-terra":{"i":"it","t":1,"r":1},"us.openai.gpt-6-astra":{"i":"it","t":1,"r":1},"us.writer.palmyra-x4-v1:0":{"t":1,"r":1},"us.writer.palmyra-x5-v1:0":{"t":1,"r":1},"us.xai.grok-4.6":{"i":"it","t":1,"r":1},"usdcode":{"f":1},"usdvalidate":{"f":1},"v0-1.0-md":{"i":"it","t":1,"r":1},"v0-1.5-lg":{"i":"it","t":1,"r":1},"v0-1.5-md":{"i":"it","t":1,"r":1},"venice-uncensored-1-2":{"i":"it","t":1},"venice-uncensored-role-play":{"i":"it","t":1},"veo-2":{"t":1},"veo-3":{"t":1},"veo-3-fast":{"t":1},"veo-3.1":{"t":1},"veo-3.1-fast":{"i":"it","t":1},"veo-3.1-fast-generate-preview":{"i":"itv"},"veo-3.1-generate-preview":{"i":"it"},"veo-3.1-lite-generate-preview":{"i":"it"},"veo3.1":{"i":"it"},"veo3.1-fast":{"i":"it"},"veo3.1-lite":{"i":"it"},"video-llava-7b-hf":{"i":"it"},"videollama3-2b-image-hf":{"i":"it"},"vip-llava-7b-hf":{"i":"it"},"vision-large":{"i":"aiptv","t":1,"r":1},"vision-medium":{"i":"aiptv","t":1,"r":1},"vision-small":{"i":"aiptv","t":1,"r":1},"vllm-translategemma-12b-it":{"i":"it"},"vllm-translategemma-27b-it":{"i":"it"},"vllm-translategemma-4b-it":{"i":"it"},"vlx-seek-1.5-10b":{"i":"it"},"voxtral-mini-3b":{"i":"a"},"voxtral-mini-latest":{"i":"a"},"voxtral-small-24b-2507":{"i":"afpt","t":1},"voxtral-small-2507":{"i":"at","t":1},"voxtral-small-latest":{"i":"at","t":1},"wan-v2-6":{"i":"it"},"wan-v3.0-video":{"i":"it"},"wan-v3.0-video-prime":{"i":"it"},"wan2.7-image":{"f":1},"wan2.7-image-pro":{"f":1},"whisper-1":{"i":"a"},"whisper-large-v3":{"i":"a","f":1},"whisper-large-v3-turbo":{"i":"a","f":1},"wizardlm-2-8x22b":{"i":"pt"},"writer.palmyra-x4-v1:0":{"t":1,"r":1},"writer.palmyra-x5-v1:0":{"t":1,"r":1},"x-preview-f-free":{"i":"itv","t":1,"r":1,"f":1},"xai.grok-4.3":{"i":"it","t":1,"r":1},"xai.grok-4.6":{"i":"it","t":1,"r":1},"xcuros1.2-8b-vlbf16-instruct":{"i":"it"},"xiaomi-mimo-v2-5":{"i":"aitv","t":1,"r":1},"xiaomi-mimo-v2.5":{"i":"aitv","t":1,"r":1},"xiaomi-mimo-v2.5-free":{"i":"aitv","t":1,"r":1,"f":1},"xiaomi-mimo-v2.5-pro":{"t":1,"r":1},"xiaomi-mimo-v2.5-pro-free":{"t":1,"r":1,"f":1},"xpersona-frieren-coder":{"i":"it","t":1,"r":1},"xpersona-gpt-5.5":{"i":"it","t":1,"r":1},"xyzailab_xyz-aquila-mini-gguf":{"i":"it"},"z-ai-glm-5-3":{"t":1,"r":1},"z-ai-glm-5-3-flash":{"i":"itv","t":1,"r":1},"z-ai-glm-5-turbo":{"t":1,"r":1},"z-ai-glm-5v-turbo":{"i":"it","t":1,"r":1},"zai-glm-5-1":{"t":1},"zai-glm-5-2":{"t":1,"r":1},"zai-glm-5.1":{"t":1,"r":1},"zai-org-glm-4.6":{"t":1,"r":1},"zai-org-glm-4.7":{"t":1,"r":1},"zai-org-glm-4.7-flash":{"t":1,"r":1},"zai-org-glm-5":{"t":1,"r":1},"zai-org-glm-5-1":{"t":1,"r":1},"zai-org-glm-5-2":{"t":1,"r":1},"zai.glm-4.7":{"t":1,"r":1},"zai.glm-4.7-flash":{"t":1,"r":1},"zai.glm-4.7-flash@us":{"t":1,"r":1},"zai.glm-5":{"t":1,"r":1},"zdev":{"i":"it","t":1,"r":1,"f":1},"zdr":{"i":"ipt","t":1,"r":1}};
    // __MODEL_METADATA_END__
    // 构建期的 models.dev 快照查表：运行时纯本地、零网络、永不抛错——
    // 查不到就返回 null，让调用方继续走关键词兜底。
    const SNAPSHOT_MODALITY_NAMES = { t: 'text', i: 'image', a: 'audio', v: 'video', p: 'pdf', f: 'file' };
    // 运行时元数据补查：快照只随插件发布更新，新发布的模型会查不到。
    // 此时后台拉一次 OpenRouter 公开目录（单次请求、失败静默、6 小时节流），
    // 结果进内存 + localStorage（7 天 TTL），后续查表同步命中。
    const RUNTIME_META_KEY = 'dsh-model-picker-plus:runtime-meta';
    const RUNTIME_META_TTL_MS = 7 * 24 * 3600 * 1000;
    const RUNTIME_META_RETRY_MS = 6 * 3600 * 1000;
    const runtimeMeta = new Map();
    const mergeRuntimeMetadata = (entries) => {
      for (const [id, signal] of Object.entries(entries ?? {})) {
        if (signal && typeof signal === 'object') runtimeMeta.set(id, signal);
      }
    };
    // 启动时恢复持久化缓存（过期/损坏都静默丢弃）。
    try {
      const stored = JSON.parse(globalThis.localStorage?.getItem?.(RUNTIME_META_KEY) ?? 'null');
      if (stored && Date.now() - (stored.at ?? 0) < RUNTIME_META_TTL_MS) mergeRuntimeMetadata(stored.data);
    } catch { /* 缓存损坏静默丢弃 */ }

    let runtimeMetaFetching = false;
    // 把 OpenRouter 条目压成快照同款信号（模态码 / 工具 / 推理 / 免费）。
    const compressOpenRouterEntry = (model) => {
      const codes = new Set();
      for (const item of model?.architecture?.input_modalities ?? []) {
        const code = { text: 't', image: 'i', audio: 'a', video: 'v', pdf: 'p', file: 'f' }[String(item).toLowerCase()];
        if (code) codes.add(code);
      }
      const params = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
      const prompt = Number.parseFloat(String(model?.pricing?.prompt ?? 'NaN'));
      const completion = Number.parseFloat(String(model?.pricing?.completion ?? 'NaN'));
      const i = [...codes].sort().join('');
      const entry = {
        i: i && i !== 't' ? i : undefined,
        t: params.includes('tools') ? 1 : undefined,
        r: params.includes('include_reasoning') || params.includes('reasoning') ? 1 : undefined,
        f: Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0 ? 1 : undefined,
      };
      return (entry.i || entry.t || entry.r || entry.f) ? entry : null;
    };

    // 触发补查：仅当目录里存在“快照+缓存都不认识”的模型时才拉；
    // 有未知模型说明快照可能过时，一次拉取覆盖所有新模型。
    // 返回是否触发了拉取（完成回调由调用方用来刷新界面）。全程静默。
    function ensureRuntimeMetadata(groups, onUpdated, debugLog) {
      if (runtimeMetaFetching || !Array.isArray(groups) || groups.length === 0) return false;
      const hasUnknown = groups.some(group => (group?.models ?? []).some((model) => {
        const raw = String(model?.id ?? '').toLowerCase();
        if (!raw) return false;
        const bare = raw.split('/').pop();
        return ![raw, bare, bare.replace(/:free$/, ''), bare.replace(/-free$/, '')]
          .some(key => MODEL_METADATA[key] || runtimeMeta.has(key));
      }));
      if (!hasUnknown) return false;
      let attemptedAt = 0;
      try {
        attemptedAt = JSON.parse(globalThis.localStorage?.getItem?.(RUNTIME_META_KEY) ?? 'null')?.attemptedAt ?? 0;
      } catch { /* 忽略损坏缓存 */ }
      if (Date.now() - attemptedAt < RUNTIME_META_RETRY_MS) return false;

      runtimeMetaFetching = true;
      const persistAttempt = (data) => {
        try {
          globalThis.localStorage?.setItem?.(RUNTIME_META_KEY, JSON.stringify({
            at: Date.now(), attemptedAt: Date.now(), data: data ?? {},
          }));
        } catch { /* 存储失败静默 */ }
      };
      fetch('https://openrouter.ai/api/v1/models')
        .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((payload) => {
          const entries = {};
          for (const model of payload?.data ?? []) {
            const bare = String(model?.id ?? '').split('/').pop().toLowerCase();
            const signal = compressOpenRouterEntry(model);
            if (bare && signal) {
              const prev = entries[bare] ?? {};
              entries[bare] = {
                i: prev.i || signal.i ? [...new Set(`${prev.i ?? ''}${signal.i ?? ''}`)].sort().join('') || undefined : undefined,
                t: prev.t || signal.t ? 1 : undefined,
                r: prev.r || signal.r ? 1 : undefined,
                f: prev.f || signal.f ? 1 : undefined,
              };
            }
          }
          mergeRuntimeMetadata(entries);
          persistAttempt(entries);
          debugLog?.(`运行时补查完成：${Object.keys(entries).length} 个模型入库`);
          onUpdated?.();
        })
        .catch((error) => {
          // 失败也记录尝试时间（节流），但不写数据；下个好网络再来。
          persistAttempt(null);
          debugLog?.(`运行时补查失败（静默）：${error?.message ?? error}`);
        })
        .finally(() => { runtimeMetaFetching = false; });
      return true;
    }

    function lookupModelMetadata(model) {
      const raw = String(model?.id ?? '').toLowerCase();
      if (!raw) return null;
      const bare = raw.split('/').pop();
      const candidates = [raw, bare, bare.replace(/:free$/, ''), bare.replace(/-free$/, '')];
      for (const key of candidates) {
        const hit = MODEL_METADATA[key] ?? runtimeMeta.get(key);
        if (hit) return hit;
      }
      return null;
    }
    const snapshotInputModalities = model => (lookupModelMetadata(model)?.i ?? '').split('')
      .map(code => SNAPSHOT_MODALITY_NAMES[code]).filter(Boolean);

    // 模态结构化声明：各家 endpoint “方言”都认——
    // modalities.input（model-hub/models.dev 形态）、input（pi-ai 配置形态）、
    // input_modalities（商汤等网关直连形态），最后是构建期的 models.dev 快照。
    // 有声明信声明，没有才退回名字/描述关键词（治“自定义模型明明配了视觉却不显示”）。
    function declaredInputModalities(model) {
      const fromObject = Array.isArray(model?.modalities?.input) ? model.modalities.input : null;
      const fromArray = Array.isArray(model?.input) ? model.input : null;
      const fromEndpoint = Array.isArray(model?.input_modalities) ? model.input_modalities : null;
      const fromSnapshot = snapshotInputModalities(model);
      const declared = fromObject ?? fromArray ?? fromEndpoint ?? (fromSnapshot.length > 0 ? fromSnapshot : null);
      return declared ? declared.map(item => String(item).toLowerCase()) : null;
    }

    // supported_features 数组（商汤等网关）：["tools","reasoning",...]。
    function supportedFeatures(model) {
      return Array.isArray(model?.supported_features) ? model.supported_features.map(item => String(item).toLowerCase()) : [];
    }

    function isVisionModel(group, model) {
      const declared = declaredInputModalities(model);
      if (declared) return declared.includes('image');
      return /vision|modlens|image/i.test(`${group.name} ${group.id} ${model.name} ${model.id} ${model.description ?? ''}`);
    }

    function isReasoningModel(model) {
      return model.reasoning !== undefined || model.thinking !== undefined
        || supportedFeatures(model).includes('reasoning')
        || lookupModelMetadata(model)?.r === 1
        || /reasoning|efforts?:/i.test(String(model.description ?? ''));
    }

    function hasToolsModel(model) {
      return model.tools === true || model.tool_call === true || model.function_calling === true
        || supportedFeatures(model).includes('tools')
        || lookupModelMetadata(model)?.t === 1
        || /(?:^|\W)tools?(?:\W|$)|tool_call|function calling/i.test(String(model.description ?? ''));
    }

    function isOmniModel(model) {
      const declared = declaredInputModalities(model);
      if (declared) return declared.some(item => item !== 'text' && item !== 'image');
      return /audio|video|omni|multimodal/i.test(String(model.description ?? ''));
    }

    // 免费判定分档：endpoint 给的 pricing 对象是最硬的证据（商汤等网关
    // 直接返回全零价目），有就信它——全零免费、有非零即付费；
    // 没有定价数据时退回两条约定：① free- 前缀厂家（model-hub 注册约定）、
    // ② OpenRouter 的 :free 免费变体后缀。约定层的边界（混合计费误标）依然存在。
    function pricingDeclaresFree(model) {
      const pricing = model?.pricing;
      if (!pricing || typeof pricing !== 'object') return null;
      let sawNumber = false;
      let total = 0;
      for (const value of Object.values(pricing)) {
        const amount = Number.parseFloat(String(value));
        if (Number.isFinite(amount)) { sawNumber = true; total += amount; }
      }
      return sawNumber ? total === 0 : null;
    }

    function isFreeModel(group, model) {
      const priced = pricingDeclaresFree(model);
      if (priced !== null) return priced;
      // 快照的零价记录只用于“补免费证据”，不反向判付费——
      // 免费额度平台（free- 前缀）即使模型原价非零，对用户依然免费。
      if (lookupModelMetadata(model)?.f === 1) return true;
      return group.id.startsWith('free-') || /:free$/i.test(String(model.id ?? ''));
    }

    function matchesCapability(group, model, mode) {
      if (mode === 'free') return isFreeModel(group, model);
      if (mode === 'vision') return isVisionModel(group, model);
      if (mode === 'reasoning') return isReasoningModel(model);
      if (mode === 'tools') return hasToolsModel(model);
      return true;
    }

    function taskMatches(group, model, task) {
      if (task === 'vision') return isVisionModel(group, model);
      if (task === 'reasoning') return isReasoningModel(model);
      if (task === 'free') return isFreeModel(group, model);
      if (task === 'code') return hasToolsModel(model) || isReasoningModel(model);
      return true;
    }

    function recommendationReason(task, t) {
      return t({
        code: 'recommendationCode', vision: 'recommendationVision', reasoning: 'recommendationReasoning',
        fast: 'recommendationFast', free: 'recommendationFree',
      }[task] ?? 'recommendationFast');
    }

    // 推荐排序：「快速」按 当前 > 最近使用 > 名称 排（本插件不测速，
    // 没有真实延迟数据，不用猜测值糊弄排序）；其余任务按匹配度+来源权重。
    function recommendedRows(groups, current, recents, task, suppliedIndex) {
      const index = suppliedIndex ?? createModelIndex(groups);
      if (task === 'fast') {
        const recentOrder = new Map(recents.map((key, position) => [key, position]));
        const currentKey = current ? modelKey(current.provider, current.model) : null;
        const fastRows = index.rows.map(row => ({
          ...row,
          current: row.key === currentKey,
          recent: recentOrder.get(row.key) ?? Infinity,
        }));
        fastRows.sort((a, b) => Number(b.current) - Number(a.current)
          || a.recent - b.recent
          || modelLabel(a.model).localeCompare(modelLabel(b.model)));
        return fastRows.slice(0, 3).map((row, position) => ({ ...row, score: 1000 - position }));
      }

      const rows = [];
      const seen = new Set();
      const add = (choice, score) => {
        if (!choice) return;
        const matchesTask = task === 'vision' ? choice.vision
          : task === 'reasoning' ? choice.reasoning
            : task === 'free' ? choice.free
              : task === 'code' ? choice.tools || choice.reasoning
                : true;
        if (!matchesTask || seen.has(choice.key)) return;
        seen.add(choice.key);
        rows.push({ ...choice, score });
      };
      add(current ? index.byKey.get(modelKey(current.provider, current.model)) : null, 1000);
      rowsForKeys(index, recents).forEach(choice => add(choice, 700));
      index.rows.forEach(choice => add(choice, 100));
      return rows.sort((a, b) => b.score - a.score).slice(0, 3);
    }

    // 调色板：对齐 DSH 设计系统真实变量 --dsw-alias-*（body[data-ds-dark-theme] 切换），
    // 浅色/深色外观自动跟随；兜底值为深色（仅供变量缺失的独立环境）。
    // 注意：var() 不能再拼十六进制透明度（var(--x)18 是非法 CSS），
    // 需要透明色一律走 tint() 的 color-mix。
    const colors = {
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      muted: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
      border: 'var(--dsw-alias-border-l2, #333)',
      panel: 'var(--dsw-alias-bg-layer-1, #1c1c1c)',
      panel2: 'var(--dsw-alias-bg-layer-2, #242424)',
      accent: 'var(--dsw-alias-brand-primary, #4c8bf5)',
      accentFg: 'var(--dsw-alias-label-primary-inverted, #fff)',
      danger: 'var(--dsw-alias-state-error-primary, #e05252)',
      ok: 'var(--dsw-alias-state-success-primary, #3fa95b)',
      hoverBg: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.05))',
    };
    // 主题色的透明版本（color-mix 对 var() 同样有效）。
    const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

    // 能力图标：内联 SVG（非 emoji，可随文字色主题化）。
    // 语义对齐 OpenRouter / Cherry Studio 惯例：礼物盒=免费、图片=视觉、
    // 大脑=推理、扳手=工具、四格=全部。
    const CAP_ICON_SHAPES = {
      all: [['rect', { x: 2, y: 2, width: 5, height: 5, rx: 1.2 }], ['rect', { x: 9, y: 2, width: 5, height: 5, rx: 1.2 }], ['rect', { x: 2, y: 9, width: 5, height: 5, rx: 1.2 }], ['rect', { x: 9, y: 9, width: 5, height: 5, rx: 1.2 }]],
      free: [['rect', { x: 2.5, y: 6.5, width: 11, height: 7, rx: 1 }], ['path', { d: 'M2.5 9h11M8 6.5v7M8 6.5s-2.6.2-3.6-1.2c-.7-1 0-2.3 1.2-2.3C7.2 3 8 6.5 8 6.5zm0 0s2.6.2 3.6-1.2c.7-1 0-2.3-1.2-2.3C8.8 3 8 6.5 8 6.5z' }]],
      vision: [['rect', { x: 1.8, y: 3, width: 12.4, height: 10, rx: 1.5 }], ['circle', { cx: 5.4, cy: 6.4, r: 1.2 }], ['path', { d: 'M2.5 12l3.2-3.2 2.3 2.3 3-3 3.2 3.2' }]],
      reason: [['path', { d: 'M6 2.5a2.6 2.6 0 0 0-2.6 2.6c0 .4.1.8.3 1.1A2.7 2.7 0 0 0 2.5 8.7c0 1 .6 1.9 1.5 2.3.9 1.7 2.4 2.5 4 2.5V2.5zM10 2.5a2.6 2.6 0 0 1 2.6 2.6c0 .4-.1.8-.3 1.1a2.7 2.7 0 0 1 1.2 2.5c0 1-.6 1.9-1.5 2.3-.9 1.7-2.4 2.5-4 2.5' }]],
      tools: [['path', { d: 'M9.6 2.2a3.4 3.4 0 0 0-4.4 4.4L2 9.8a1.5 1.5 0 0 0 0 2.1l2.1 2.1a1.5 1.5 0 0 0 2.1 0l3.2-3.2a3.4 3.4 0 0 0 4.4-4.4l-2 2-2.4-.7-.7-2.4 2-2z' }]],
    };
    const CapIcon = memo(function CapIcon({ name, size = 12 }) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
      }, (CAP_ICON_SHAPES[name] ?? []).map(([tag, attrs], index) => React.createElement(tag, { key: index, ...attrs })));
    });

    // 能力标记：图标 + 中文小字的紧凑胶囊（比纯文字胶囊窄，且不用猜图标）。
    const CAP_TONES = {
      free: ['#4ecb71', 'rgba(52,199,89,.12)'],
      vision: ['#cb8ef5', 'rgba(191,90,242,.13)'],
      reason: ['#7fb0f7', 'rgba(76,139,245,.13)'],
      tools: ['#f0b45a', 'rgba(255,159,10,.12)'],
      omni: ['#35c2c1', 'rgba(53,194,193,.12)'],
    };
    const CapPill = memo(function CapPill({ cap, label }) {
      const [fg, bg] = CAP_TONES[cap] ?? [colors.accent, tint(colors.accent, 13)];
      return React.createElement('span', {
        title: label,
        style: {
          flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px', height: '20px',
          padding: '0 6px', borderRadius: '6px', fontSize: '10px', lineHeight: 1, color: fg, background: bg,
        },
      }, cap !== 'omni' ? React.createElement(CapIcon, { name: cap }) : null, label);
    });

    // 厂家徽章：名称首字母 + 由 provider id 哈希出的稳定色相，
    // 让各来源在列表里一眼可辨（治“整页一个色”）。
    const providerHue = (id) => {
      let hash = 0;
      for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 360;
      return hash;
    };
    // 品牌图标（simple-icons，CC0）：viewBox 24 的单路径字形。
    // 匹配优先级：先按模型（平台型厂家里每个模型各有归属），再按厂家，最后字母兜底。
    const BRAND_ICON_PATHS = {
      openai: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
      nvidia: 'M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z',
      deepseek: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45',
      openrouter: 'M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z',
      opencode: 'M22 24H2V0h20zM17 4.8H7v14.4h10z',
      kimi: 'M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441',
      meta: 'M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z',
      mistralai: 'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z',
      qwen: 'M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z',
      minimax: 'M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997',
      googlegemini: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
      bytedance: 'M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z',
      alibabacloud: 'M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z',
      anthropic: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
      perplexity: 'M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z',
      huggingface: 'M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624',
      ollama: 'M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z',
      replicate: 'M24 10.262v2.712h-9.518V24h-3.034V10.262zm0-5.131v2.717H8.755V24H5.722V5.131zM24 0v2.717H3.034V24H0V0z',
      vllm: 'm23.6 0-8.721 4.59L9.829 24h7.41zM9.83 24V5.142H.4Z',
      lmstudio: 'M14.025 0c3.492 0 5.237 0 6.571.68a6.24 6.24 0 0 1 2.725 2.724C24 4.738 24 6.484 24 9.975v4.05c0 3.492 0 5.237-.68 6.571a6.24 6.24 0 0 1-2.724 2.725c-1.334.679-3.08.679-6.571.679h-4.05c-3.492 0-5.237 0-6.571-.68A6.24 6.24 0 0 1 .68 20.597C0 19.262 0 17.516 0 14.025v-4.05c0-3.492 0-5.237.68-6.571A6.23 6.23 0 0 1 3.404.68C4.738 0 6.484 0 9.975 0zM7.688 16.313a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625zm-3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm-3-3.75a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625z',
      deepmind: 'm5.99,1.62a8.54,8.54 0 0 0 -2.54,6.83c0.35,4.4 4.51,7.99 8.28,7.99c3.5,0 4.88,-3.06 4.54,-5.14a4.32,4.32 0 0 0 -0.95,-2.07c0.63,0.34 1.24,0.77 1.81,1.3c1.52,1.41 2.44,3.23 2.58,5.1c0.33,4.13 -2.73,8.37 -7.85,8.37c-1.69,0 -3.48,-0.43 -4.98,-1.14c-4.06,-1.92 -6.88,-6.06 -6.88,-10.86c0,-4.43 2.41,-8.3 5.99,-10.38zm6.15,-1.62c1.69,0 3.48,0.43 4.98,1.14a12,12 0 0 1 6.88,10.86c0,4.43 -2.41,8.3 -5.99,10.38a8.54,8.54 0 0 0 2.54,-6.83c-0.35,-4.4 -4.51,-7.99 -8.28,-7.99c-3.5,0 -4.88,3.06 -4.54,5.14a4.3,4.3 0 0 0 0.96,2.07a8.72,8.72 0 0 1 -1.81,-1.3c-1.52,-1.41 -2.44,-3.23 -2.59,-5.1c-0.33,-4.13 2.73,-8.37 7.85,-8.37z',
      baidu: 'M9.154 0C7.71 0 6.54 1.658 6.54 3.707c0 2.051 1.171 3.71 2.615 3.71 1.446 0 2.614-1.659 2.614-3.71C11.768 1.658 10.6 0 9.154 0zm7.025.594C14.86.58 13.347 2.589 13.2 3.927c-.187 1.745.25 3.487 2.179 3.735 1.933.25 3.175-1.806 3.422-3.364.252-1.555-.995-3.364-2.362-3.674a1.218 1.218 0 0 0-.261-.03zM3.582 5.535a2.811 2.811 0 0 0-.156.008c-2.118.19-2.428 3.24-2.428 3.24-.287 1.41.686 4.425 3.297 3.864 2.617-.561 2.262-3.68 2.183-4.362-.125-1.018-1.292-2.773-2.896-2.75zm16.534 1.753c-2.308 0-2.617 2.119-2.617 3.616 0 1.43.121 3.425 2.988 3.362 2.867-.063 2.553-3.238 2.553-3.988 0-.745-.62-2.99-2.924-2.99zm-8.264 2.478c-1.424.014-2.708.925-3.323 1.947-1.118 1.868-2.863 3.05-3.112 3.363-.25.309-3.61 2.116-2.864 5.42.746 3.301 3.365 3.237 3.365 3.237s1.93.19 4.171-.31c2.24-.495 4.17.123 4.17.123s5.233 1.748 6.665-1.616c1.43-3.364-.808-5.109-.808-5.109s-2.99-2.306-4.736-4.798c-1.072-1.665-2.348-2.268-3.528-2.257zm-2.234 3.84l1.542.024v8.197H7.758c-1.47-.291-2.055-1.292-2.13-1.462-.072-.173-.488-.976-.268-2.343.635-2.049 2.447-2.196 2.447-2.196h1.81zm3.964 2.39v3.881c.096.413.612.488.612.488h1.614v-4.343h1.689v5.782h-3.915c-1.517-.39-1.59-1.465-1.59-1.465v-4.317zm-5.458 1.147c-.66.197-.978.708-1.05.928-.076.22-.247.78-.1 1.269.294 1.095 1.248 1.144 1.248 1.144h1.37v-3.34z',
      huawei: 'M3.67 6.14S1.82 7.91 1.72 9.78v.35c.08 1.51 1.22 2.4 1.22 2.4 1.83 1.79 6.26 4.04 7.3 4.55 0 0 .06.03.1-.01l.02-.04v-.04C7.52 10.8 3.67 6.14 3.67 6.14zM9.65 18.6c-.02-.08-.1-.08-.1-.08l-7.38.26c.8 1.43 2.15 2.53 3.56 2.2.96-.25 3.16-1.78 3.88-2.3.06-.05.04-.09.04-.09zm.08-.78C6.49 15.63.21 12.28.21 12.28c-.15.46-.2.9-.21 1.3v.07c0 1.07.4 1.82.4 1.82.8 1.69 2.34 2.2 2.34 2.2.7.3 1.4.31 1.4.31.12.02 4.4 0 5.54 0 .05 0 .08-.05.08-.05v-.06c0-.03-.03-.05-.03-.05zM9.06 3.19a3.42 3.42 0 00-2.57 3.15v.41c.03.6.16 1.05.16 1.05.66 2.9 3.86 7.65 4.55 8.65.05.05.1.03.1.03a.1.1 0 00.06-.1c1.06-10.6-1.11-13.42-1.11-13.42-.32.02-1.19.23-1.19.23zm8.299 2.27s-.49-1.8-2.44-2.28c0 0-.57-.14-1.17-.22 0 0-2.18 2.81-1.12 13.43.01.07.06.08.06.08.07.03.1-.03.1-.03.72-1.03 3.9-5.76 4.55-8.64 0 0 .36-1.4.02-2.34zm-2.92 13.07s-.07 0-.09.05c0 0-.01.07.03.1.7.51 2.85 2 3.88 2.3 0 0 .16.05.43.06h.14c.69-.02 1.9-.37 3-2.26l-7.4-.25zm7.83-8.41c.14-2.06-1.94-3.97-1.94-3.98 0 0-3.85 4.66-6.67 10.8 0 0-.03.08.02.13l.04.01h.06c1.06-.53 5.46-2.77 7.28-4.54 0 0 1.15-.93 1.21-2.42zm1.52 2.14s-6.28 3.37-9.52 5.55c0 0-.05.04-.03.11 0 0 .03.06.07.06 1.16 0 5.56 0 5.67-.02 0 0 .57-.02 1.27-.29 0 0 1.56-.5 2.37-2.27 0 0 .73-1.45.17-3.14z',
      cloudflare: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727',
    };
    // __BRAND_LOGO_BEGIN__（由 scripts/update-brand-logos.mjs 生成于 2026-09-17，models.dev 官方标，请勿手改）
    const BRAND_LOGOS = {"deepseek":{"s":"<path d=\"M35.6638 9.91965C35.3251 9.75432 35.1785 10.0703 34.9811 10.2316C34.9131 10.2836 34.8558 10.3516 34.7985 10.413C34.3025 10.9423 33.7238 11.289 32.9678 11.2476C31.8625 11.1863 30.9186 11.533 30.0839 12.3783C29.9066 11.3356 29.3173 10.7143 28.4213 10.3143C27.9519 10.1063 27.4773 9.89965 27.148 9.44766C26.9186 9.12633 26.856 8.76767 26.7413 8.41568C26.668 8.20235 26.5946 7.98502 26.3506 7.94902C26.084 7.90769 25.98 8.13035 25.876 8.31702C25.4587 9.07967 25.2973 9.91965 25.3133 10.7703C25.3493 12.6849 26.1573 14.2102 27.764 15.2942C27.9466 15.4182 27.9933 15.5435 27.9359 15.7249C27.8266 16.0982 27.696 16.4609 27.5813 16.8355C27.508 17.0742 27.3986 17.1248 27.1426 17.0222C26.2777 16.6504 25.4919 16.1164 24.828 15.4489C23.6854 14.3449 22.6534 13.1263 21.3654 12.1716C21.067 11.9511 20.7606 11.7416 20.4468 11.5436C19.1335 10.2676 20.6201 9.21967 20.9641 9.09567C21.3241 8.965 21.0881 8.51968 19.9254 8.52501C18.7628 8.53035 17.6988 8.91834 16.3428 9.43699C16.1413 9.51421 15.934 9.57529 15.7229 9.61966C14.4557 9.38091 13.1598 9.33506 11.8789 9.48366C9.36565 9.76365 7.35902 10.953 5.88305 12.9809C4.10975 15.4182 3.69243 18.1888 4.20308 21.0768C4.74041 24.122 6.29504 26.6433 8.683 28.6139C11.1603 30.6579 14.0122 31.6592 17.2668 31.4672C19.2428 31.3539 21.4441 31.0886 23.9254 28.9873C24.552 29.2993 25.208 29.4233 26.2986 29.5166C27.1386 29.5953 27.9466 29.4766 28.5719 29.3459C29.5519 29.1379 29.4839 28.23 29.1306 28.0646C26.2573 26.726 26.888 27.2713 26.3133 26.83C27.7746 25.102 29.9746 23.3074 30.8359 17.4928C30.9026 17.0302 30.8452 16.7395 30.8359 16.3662C30.8306 16.1395 30.8826 16.0502 31.1426 16.0249C31.8639 15.95 32.5637 15.7349 33.2025 15.3915C35.0638 14.3742 35.8158 12.7049 35.9931 10.7023C36.0198 10.3956 35.9878 10.081 35.6638 9.91965ZM19.4414 27.9433C16.6562 25.754 15.3055 25.0327 14.7482 25.0634C14.2256 25.0954 14.3202 25.6913 14.4349 26.0807C14.5549 26.4647 14.7109 26.7286 14.9295 27.066C15.0815 27.2886 15.1855 27.6206 14.7789 27.87C13.8816 28.4246 12.3229 27.6833 12.2496 27.6473C10.435 26.578 8.91632 25.1673 7.84834 23.2381C6.81637 21.3808 6.21638 19.3888 6.11771 17.2622C6.09105 16.7475 6.24171 16.5662 6.7537 16.4729C7.42583 16.3442 8.11451 16.3267 8.79233 16.4209C11.6349 16.8368 14.0536 18.1075 16.0828 20.1194C17.2402 21.2661 18.1161 22.6354 19.0188 23.974C19.9788 25.3953 21.0108 26.75 22.3254 27.8593C22.7894 28.2486 23.1587 28.5446 23.5134 28.7619C22.4441 28.8819 20.6601 28.9086 19.4414 27.9433ZM20.7748 19.3568C20.7745 19.2906 20.7904 19.2253 20.8211 19.1666C20.8517 19.1078 20.8962 19.0575 20.9507 19.0198C21.0052 18.9821 21.068 18.9583 21.1337 18.9503C21.1995 18.9424 21.2662 18.9505 21.3281 18.9741C21.407 19.0024 21.475 19.0546 21.5228 19.1235C21.5706 19.1923 21.5958 19.2743 21.5947 19.3581C21.5949 19.4123 21.5843 19.4659 21.5636 19.5159C21.5428 19.5659 21.5123 19.6113 21.4738 19.6494C21.4354 19.6875 21.3897 19.7176 21.3395 19.7378C21.2893 19.7581 21.2356 19.7682 21.1814 19.7675C21.1277 19.7676 21.0745 19.7571 21.0248 19.7365C20.9752 19.7158 20.9302 19.6855 20.8925 19.6473C20.8548 19.609 20.825 19.5636 20.805 19.5138C20.785 19.4639 20.7739 19.4105 20.7748 19.3568ZM24.9213 21.4848C24.6547 21.5928 24.3893 21.6861 24.1347 21.6981C23.7516 21.7114 23.3756 21.5918 23.0707 21.3594C22.7054 21.0528 22.4441 20.8821 22.3347 20.3488C22.297 20.0881 22.3042 19.823 22.3561 19.5648C22.4494 19.1288 22.3454 18.8488 22.0374 18.5955C21.7881 18.3875 21.4694 18.3302 21.1201 18.3302C21.0005 18.3232 20.8843 18.2875 20.7814 18.2262C20.6348 18.1542 20.5148 17.9728 20.6294 17.7488C20.6668 17.6768 20.8428 17.5008 20.8854 17.4688C21.3601 17.1995 21.9081 17.2875 22.4134 17.4902C22.8827 17.6822 23.2374 18.0342 23.748 18.5328C24.2694 19.1341 24.364 19.3008 24.6613 19.7515C24.896 20.1048 25.1093 20.4674 25.2547 20.8821C25.344 21.1421 25.2293 21.3541 24.9213 21.4848Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"openai":{"s":"<path d=\"M32.8377 17.282C33.2127 16.25 33.3072 15.218 33.2127 14.1875C33.1197 13.1571 32.7447 12.1251 32.2752 11.1876C31.4322 9.78209 30.2127 8.6571 28.8072 8.0001C27.3072 7.34461 25.7127 7.15711 24.1197 7.53211C23.3698 6.78212 22.5253 6.12512 21.5878 5.65713C20.6503 5.18913 19.5253 5.00013 18.4948 5.00013C16.8851 4.99074 15.3125 5.48246 13.9948 6.40712C12.6824 7.34311 11.7449 8.6571 11.2754 10.1571C10.1504 10.4376 9.21289 10.9071 8.27539 11.4696C7.4324 12.1251 6.77541 12.9696 6.21291 13.8126C5.36992 15.2195 5.08792 16.8125 5.27542 18.407C5.46399 19.9968 6.11605 21.496 7.1504 22.718C6.79608 23.7086 6.66795 24.7659 6.77541 25.8124C6.86991 26.8444 7.2449 27.8749 7.7129 28.8124C8.55739 30.2194 9.77538 31.3444 11.1824 31.9999C12.6824 32.6569 14.2753 32.8444 15.8698 32.4694C16.6198 33.2194 17.4628 33.8749 18.4003 34.3444C19.3378 34.8139 20.4628 34.9999 21.4948 34.9999C23.1043 35.0097 24.6769 34.5185 25.9947 33.5944C27.3072 32.6569 28.2447 31.3444 28.7127 29.8444C29.7719 29.6432 30.7682 29.1934 31.6197 28.5319C32.4627 27.8749 33.2127 27.1249 33.6822 26.1874C34.5251 24.7819 34.8071 23.1875 34.6196 21.5945C34.4322 20 33.8697 18.5015 32.8377 17.282ZM21.5878 33.0304C20.0878 33.0304 18.9628 32.5609 17.9323 31.7179C17.9323 31.7179 18.0253 31.6234 18.1198 31.6234L24.1197 28.1554C24.2862 28.0803 24.4196 27.9469 24.4947 27.7804C24.5698 27.636 24.6021 27.4731 24.5877 27.3109V18.875L27.1197 20.375V27.3124C27.1455 28.0547 27.0215 28.7945 26.755 29.4878C26.4885 30.181 26.085 30.8134 25.5687 31.3473C25.0523 31.8811 24.4337 32.3054 23.7497 32.5949C23.0658 32.8843 22.3305 33.0314 21.5878 33.0304ZM9.49488 27.8749C8.83789 26.7499 8.55739 25.4374 8.83789 24.125C8.83789 24.125 8.93239 24.2195 9.02539 24.2195L15.0253 27.6874C15.1693 27.7638 15.3325 27.7966 15.4948 27.7819C15.6823 27.7819 15.8698 27.7819 15.9628 27.6874L23.2753 23.4695V26.3749L17.1823 29.9374C16.5506 30.3042 15.8527 30.5427 15.1287 30.6393C14.4046 30.7358 13.6686 30.6884 12.9629 30.4999C11.4629 30.1249 10.2449 29.1874 9.49488 27.8749ZM7.9004 14.8445C8.56239 13.7234 9.58826 12.8627 10.8074 12.4056V19.532C10.8074 19.718 10.8074 19.907 10.9004 20C10.9755 20.1665 11.1089 20.2998 11.2754 20.375L18.5878 24.5944L16.0573 26.0944L10.0574 22.625C9.41842 22.2639 8.85742 21.7797 8.40684 21.2004C7.95627 20.6211 7.62506 19.9582 7.4324 19.25C7.05741 17.8445 7.1504 16.157 7.9004 14.8445ZM28.6197 19.625L21.3073 15.407L23.8377 13.9071L29.8377 17.375C30.7752 17.9375 31.5252 18.6875 31.9947 19.625C32.4642 20.5625 32.7447 21.5945 32.6502 22.7195C32.5603 23.7755 32.1699 24.7837 31.5252 25.6249C30.8697 26.4694 30.0252 27.1249 28.9947 27.4999V20.375C28.9947 20.1875 28.9947 20 28.9002 19.907C28.9002 19.907 28.8072 19.718 28.6197 19.625ZM31.1502 15.875C31.1502 15.875 31.0572 15.782 30.9627 15.782L24.9627 12.3126C24.7752 12.2196 24.6822 12.2196 24.4947 12.2196C24.3072 12.2196 24.1197 12.2196 24.0252 12.3126L16.7128 16.532V13.6251L22.8073 10.0626C23.7448 9.50009 24.7752 9.31259 25.9002 9.31259C26.9322 9.31259 27.9627 9.68759 28.9002 10.3446C29.7447 11.0001 30.4947 11.8446 30.8697 12.7821C31.2447 13.7196 31.3377 14.8445 31.1502 15.875ZM15.4003 21.125L12.8699 19.625V12.5946C12.8699 11.5626 13.1503 10.4376 13.7128 9.59459C14.2753 8.6571 15.1198 8.0001 16.0573 7.53211C17.0127 7.05249 18.0956 6.88812 19.1503 7.06261C20.1823 7.15711 21.2128 7.62511 22.0573 8.2821C22.0573 8.2821 21.9628 8.3751 21.8698 8.3751L15.8698 11.8446C15.7033 11.9197 15.57 12.0531 15.4948 12.2196C15.4003 12.4071 15.4003 12.5001 15.4003 12.6876V21.125ZM16.7128 18.125L19.9948 16.25L23.2753 18.125V21.875L19.9948 23.75L16.7128 21.875V18.125Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"anthropic":{"s":"<path d=\"M26.9568 9.88184H22.1265L30.7753 31.7848H35.4917L26.9568 9.88184ZM13.028 9.88184L4.4917 31.7848H9.32203L11.2305 27.1793H20.2166L22.0126 31.6724H26.8444L18.0832 9.88184H13.028ZM12.5783 23.1361L15.4987 15.3853L18.5315 23.1361H12.5783Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"googlegemini":{"s":"<path d=\"M37 20.034C27.8809 20.5837 20.5808 27.8809 20.0326 37H19.966C19.4163 27.8809 12.1177 20.5837 3 20.034V19.9674C12.1191 19.4163 19.4163 12.1191 19.966 3H20.0326C20.5822 12.1191 27.8809 19.4163 37 19.9674V20.034Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"meta":{"s":"<path d=\"M27.1942 9.03509C24.4881 9.03509 22.3726 11.0731 20.4574 13.6623C17.8258 10.3114 15.6255 9.03509 12.9925 9.03509C7.62404 9.03509 3.51001 16.0234 3.51001 23.4181C3.51001 28.0453 5.74831 30.9649 9.49831 30.9649C12.1971 30.9649 14.1387 29.693 17.5904 23.6594C17.5904 23.6594 19.029 21.1199 20.0173 19.3699C20.3643 19.9293 20.7298 20.5327 21.1138 21.1798L22.7322 23.902C25.8843 29.1769 27.6416 30.9649 30.8229 30.9649C34.4778 30.9649 36.51 28.0058 36.51 23.2822C36.51 15.538 32.3039 9.03509 27.1942 9.03509ZM14.9574 22.0263C12.1606 26.4123 11.1928 27.3962 9.63574 27.3962C8.03194 27.3962 7.07872 25.9883 7.07872 23.4781C7.07872 18.1096 9.75562 12.6199 12.9471 12.6199C14.6752 12.6199 16.1197 13.617 18.3316 16.7836C16.2308 20.0058 14.9574 22.0263 14.9574 22.0263ZM25.5202 21.4751L23.5831 18.2456C23.0969 17.4514 22.5938 16.6676 22.0743 15.8947C23.8185 13.2032 25.2556 11.8611 26.9676 11.8611C30.5202 11.8611 33.3638 17.095 33.3638 23.5219C33.3638 25.9722 32.5612 27.3947 30.8989 27.3947C29.3053 27.3947 28.5451 26.3421 25.5188 21.4737\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"mistralai":{"s":"<path d=\"M8.92783 8.88101H13.357V13.3088H17.7861V17.738H17.7835H22.2152V13.3088H26.6418V8.88101H31.0722V26.5949H35.5V31.0241H22.2139V26.5962H17.7861V22.1671H13.3557V26.5949L17.7861 26.5962V31.0241H4.5V26.5949H8.92783V8.88101ZM22.2139 26.5962H26.6418V22.1671H22.2152V26.5962H22.2139Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"alibabacloud":{"s":"<path d=\"M37.9998 23.021C33.7998 25.2889 29.5698 27.3649 24.8614 28.3069C23.8114 28.5154 22.6474 28.5154 21.5809 28.3714C20.5639 28.2439 20.0554 27.3484 20.4169 26.4064C20.7619 25.5289 21.2209 24.635 21.8119 23.9C23.0899 22.3025 24.5329 20.849 25.8289 19.268C26.6203 18.2991 27.3335 17.2689 27.9618 16.187C28.4208 15.4205 28.2078 14.4935 27.4038 14.111C26.0584 13.4556 24.6154 12.9936 23.1889 12.4986C23.0239 12.4341 22.7779 12.6096 22.4509 12.7221C22.8604 13.0881 23.1559 13.3596 23.5654 13.727C19.3339 14.447 15.3305 15.467 11.4455 16.874C11.4275 16.9535 11.396 17.0165 11.411 17.0495C11.9855 17.927 11.723 18.5975 10.886 19.1405C10.5611 19.3531 10.2732 19.6176 10.034 19.9235C12.593 20.6735 14.873 20.243 17.0539 18.821C16.9234 18.6305 16.7914 18.455 16.6609 18.263C17.4799 18.407 17.9719 18.854 18.0379 19.556C18.0544 19.7165 17.9569 19.8755 17.9074 20.036C17.7919 19.907 17.6449 19.781 17.5474 19.6355C17.4799 19.5395 17.4634 19.4285 17.4154 19.268C14.8235 20.993 12.035 21.425 8.96751 20.531C8.96751 21.137 8.93451 21.6485 8.98401 22.1435C9.01701 22.574 8.83701 22.766 8.44401 22.9895C7.55752 23.5325 6.63803 24.092 5.90003 24.8105C5.01504 25.6879 5.34354 26.7589 6.54053 27.2059C7.90102 27.7159 9.329 27.7309 10.7555 27.5569C12.4445 27.3484 14.1005 27.0769 15.9394 26.8219C13.79 27.8269 11.6735 28.5319 9.4445 28.8169C7.88452 29.0269 6.32753 29.1379 4.78554 28.6909C2.57156 28.0684 1.58607 26.4394 2.16057 24.251C2.70206 22.2065 4.01455 20.5775 5.42454 19.076C10.133 14.078 16.0864 11.5401 22.9744 11.0286C24.5824 10.9176 26.2069 11.1246 27.7143 11.7951C29.8308 12.7536 30.7173 14.78 29.6838 16.826C29.0118 18.1835 28.0758 19.4285 27.1413 20.6585C26.2234 21.872 25.1899 22.9895 24.2224 24.155C23.9434 24.506 23.6809 24.875 23.4679 25.2724C23.0569 26.0224 23.3359 26.5174 24.2059 26.4394C26.0254 26.2624 27.8808 26.1199 29.6358 25.6729C32.2098 25.0174 34.7193 24.092 37.2618 23.2775C37.5243 23.213 37.7703 23.117 37.9998 23.0225V23.021Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"kimi":{"s":"<path d=\"M5.85893 26.3499L18.1801 29.6463C18.1635 30.5223 18.1894 31.3987 18.2576 32.2722L25.9507 34.3298C23.669 35.2716 21.1952 35.6547 18.7355 35.4471L18.503 35.4265L18.4462 35.4213L18.3377 35.4097L18.2163 35.3968C18.1486 35.3886 18.081 35.38 18.0135 35.3709L17.8753 35.3528L17.7332 35.3322C17.5951 35.3121 17.4573 35.2901 17.3198 35.2663L17.2656 35.256L17.1687 35.2392L17.0305 35.2133L16.9401 35.194L16.82 35.1694L16.7231 35.1488L16.6004 35.1229L16.4751 35.0932L16.3537 35.0648L16.2659 35.0428L16.1522 35.0144L16.0359 34.9834L15.9132 34.9511L15.8073 34.9214L15.6665 34.8827L15.5864 34.8568L15.4779 34.8245L15.3578 34.7884L15.2222 34.7445L15.1473 34.7199L15.0439 34.6863L14.9277 34.6463L14.8424 34.6153C14.8235 34.6089 14.8045 34.6025 14.7856 34.5959L14.6978 34.5636L14.5673 34.5158L14.4937 34.4874L14.3904 34.4487L14.278 34.4035L14.1643 34.3583L14.0623 34.3169L13.9396 34.2653L13.8582 34.2291L13.7768 34.1942C13.7591 34.1865 13.7415 34.1788 13.7239 34.171L13.6386 34.1322L13.5056 34.0715L13.4384 34.0405L13.3144 33.9811L13.2343 33.9423L13.1258 33.8907L13.0147 33.8338L12.8946 33.7731L12.8274 33.7383L12.6944 33.6672L12.6208 33.6285L12.5459 33.5871C12.526 33.576 12.5062 33.5648 12.4864 33.5536L12.365 33.4851L12.2875 33.4412L12.2217 33.4024L12.1287 33.3495L12.0227 33.2849L11.9026 33.2126L11.8354 33.1712L11.7269 33.1028L11.6482 33.0524L11.5461 32.9878L11.4557 32.9271L11.3872 32.8819C11.3639 32.8665 11.3407 32.851 11.3175 32.8354L11.2607 32.7966L11.2038 32.7579C11.1866 32.7459 11.1693 32.7338 11.1522 32.7217L11.0785 32.6701L10.9804 32.6003L10.8912 32.5357L10.7957 32.466L10.7233 32.4117L10.6252 32.3381L10.527 32.2619L10.4159 32.1753L10.3578 32.1301L10.2751 32.063L10.1795 31.9855L10.0646 31.8912L10.0052 31.8408L9.94575 31.7904C9.92717 31.7746 9.90866 31.7586 9.8902 31.7426L9.83208 31.691L9.75329 31.6225L9.66287 31.5424L9.57504 31.4649L9.49496 31.39L9.40841 31.3099L9.33996 31.2453L9.22629 31.1368C9.18345 31.0953 9.14082 31.0535 9.09842 31.0116L9.06096 30.9754L9.008 30.9211L8.91887 30.8307L8.85429 30.7648L8.78971 30.6964C8.71592 30.6207 8.64357 30.5436 8.57271 30.4652L8.46938 30.3515L8.38929 30.2611L8.29758 30.1578L8.24333 30.0945L8.17488 30.0144L8.09996 29.9266L8.04054 29.8542C8.02888 29.8401 8.01725 29.8258 8.00567 29.8116L7.94754 29.7406L7.86229 29.6346L7.80934 29.5675L7.74475 29.4848L7.71892 29.4525C6.97985 28.4945 6.3556 27.4532 5.85893 26.3499ZM4.54143 18.8661L19.2057 22.7888C18.9602 23.6439 18.758 24.5109 18.5999 25.3864L32.5718 29.1244C31.8777 30.0748 31.0782 30.9436 30.1887 31.7142L5.34872 25.0673L5.32805 25.0079L5.28284 24.8736C5.26087 24.8078 5.23934 24.742 5.21826 24.676L5.20922 24.6462C5.1098 24.3302 5.02063 24.011 4.94184 23.6891L4.90309 23.5264L4.87984 23.423L4.85272 23.2978L4.82947 23.1931L4.80622 23.0769L4.78426 22.9684L4.76101 22.847C4.72743 22.6648 4.69643 22.4814 4.6693 22.2967L4.64735 22.1443L4.63314 22.0371L4.61635 21.9053C4.6077 21.8361 4.59952 21.7668 4.5918 21.6974L4.58535 21.6367C4.48884 20.7162 4.47414 19.7891 4.54143 18.8661ZM6.59905 12.214L22.0318 16.3421C21.5565 17.1236 21.1212 17.9322 20.7273 18.764L35.3166 22.6674C35.1332 23.7266 34.8413 24.7496 34.4538 25.7222L19.5351 21.731L4.66026 17.7526L4.67964 17.6235L4.68997 17.5602L4.70289 17.4736L4.72226 17.3613L4.74551 17.2347C4.7791 17.0435 4.81785 16.8536 4.85918 16.6638L4.89534 16.5036L4.92118 16.3938L4.95218 16.2685C4.98059 16.1523 5.0103 16.036 5.04259 15.9224L5.07876 15.7906L5.10847 15.6834L5.14722 15.5542L5.17951 15.4483L5.21826 15.3243L5.25184 15.2184L5.29189 15.0957C5.62637 14.0924 6.06355 13.1262 6.59646 12.2127L6.59905 12.214ZM12.3366 6.53068L26.913 10.4289C26.1438 11.1271 25.4158 11.8693 24.7327 12.6519L34.8374 15.3553C35.1823 16.4558 35.4083 17.608 35.5 18.7976L7.22034 11.2336L7.27846 11.1497L7.31334 11.098L7.365 11.027L7.42442 10.943L7.49546 10.8448L7.56521 10.7518L7.64788 10.6407L7.71246 10.5568L7.78609 10.4625L7.85713 10.3721L7.93463 10.2765L8.00567 10.1874L8.08963 10.0879L8.15938 10.0027L8.24463 9.90321L8.31308 9.82571L8.40608 9.71979L8.47454 9.64229L8.56108 9.54671L8.63083 9.47179L8.72512 9.37104L8.80004 9.29354L8.88142 9.207L9.09842 8.98742L9.22758 8.86084L9.30379 8.7885L9.40196 8.69679C10.2922 7.86254 11.2771 7.13554 12.3366 6.53068ZM20.022 4.50018H20.1473L20.2532 4.50147L20.3423 4.50277L20.4121 4.50535L20.4999 4.50793L20.5593 4.50922L20.6575 4.5131L20.7182 4.51568L20.7957 4.51956L20.8655 4.52214L20.9778 4.5286L21.1135 4.53764L21.2995 4.55185L21.4131 4.56089L21.47 4.56606L21.5694 4.57639L21.6753 4.58672L21.736 4.59318L21.8678 4.60868L21.9324 4.61643L22.0719 4.63452L22.1765 4.64743L22.2308 4.65518L22.3147 4.6681L22.5821 4.70943L22.6725 4.72493L22.7565 4.73914L22.9373 4.77272L23.0561 4.79597L23.1982 4.82439L23.2576 4.83731L23.3545 4.85797L23.4075 4.87089L23.4875 4.88768L23.5418 4.9006L23.6257 4.91997L23.689 4.93547L23.7807 4.95743L23.9047 4.98843L24.0494 5.02718L24.1954 5.06593L24.3413 5.10726L24.4059 5.12664L24.4963 5.15247L24.5971 5.18347L24.6914 5.21318L24.756 5.23385L24.8205 5.25451L24.9187 5.28681L25.0466 5.32943L25.1783 5.37593L25.2403 5.39789L25.323 5.4276L25.4431 5.47151L25.5852 5.52447L25.735 5.5826L25.8642 5.63426L25.9249 5.6601L26.0024 5.6911L26.0554 5.71435L26.1367 5.74793L26.1884 5.77118L26.262 5.80347L26.4041 5.86547L26.5333 5.92489L26.6289 5.97009L26.7257 6.01659L26.8032 6.05276L26.9221 6.11218L27.0396 6.1703L27.1714 6.23747L27.2398 6.27364L27.3031 6.30722L27.3625 6.33822L27.44 6.38084L27.493 6.40926L27.5602 6.44672L27.6738 6.5113L27.8107 6.5888L27.9231 6.65468L27.9967 6.69859L28.0652 6.73993L28.1892 6.81613L28.3029 6.88718L28.4294 6.96726L28.4759 6.99826L28.5586 7.05122L28.6671 7.12355L28.7188 7.15842L28.7989 7.21267L28.8789 7.26822L28.9086 7.29017C28.9784 7.33797 29.0481 7.38705 29.1166 7.43742L29.2238 7.51492L29.3078 7.57692L29.3801 7.63246L29.4912 7.71642L29.5971 7.79909L29.6488 7.83784L29.7134 7.8908L29.8244 7.97992L29.9265 8.06388L30.0363 8.15559C30.9559 8.93059 31.7839 9.81279 32.5021 10.779L13.8285 5.7841L13.9086 5.74922L13.9925 5.71305L14.0971 5.66914L14.2082 5.62393C14.3542 5.5658 14.5014 5.50768 14.6487 5.45472L14.7727 5.40951L14.8928 5.36689L15.0013 5.32814L15.1253 5.2881C15.2377 5.24935 15.3526 5.21318 15.4663 5.17831L15.5839 5.14343L15.6949 5.11114L15.8267 5.07239L15.9365 5.04268L16.0656 5.0091L16.1767 4.9781L16.293 4.94839L16.4105 4.91997L16.5332 4.89156L16.6495 4.86572L16.7761 4.8386L16.8936 4.81276L17.0163 4.78951L17.1351 4.76627L17.2643 4.74302L17.3818 4.72235L17.5084 4.70039L17.6273 4.68231L17.7526 4.66293L17.8714 4.64614L18.0031 4.62935L18.1207 4.61385L18.2563 4.59835L18.3726 4.58543L18.5082 4.57252C18.6283 4.5596 18.7484 4.54927 18.8698 4.54152L19.0068 4.53118L19.123 4.52472L19.2651 4.51697L19.3852 4.51181L19.5144 4.50664L19.6397 4.50406L19.7675 4.50147L20.022 4.49889V4.50018Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"minimax":{"s":"<path d=\"M17.8758 9.20865C17.8758 8.59461 17.3777 8.09634 16.7663 8.09634C16.155 8.09634 15.6567 8.59575 15.6567 9.20865V27.6446C15.6567 29.0714 14.4985 30.2324 13.0755 30.2324C11.6523 30.2324 10.4941 29.0714 10.4941 27.6446V15.8167C10.4941 15.2027 9.99591 14.7044 9.38453 14.7044C8.77316 14.7044 8.275 15.2038 8.275 15.8167V20.8301C8.275 22.2567 7.11678 23.4179 5.69364 23.4179C4.2705 23.4179 3.1123 22.2567 3.1123 20.8301V19.0129C3.1123 18.6054 3.44177 18.2752 3.84822 18.2752C4.25467 18.2752 4.58413 18.6054 4.58413 19.0129V20.8301C4.58413 21.4441 5.08227 21.9424 5.69364 21.9424C6.30502 21.9424 6.80317 21.443 6.80317 20.8301V15.8167C6.80317 14.39 7.96139 13.2289 9.38453 13.2289C10.8077 13.2289 11.9659 14.39 11.9659 15.8167V27.6446C11.9659 28.2587 12.4641 28.7569 13.0755 28.7569C13.6868 28.7569 14.1849 28.2575 14.1849 27.6446V20.4123V9.20865C14.1849 7.78194 15.3431 6.62082 16.7663 6.62082C18.1894 6.62082 19.3476 7.78194 19.3476 9.20865V24.4746C19.3476 24.8821 19.0182 25.2123 18.6117 25.2123C18.2053 25.2123 17.8758 24.8821 17.8758 24.4746V9.20865ZM31.531 13.2289C30.1079 13.2289 28.9496 14.39 28.9496 15.8167V25.6969C28.9496 26.311 28.4515 26.8093 27.8401 26.8093C27.2287 26.8093 26.7306 26.3099 26.7306 25.6969V9.20865C26.7306 7.78194 25.5723 6.62082 24.1492 6.62082C22.7261 6.62082 21.5679 7.78194 21.5679 9.20865V30.1383C21.5679 30.7523 21.0697 31.2506 20.4583 31.2506C19.8469 31.2506 19.3488 30.7511 19.3488 30.1383V27.5471C19.3488 27.1396 19.0194 26.8093 18.6129 26.8093C18.2065 26.8093 17.877 27.1396 17.877 27.5471V30.1383C17.877 31.565 19.0352 32.7261 20.4583 32.7261C21.8815 32.7261 23.0397 31.565 23.0397 30.1383V9.20865C23.0397 8.59461 23.5378 8.09634 24.1492 8.09634C24.7605 8.09634 25.2587 8.59575 25.2587 9.20865V25.6969C25.2587 27.1237 26.417 28.2848 27.8401 28.2848C29.2632 28.2848 30.4215 27.1237 30.4215 25.6969V15.8167C30.4215 15.2027 30.9196 14.7044 31.531 14.7044C32.1424 14.7044 32.6405 15.2038 32.6405 15.8167V24.4746C32.6405 24.8821 32.97 25.2123 33.3764 25.2123C33.7829 25.2123 34.1123 24.8821 34.1123 24.4746V15.8167C34.1123 14.39 32.9541 13.2289 31.531 13.2289Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"nvidia":{"s":"<path d=\"M16.1801 15.8791V14.0283C16.3472 14.0155 16.5271 14.0026 16.7199 14.0026C21.7966 13.8356 25.1254 18.3596 25.1254 18.3596C25.1254 18.3596 21.5267 23.3463 17.671 23.3463C17.1569 23.3463 16.6557 23.2692 16.1801 23.1021V17.4728C18.1465 17.7298 18.545 18.591 19.7274 20.5702L22.375 18.3468C22.375 18.3468 20.4343 15.8277 17.1955 15.8277C16.8356 15.8277 16.5014 15.8405 16.1801 15.8791ZM16.1801 9.75492V12.5246C16.3472 12.5118 16.5271 12.4989 16.7199 12.4861C23.763 12.2547 28.377 18.2696 28.377 18.2696C28.377 18.2696 23.0819 24.683 17.5939 24.683C17.0798 24.683 16.6171 24.6444 16.1801 24.5545V26.2767C16.5528 26.3152 16.9384 26.341 17.3625 26.341C22.4649 26.341 26.1664 23.7448 29.7523 20.6473C30.3435 21.1229 32.7597 22.2796 33.261 22.7937C29.8679 25.6341 21.9251 27.9346 17.4396 27.9346C17.0155 27.9346 16.5914 27.9089 16.1801 27.8704V30.2866H35.6001V9.75492H16.1801ZM16.1801 23.1021V24.5545C11.4376 23.7191 10.1266 18.7966 10.1266 18.7966C10.1266 18.7966 12.4015 16.2775 16.1801 15.8791V17.4728H16.1673C14.188 17.2414 12.6329 19.0922 12.6329 19.0922C12.6329 19.0922 13.5068 22.2025 16.1801 23.1021ZM7.77464 18.591C7.77464 18.591 10.5765 14.4525 16.1801 14.0283V12.5246C9.9724 13.0259 4.6001 18.2696 4.6001 18.2696C4.6001 18.2696 7.64612 27.0735 16.1801 27.8575V26.2767C9.90814 25.4798 7.77464 18.591 7.77464 18.591Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"zhipu":{"s":"<path d=\"M20.1312 7.50002L17.4088 11.1913H5.81625L8.5375 7.50002H20.1325H20.1312ZM34.0675 28.81L31.3475 32.5H19.795L22.5125 28.81H34.0675ZM35 7.50002L16.58 32.5H5L23.42 7.50002H35Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"xai":{"s":"<path d=\"M12.4579 15.6036L26.1529 35H20.0656L6.37059 15.6036H12.4579ZM12.4524 26.3764L15.4974 30.6909L12.4551 35H6.36377L12.4524 26.3764ZM33.6365 7.15727V35H28.647V14.2236L33.6365 7.15727ZM33.6365 5L20.0656 24.2205L17.0206 19.9073L27.5451 5H33.6365Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"cohere":{"s":"<path d=\"M9.14882 13.5552C9.58082 13.5552 10.4448 13.5336 11.6544 13.0368C13.0584 12.4536 15.8232 11.4168 17.832 10.3368C19.236 9.5808 19.8408 8.5872 19.8408 7.248C19.8408 5.412 18.3504 3.9 16.4928 3.9H8.71682C6.06002 3.9 3.90002 6.06 3.90002 8.7168C3.90002 11.3736 5.93042 13.5552 9.14882 13.5552Z\" fill=\"currentColor\"/>\n<path d=\"M10.4664 16.86C10.4664 15.564 11.244 14.376 12.4536 13.8792L14.8944 12.864C17.3784 11.8488 20.1 13.6632 20.1 16.3416C20.1 18.4152 18.4152 20.1 16.3416 20.1H13.6848C11.9136 20.1 10.4664 18.6528 10.4664 16.86Z\" fill=\"currentColor\"/>\n<path d=\"M6.68642 14.1816C5.15282 14.1816 3.90002 15.4344 3.90002 16.968V17.3352C3.90002 18.8472 5.15282 20.1 6.68642 20.1C8.22003 20.1 9.47283 18.8472 9.47283 17.3136V16.9464C9.45123 15.4344 8.22003 14.1816 6.68642 14.1816Z\" fill=\"currentColor\"/>","vb":"0 0 24 24"},"groq":{"s":"<path d=\"M20.056 4.50022C14.0839 4.44597 9.20616 9.15015 9.15036 15.0106C9.09611 20.8726 13.8855 25.6621 19.8576 25.7163H23.6085V21.7391H20.056C16.3252 21.7825 13.2671 18.8468 13.2237 15.1827C13.1787 11.5216 16.1702 8.52086 19.901 8.47746H20.056C23.7868 8.47746 26.8108 11.4457 26.8216 15.1083V24.8809C26.8216 28.5109 23.8085 31.4683 20.1211 31.5132C18.3617 31.5007 16.6759 30.8049 15.42 29.5726L12.551 32.3905C14.5529 34.3571 17.239 35.4715 20.0451 35.4998H20.1877C26.0823 35.413 30.8175 30.7212 30.85 24.9351V14.8603C30.7059 9.0928 25.9165 4.50022 20.056 4.50022Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"sensenova":{"s":"<rect x=\"0.6\" y=\"0.6\" width=\"24.52\" height=\"24.52\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"/>\n  <path d=\"M6.365503787994385,6.430479049682617L6.365503787994385,6.860865049682618L12.731003787994386,13.291349049682617L12.731003787994386,12.862159049682617L13.157043787994386,12.862159049682617L6.791541787994385,6.430479049682617L6.365503787994385,6.430479049682617Z\"/>\n  <path d=\"M8.412155151367188,6.430479049682617L14.777655151367188,12.862159049682617L15.629735151367187,12.862159049682617L9.263037151367188,6.430479049682617L8.412155151367188,6.430479049682617Z\"/>\n  <path d=\"M10.883649826049805,6.430479049682617L17.250349826049806,12.862159049682617L18.101229826049803,12.862159049682617L11.735724826049804,6.430479049682617L10.883649826049805,6.430479049682617Z\"/>\n  <path d=\"M13.356339454650879,6.430479049682617L19.72183945465088,12.862159049682617L20.57272945465088,12.862159049682617L14.20722145465088,6.430479049682617L13.356339454650879,6.430479049682617Z\"/>\n  <path d=\"M15.829028129577637,6.430479049682617L22.194528129577638,12.862159049682617L23.045418129577637,12.862159049682617L16.679910129577635,6.430479049682617L15.829028129577637,6.430479049682617Z\"/>\n  <path d=\"M18.300525665283203,6.430479049682617L24.666025665283204,12.862159049682617L25.463205665283205,12.862159049682617L25.463205665283205,12.806709049682617L19.151406665283204,6.430479049682617L18.300525665283203,6.430479049682617Z\"/>\n  <path d=\"M20.77202033996582,6.430479049682617L25.46321033996582,11.169549049682617L25.46321033996582,10.309979049682617L21.62290233996582,6.430479049682617L20.77202033996582,6.430479049682617Z\"/>\n  <path d=\"M25.463209014892577,7.812059049682617L24.095591014892577,6.430479049682617L23.244709014892578,6.430479049682617L25.463209014892577,8.672829049682617L25.463209014892577,7.812059049682617Z\"/>\n  <path d=\"M6.365503787994385,24.341545462768554L7.733123787994385,25.723117462768556L8.584003787994385,25.723117462768556L6.365503787994385,23.481977462768555L6.365503787994385,24.341545462768554Z\"/>\n  <path d=\"M6.365503787994385,21.84482184338379L10.204613787994385,25.723118843383787L11.056693787994384,25.723118843383787L6.365503787994385,20.98404884338379L6.365503787994385,21.84482184338379Z\"/>\n  <path d=\"M6.365503787994385,19.346893575683595L12.677303787994385,25.723117575683595L12.731003787994386,25.723117575683595L12.731003787994386,24.917807575683593L6.365503787994385,18.487327575683594L6.365503787994385,19.346893575683595Z\"/>\n  <path d=\"M6.365503787994385,16.850171002624514L12.731003787994386,23.28064800262451L12.731003787994386,22.41987800262451L6.365503787994385,15.989398002624512L6.365503787994385,16.850171002624514Z\"/>\n  <path d=\"M6.365503787994385,14.352241873901367L12.731003787994386,20.782723873901368L12.731003787994386,19.923153873901366L6.365503787994385,13.492673873901367L6.365503787994385,14.352241873901367Z\"/>\n  <path d=\"M6.365503787994385,11.85551769885254L12.731003787994386,18.28600069885254L12.731003787994386,17.42643069885254L6.365503787994385,10.995950698852539L6.365503787994385,11.85551769885254Z\"/>\n  <path d=\"M6.365503787994385,9.357589125793456L12.731003787994386,15.789271125793457L12.731003787994386,14.928501125793456L6.365503787994385,8.498021125793457L6.365503787994385,9.357589125793456Z\"/>","vb":"0 0 25.72 25.72"},"stepfun":{"s":"<g clipPath=\"url(#clip0_9396_9240)\">\n        <path\n          d=\"M14 0C6.272 0 0 6.272 0 14C0 21.728 6.272 28 14 28C21.728 28 28 21.728 28 14C28 6.272 21.728 0 14 0ZM10.22 22.876H5.11V17.766H10.22V22.876ZM16.548 22.876H11.438V17.766H16.548V22.876ZM16.548 16.562H11.438V11.438H16.548V16.562ZM16.548 10.234H11.438V5.124H16.548V10.234ZM22.876 10.234H17.766V5.11H22.876V10.234Z\"\n          fill=\"currentColor\"\n        />\n      </g>\n      <defs>\n        <clipPath id=\"clip0_9396_9240\">\n          <rect width=\"28\" height=\"28\" />\n        </clipPath>\n      </defs>","vb":"0 0 28 28"},"openrouter":{"s":"<path d=\"M728.039 234C819.325 234 893.323 308.62 893.323 400.668C893.323 492.716 819.325 567.336 728.039 567.336L891.984 732.656C912.81 753.655 898.061 789.56 868.613 789.56H397.472C245.333 789.56 122 665.193 122 511.78C122 358.367 245.333 234 397.472 234H728.039ZM397.472 345.112C306.189 345.112 232.189 419.732 232.189 511.78C232.189 603.828 306.189 678.448 397.472 678.448C488.756 678.448 562.756 603.828 562.756 511.78C562.756 419.732 488.756 345.112 397.472 345.112Z\" fill=\"currentColor\" transform=\"scale(0.0234375)\"/>","vb":"0 0 24 24"},"opencode":{"s":"<path d=\"M8.40005 17.4H19.2001V21H4.80005V13.8H8.40005V17.4ZM15.6001 10.2V13.8H8.40005V10.2H15.6001ZM19.2001 10.2H15.6001V6.6H4.80005V3H19.2001V10.2Z\" fill=\"currentColor\"/>","vb":"0 0 24 24"},"perplexity":{"s":"<path d=\"M17.2642 2.8689L12.042 8.0961M17.2642 2.8689V8.0961H12.042M17.2642 2.8689V4.30027M12.042 8.0961L6.81809 2.8689V8.0961H12.042ZM12.042 8.0961L17.2642 13.3225V20.8159L12.042 15.5887M12.042 8.0961V15.5887M12.042 8.0961L6.81892 13.3225M12.0296 2.1V21.9M12.042 15.5887L6.81892 20.8159V13.3225M6.81892 13.3225L6.81809 15.559H4.57739V8.09527H12.0412L6.81892 13.3225ZM11.9859 8.09527L17.2081 13.3225V15.559H19.4497V8.09527H11.9859Z\" stroke=\"currentColor\" stroke-width=\"0.825\" stroke-miterlimit=\"10\"/>","vb":"0 0 24 24"},"huggingface":{"s":"<path d=\"M26.7365 7.70867C30.9594 10.1097 33.562 14.5441 33.562 19.3448C33.562 20.7468 33.3436 22.0995 32.9378 23.3705C33.2276 23.3346 33.5219 23.3669 33.7971 23.4647C34.0723 23.5626 34.3208 23.7233 34.523 23.9341C34.8338 24.2495 35.0303 24.6597 35.0814 25.0996C35.1324 25.5394 35.0351 25.9837 34.8048 26.3619C35.0922 26.5944 35.3008 26.9044 35.4079 27.2525L35.4318 27.3398C35.5164 27.6526 35.6009 28.3121 35.15 28.9828C35.4938 29.5042 35.5431 30.1608 35.2811 30.7244C34.9217 31.5276 34.0228 32.1588 32.2826 32.838L31.9979 32.9479L31.8133 33.0156C31.1398 33.2593 30.5593 33.4312 30.3183 33.5017L30.1971 33.5355C28.9431 33.8779 27.6495 34.0639 26.3476 34.0907C24.4876 34.0907 23.1067 33.5834 22.2289 32.5872C20.7465 32.8382 19.2331 32.8468 17.748 32.6126C16.8688 33.5933 15.4935 34.0907 13.6504 34.0907C12.4424 34.0666 11.2411 33.9044 10.07 33.6074L9.75858 33.5228L9.37391 33.4101C8.81508 33.2406 8.26281 33.0503 7.71825 32.8394C5.97523 32.1588 5.07625 31.529 4.71693 30.7244C4.45485 30.1608 4.50416 29.5028 4.84798 28.9828C4.68566 28.7453 4.57646 28.4756 4.52782 28.1921C4.47919 27.9085 4.49227 27.6178 4.56616 27.3398C4.66339 26.9552 4.88461 26.6127 5.19602 26.3619C4.96607 25.9839 4.86892 25.5399 4.91997 25.1003C4.97102 24.6607 5.16735 24.2508 5.47783 23.9355C5.80614 23.5861 6.26268 23.3846 6.76995 23.362L6.87985 23.3606C6.46754 22.0619 6.2584 20.7073 6.25986 19.3448C6.25986 14.5441 8.86242 10.1097 13.0854 7.70867C15.1666 6.52898 17.518 5.90889 19.9102 5.90889C22.3025 5.90889 24.6553 6.52898 26.7365 7.70867ZM8.99205 23.8862C9.16818 24.8542 12.3132 27.1975 12.0075 27.7006C11.7397 28.1444 10.8858 27.3638 10.6717 27.1566L10.6139 27.1003L10.3772 26.8932C9.58668 26.2182 7.13067 24.2159 6.51631 24.8754C5.91041 25.5235 6.68399 26.0858 8.00288 26.8762L9.10759 27.5343L9.29923 27.6512C10.7717 28.5573 10.8774 28.8349 10.6378 29.2195C10.3729 29.6352 6.312 26.2605 5.93155 27.6935C5.5511 29.1181 10.077 29.5309 9.79804 30.5201C9.51622 31.5064 6.60649 28.6545 6.01469 29.7634C5.41583 30.8766 10.1193 32.1842 10.1574 32.1941L10.3828 32.2504L10.6294 32.3096C12.3583 32.7098 15.6527 33.2255 16.8786 31.4585C17.8269 30.0875 17.7804 29.0504 16.5292 27.7809L16.4488 27.7006C15.1173 26.3929 14.3423 24.4766 14.3423 24.4766L14.3183 24.3949L14.2831 24.2934C14.1676 23.9834 13.8829 23.393 13.3954 23.4705C12.7472 23.5734 12.271 25.1755 13.5645 26.1943L13.6349 26.2478C15.0116 27.2637 13.3602 27.9528 12.8275 27.0002L12.7458 26.8537L12.5443 26.5014C11.8919 25.3756 10.7379 23.5269 10.0939 23.1239C9.34432 22.6561 8.81592 22.9154 8.99205 23.8862ZM29.9055 23.1239C29.1544 23.5959 27.7031 26.0463 27.1719 27.0002C27.0805 27.1684 26.9358 27.3014 26.7606 27.3785C26.5854 27.4555 26.3895 27.4721 26.2038 27.4258C26.1115 27.3997 26.0266 27.3525 25.9558 27.2877C25.9293 27.2626 25.9061 27.2342 25.8868 27.2031L25.8671 27.1637L25.8558 27.1355L25.8459 27.1087L25.8417 27.0904L25.8375 27.0665C25.8337 27.0441 25.8318 27.0215 25.8318 26.9988C25.8318 26.8297 25.9319 26.624 26.1841 26.3972C26.2207 26.3633 26.2602 26.3309 26.3025 26.2985L26.3687 26.2478C26.3997 26.2253 26.4293 26.2027 26.4575 26.1788C27.7017 25.1783 27.2649 23.6283 26.6421 23.4776L26.5984 23.4691L26.5195 23.4635C26.4902 23.4638 26.4609 23.4667 26.4321 23.4719L26.3927 23.479L26.3335 23.4987L26.2785 23.5227L26.2391 23.5438L26.1996 23.5706L26.1489 23.6086L26.1165 23.6368C25.8727 23.8594 25.7318 24.2399 25.6797 24.4005L25.6571 24.4766C25.6571 24.4766 24.9103 26.3211 23.6295 27.6245L23.5534 27.7006C23.0391 28.205 22.7136 28.6728 22.5642 29.135C22.3627 29.7507 22.4712 30.3581 22.8601 31.0415C22.9376 31.1781 23.025 31.3162 23.1236 31.4585C24.3664 33.2551 27.7482 32.6929 29.456 32.2899L29.859 32.1913L30.2112 32.087C30.6001 31.9686 31.2483 31.7587 31.9021 31.4952L32.167 31.3867L32.2586 31.3472L32.3488 31.3078L32.5235 31.2289L32.6376 31.1753C33.383 30.8202 33.996 30.4102 34.0383 30.01L34.0397 29.9593C34.0385 29.8907 34.0206 29.8235 33.9875 29.7634C33.8551 29.5154 33.6057 29.4647 33.2957 29.5267L33.2323 29.5408C33.1703 29.5549 33.1055 29.5746 33.0406 29.5972L32.904 29.6465L32.8279 29.6775C32.0402 30.0016 31.0834 30.6709 30.5635 30.7272H30.572C30.5486 30.7299 30.525 30.7314 30.5015 30.7315H30.4677L30.4339 30.7272L30.4015 30.7202C30.3056 30.6976 30.238 30.6356 30.2042 30.5201C30.191 30.4743 30.1886 30.4261 30.1971 30.3792C30.2845 29.8931 31.547 29.5408 32.6109 29.0969L32.7039 29.0575C33.4479 28.7419 34.0707 28.3769 34.0918 27.8851V27.8288C34.0892 27.7821 34.0816 27.7358 34.0693 27.6907C34.0016 27.4371 33.8227 27.337 33.562 27.337C32.4559 27.337 29.9689 29.2533 29.4475 29.2533C29.4123 29.2533 29.3799 29.2435 29.3658 29.2195C29.3408 29.1801 29.3191 29.1386 29.301 29.0955C29.1601 28.7602 29.3968 28.4445 30.7946 27.5935L31.0891 27.4159C31.8472 26.965 32.5122 26.5874 32.9786 26.245C33.3873 25.9463 33.648 25.6729 33.6874 25.3995L33.6916 25.3601C33.7029 25.2009 33.6381 25.0402 33.4845 24.8754C33.4561 24.8447 33.4228 24.819 33.3859 24.7993L33.338 24.7781L33.3196 24.7711C33.2605 24.7517 33.1987 24.7422 33.1365 24.7429C32.9082 24.7429 32.6165 24.8415 32.2981 24.9965C31.4005 25.4376 30.2817 26.338 29.7251 26.8072L29.3742 27.1101L29.3277 27.1566C29.215 27.2666 28.9219 27.5371 28.6331 27.7006L28.533 27.7527L28.4753 27.7795C28.4202 27.8031 28.3625 27.8202 28.3034 27.8302H28.3104C28.2959 27.8322 28.2813 27.8337 28.2667 27.8344L28.2808 27.833L28.2625 27.8344C28.1512 27.8415 28.0582 27.8048 27.9948 27.7006C27.9792 27.6727 27.9723 27.6408 27.975 27.609C28.0131 26.9537 30.8411 24.8035 31.0074 23.8862L31.02 23.8186C31.1609 22.9027 30.6382 22.6674 29.9055 23.1239ZM19.9123 7.29581C13.1516 7.29581 7.67034 12.6911 7.67034 19.3434C7.67034 20.3184 7.7873 21.2653 8.00852 22.1728L8.01979 22.1601C8.37488 21.7402 8.88214 21.5119 9.45282 21.5119C9.95304 21.5232 10.4378 21.6768 10.852 21.9515C11.162 22.1488 11.5072 22.4926 11.8595 22.9294C12.2273 22.4053 12.8318 22.0868 13.4799 22.077C14.6805 22.077 15.4061 23.1028 15.6809 24.0257L15.7471 24.1736L15.8317 24.3526C16.1022 24.9106 16.6701 25.9575 17.4422 26.7198C18.9359 28.1853 19.3078 29.7 18.5695 31.3219C19.5178 31.4242 20.4747 31.4176 21.4215 31.3021C20.7099 29.724 21.0551 28.2444 22.4642 26.8128L22.5572 26.7198C23.5365 25.756 24.1875 24.3385 24.3213 24.0257C24.5961 23.1028 25.3189 22.077 26.5195 22.077C27.1676 22.0868 27.7721 22.4053 28.1399 22.9294C28.4922 22.4926 28.8374 22.1502 29.1516 21.9515C29.5658 21.6763 30.0494 21.5239 30.5466 21.5119C31.0496 21.5119 31.5076 21.6895 31.85 22.0192C32.0472 21.1596 32.1529 20.2649 32.1529 19.3448C32.1529 12.6911 26.6716 7.29581 19.9123 7.29581ZM22.529 19.8732L23.1476 19.5744C23.9268 19.2025 24.4016 19.0348 24.4016 19.7886C24.4016 21.3287 23.3152 24.3089 19.956 24.385H19.6968C16.4207 24.3117 15.3061 21.4823 15.2497 19.9112L15.2483 19.7886C15.2483 18.2288 17.2943 20.6143 19.8278 20.6143C20.8367 20.6143 21.7709 20.2311 22.529 19.8732ZM28.1892 15.4445C28.8233 15.4445 29.3348 15.9489 29.3348 16.5717C29.3348 17.1931 28.8219 17.699 28.1892 17.699C28.0401 17.7001 27.8922 17.6718 27.754 17.6158C27.6157 17.5597 27.4899 17.477 27.3837 17.3723C27.2774 17.2676 27.1928 17.1431 27.1347 17.0057C27.0766 16.8683 27.0462 16.7209 27.0451 16.5717C27.0451 15.9489 27.558 15.4445 28.1892 15.4445ZM11.8102 15.4445C12.4415 15.4445 12.9544 15.9489 12.9544 16.5717C12.9544 17.1931 12.4415 17.699 11.8102 17.699C11.6609 17.7003 11.5129 17.6721 11.3745 17.6162C11.2361 17.5602 11.1101 17.4775 11.0037 17.3728C10.8973 17.2681 10.8126 17.1435 10.7544 17.006C10.6962 16.8686 10.6657 16.721 10.6646 16.5717C10.6646 15.9489 11.1775 15.4445 11.8102 15.4445ZM22.7868 14.2594C23.2377 13.7184 23.9789 13.4985 24.6609 13.7043C25.3415 13.91 25.8304 14.499 25.8981 15.1979C25.9657 15.8954 25.5993 16.5647 24.9695 16.893C24.5158 17.1297 24.3396 16.2209 23.8887 16.0687L23.8916 16.0645C23.4872 15.9264 22.8038 16.5745 22.5882 16.1758C22.425 15.8734 22.3565 15.529 22.3917 15.1872C22.4269 14.8455 22.5655 14.5222 22.7868 14.2594ZM16.6954 14.2594C17.1492 14.8005 17.2267 15.5558 16.8927 16.1758C16.6785 16.5745 15.9909 15.9264 15.5893 16.0645L15.5935 16.0687C15.4414 16.1194 15.3202 16.2575 15.2089 16.4069L15.0426 16.6394C14.8876 16.8507 14.7326 17.0085 14.5114 16.893C14.2053 16.7349 13.9535 16.4889 13.7882 16.1866C13.623 15.8843 13.552 15.5395 13.5842 15.1965C13.6518 14.499 14.1408 13.91 14.8214 13.7043C15.1538 13.6037 15.5085 13.6026 15.8415 13.7013C16.1746 13.7999 16.4714 13.994 16.6954 14.2594Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"bedrock":{"s":"<path d=\"M21.5835 24.7904H25.7835C26.0754 24.7904 26.314 25.0318 26.314 25.3277V27.8096C26.8199 27.9343 27.2691 28.2255 27.5896 28.6362C27.9102 29.047 28.0833 29.5536 28.0813 30.0746C28.0813 31.3605 27.0517 32.4037 25.7835 32.4037C24.514 32.4037 23.4844 31.3605 23.4844 30.0746C23.4844 28.9741 24.2399 28.0509 25.2531 27.8082V25.865H21.5849V32.2237C21.5852 32.3161 21.5618 32.407 21.5169 32.4877C21.4721 32.5684 21.4072 32.6362 21.3285 32.6846L17.6603 34.9224C17.577 34.9733 17.4813 35 17.3837 34.9995C17.2862 34.999 17.1907 34.9714 17.108 34.9197L10.3906 30.7114C10.3131 30.6628 10.2493 30.5952 10.2052 30.515C10.161 30.4348 10.138 30.3447 10.1384 30.2532V25.8636L6.78241 23.9136C6.70609 23.8694 6.64181 23.8071 6.59521 23.7322C6.5486 23.6573 6.52111 23.5721 6.51514 23.4841V23.4472V16.4626C6.51514 16.2717 6.61468 16.0944 6.77696 15.999L10.1384 14.0053V9.70163C10.1384 9.52572 10.2229 9.36208 10.3634 9.26253L10.392 9.24344L17.1107 5.07885C17.194 5.027 17.2901 4.99951 17.3882 4.99951C17.4863 4.99951 17.5824 5.027 17.6657 5.07885L21.3339 7.36296C21.4115 7.41162 21.4753 7.47921 21.5194 7.55938C21.5636 7.63955 21.5866 7.72964 21.5862 7.82115V13.9999H26.8445V11.3857C26.3384 11.2609 25.8889 10.9696 25.5684 10.5585C25.2479 10.1475 25.0749 9.6406 25.0772 9.11935C25.0772 7.83342 26.1067 6.79023 27.3749 6.79023C28.6445 6.79023 29.6727 7.83342 29.6727 9.11935C29.6727 10.2198 28.9186 11.143 27.9054 11.3857V14.5371C27.9059 14.6073 27.8926 14.6768 27.8662 14.7418C27.8399 14.8068 27.8009 14.8659 27.7516 14.9158C27.7024 14.9658 27.6437 15.0055 27.5791 15.0327C27.5144 15.0599 27.4451 15.0741 27.3749 15.0744H21.5862V17.5372H30.6191C30.7351 17.0302 31.0192 16.5773 31.4252 16.2522C31.8313 15.9271 32.3353 15.749 32.8554 15.7467C34.1236 15.7467 35.1532 16.7885 35.1532 18.0745C35.1532 19.3604 34.125 20.4036 32.8554 20.4036C32.3351 20.4012 31.8309 20.2229 31.4249 19.8975C31.0188 19.5722 30.7348 19.119 30.6191 18.6117H21.5835V21.2531H28.3377L29.5854 22.8622C29.9329 22.659 30.3283 22.5522 30.7309 22.5527C32.0004 22.5527 33.0286 23.5945 33.0286 24.8804C33.0286 26.1664 32.0004 27.2096 30.7309 27.2096C29.4627 27.2096 28.4331 26.1664 28.4331 24.8804C28.4331 24.4086 28.5722 23.9695 28.8095 23.6027L27.8222 22.3277H21.5835V24.7904ZM17.3875 6.16704L14.6016 7.89342V11.9407H13.5407V8.55071L11.1993 10.003V14.019L14.0766 15.8735L17.0316 14.0135V10.9098H18.0925V14.3135C18.0925 14.499 17.9971 14.6721 17.8416 14.7703L14.6466 16.779V19.6167L16.5857 20.9927L15.9775 21.8736L14.0602 20.5127L11.9738 21.8831L11.397 20.9831L13.5857 19.5445V16.8308L10.6579 14.9408L7.57606 16.7681V19.0536L10.2652 17.4322L10.8079 18.3554L7.57606 20.304V23.1363L10.5297 24.8518L13.6252 22.9863L14.1666 23.9095L11.1993 25.6973V29.9546L13.7575 31.5569L16.9825 29.6123L17.5253 30.5369L14.7748 32.1951L17.3903 33.8328L20.5239 31.9196V24.0377L14.0357 27.9828L13.4902 27.0623L20.5239 22.7859V8.12115L17.3875 6.16704ZM25.7835 28.8228C25.6198 28.8237 25.4579 28.8568 25.307 28.9204C25.1561 28.984 25.0192 29.0767 24.9042 29.1932C24.7892 29.3097 24.6983 29.4478 24.6367 29.5995C24.5751 29.7512 24.5441 29.9136 24.5453 30.0773C24.5453 30.7687 25.099 31.3292 25.7835 31.3292C25.947 31.3281 26.1087 31.2948 26.2594 31.2313C26.41 31.1677 26.5467 31.0751 26.6615 30.9587C26.7764 30.8424 26.8672 30.7045 26.9287 30.553C26.9903 30.4016 27.0215 30.2395 27.0204 30.076C27.0216 29.9123 26.9906 29.7501 26.9291 29.5985C26.8676 29.4468 26.7769 29.3088 26.662 29.1923C26.5471 29.0758 26.4104 28.9831 26.2597 28.9194C26.109 28.8558 25.9472 28.8238 25.7835 28.8228ZM30.7336 23.6272C30.5699 23.6281 30.4079 23.6613 30.257 23.7249C30.1062 23.7884 29.9693 23.8811 29.8543 23.9977C29.7393 24.1142 29.6484 24.2523 29.5868 24.404C29.5252 24.5557 29.4942 24.7181 29.4954 24.8818C29.4954 25.5745 30.0491 26.1364 30.7322 26.1364C30.896 26.1355 31.0579 26.1023 31.2088 26.0387C31.3597 25.9752 31.4966 25.8825 31.6116 25.7659C31.7266 25.6494 31.8175 25.5113 31.8791 25.3596C31.9406 25.2079 31.9717 25.0455 31.9704 24.8818C31.9717 24.7181 31.9406 24.5557 31.8791 24.404C31.8175 24.2523 31.7266 24.1142 31.6116 23.9977C31.4966 23.8811 31.3597 23.7884 31.2088 23.7249C31.0579 23.6613 30.8973 23.6281 30.7336 23.6272ZM32.8541 16.8226C32.6904 16.8235 32.5284 16.8567 32.3775 16.9203C32.2266 16.9838 32.0898 17.0765 31.9747 17.1931C31.8597 17.3096 31.7688 17.4477 31.7073 17.5994C31.6457 17.7511 31.6146 17.9135 31.6159 18.0772C31.6159 18.7686 32.1709 19.329 32.8541 19.329C33.0176 19.3279 33.1793 19.2947 33.3299 19.2311C33.4806 19.1676 33.6172 19.075 33.7321 18.9586C33.8469 18.8422 33.9377 18.7044 33.9993 18.5529C34.0609 18.4014 34.092 18.2393 34.0909 18.0758C34.0922 17.9122 34.0612 17.7499 33.9997 17.5983C33.9382 17.4467 33.8474 17.3087 33.7325 17.1922C33.6177 17.0757 33.481 16.9829 33.3302 16.9193C33.1795 16.8556 33.0177 16.8223 32.8541 16.8213V16.8226ZM27.3736 7.86342C27.2099 7.86449 27.0482 7.8978 26.8974 7.96145C26.7467 8.02509 26.61 8.11783 26.4951 8.23434C26.3802 8.35086 26.2895 8.48887 26.228 8.64049C26.1665 8.79212 26.1355 8.95437 26.1367 9.11798C26.1367 9.81072 26.6904 10.3725 27.3736 10.3725C27.5373 10.3717 27.6992 10.3385 27.8501 10.2749C28.001 10.2113 28.1379 10.1186 28.2529 10.0021C28.3679 9.88558 28.4588 9.7475 28.5204 9.59579C28.582 9.44408 28.613 9.28171 28.6118 9.11798C28.613 8.95426 28.582 8.79189 28.5204 8.64018C28.4588 8.48847 28.3679 8.35039 28.2529 8.23386C28.1379 8.11733 28.001 8.02462 27.8501 7.96106C27.6992 7.89749 27.5373 7.86432 27.3736 7.86342Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"azure":{"s":"<path d=\"M21.68 7.58398L11.296 29.68L4 29.6L12.144 15.584L21.68 7.58398ZM22.8 9.32798L36 32.416H11.584L26.464 29.76L18.672 20.496L22.8 9.32798Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"togetherai":{"s":"<path opacity=\"0.25\" d=\"M27.539 18.922C29.2526 18.922 30.8959 18.2413 32.1076 17.0296C33.3193 15.8179 34 14.1746 34 12.461C34 10.7474 33.3193 9.10406 32.1076 7.89238C30.8959 6.68071 29.2526 6 27.539 6C25.8254 6 24.1821 6.68071 22.9704 7.89238C21.7587 9.10406 21.078 10.7474 21.078 12.461C21.078 14.1746 21.7587 15.8179 22.9704 17.0296C24.1821 18.2413 25.8254 18.922 27.539 18.922ZM27.539 34C29.2526 34 30.8959 33.3193 32.1076 32.1076C33.3193 30.8959 34 29.2526 34 27.539C34 25.8254 33.3193 24.1821 32.1076 22.9704C30.8959 21.7587 29.2526 21.078 27.539 21.078C25.8254 21.078 24.1821 21.7587 22.9704 22.9704C21.7587 24.1821 21.078 25.8254 21.078 27.539C21.078 29.2526 21.7587 30.8959 22.9704 32.1076C24.1821 33.3193 25.8254 34 27.539 34ZM12.461 34C14.1746 34 15.8179 33.3193 17.0296 32.1076C18.2413 30.8959 18.922 29.2526 18.922 27.539C18.922 25.8254 18.2413 24.1821 17.0296 22.9704C15.8179 21.7587 14.1746 21.078 12.461 21.078C10.7474 21.078 9.10406 21.7587 7.89238 22.9704C6.68071 24.1821 6 25.8254 6 27.539C6 29.2526 6.68071 30.8959 7.89238 32.1076C9.10406 33.3193 10.7474 34 12.461 34Z\" fill=\"currentColor\"/>\n<path d=\"M12.461 18.922C16.0293 18.922 18.922 16.0293 18.922 12.461C18.922 8.89269 16.0293 6 12.461 6C8.89269 6 6 8.89269 6 12.461C6 16.0293 8.89269 18.922 12.461 18.922Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"cerebras":{"s":"<path d=\"M22.9846 6.52999C19.4122 6.52999 15.9861 7.94913 13.46 10.4752C10.9339 13.0013 9.51474 16.4274 9.51474 19.9999C9.51474 23.5723 10.9339 26.9984 13.46 29.5245C15.9861 32.0506 19.4122 33.4698 22.9846 33.4698V35.4991C14.4238 35.4991 7.48535 28.5592 7.48535 19.9984C7.48535 11.4376 14.4224 4.49915 22.9832 4.49915V6.52854L22.9846 6.52999ZM29.868 11.8562C28.7978 10.9477 27.5586 10.2598 26.2216 9.83189C24.8846 9.40401 23.4761 9.24465 22.0773 9.36298C20.6785 9.48132 19.3169 9.875 18.0707 10.5214C16.8246 11.1678 15.7185 12.0542 14.8162 13.1295C13.9138 14.2049 13.2329 15.448 12.8126 16.7875C12.3923 18.1269 12.241 19.5362 12.3673 20.9343C12.4936 22.3324 12.895 23.6918 13.5485 24.9342C14.202 26.1767 15.0946 27.2777 16.1751 28.1739L14.87 29.7296C13.594 28.6594 12.5414 27.3482 11.7722 25.871C11.003 24.3939 10.5323 22.7797 10.3871 21.1206C10.2418 19.4615 10.4247 17.7901 10.9255 16.2017C11.4263 14.6134 12.235 13.1392 13.3055 11.8635C14.376 10.5875 15.6873 9.5348 17.1645 8.7656C18.6418 7.99639 20.2561 7.52572 21.9153 7.38045C23.5745 7.23517 25.2461 7.41815 26.8345 7.91893C28.423 8.41971 29.8973 9.22848 31.1732 10.2991L29.868 11.8562ZM26.6016 13.0788C24.7668 12.1311 22.6319 11.9464 20.6616 12.5649C18.6913 13.1834 17.045 14.5551 16.0809 16.3813C15.1169 18.2076 14.9132 20.3408 15.514 22.3165C16.1149 24.2923 17.4718 25.9508 19.2894 26.9311L18.3392 28.7273C16.0689 27.4824 14.3791 25.3948 13.6343 22.915C12.8896 20.4352 13.1498 17.762 14.3586 15.4723C15.5674 13.1826 17.628 11.46 20.0957 10.6762C22.5635 9.89232 25.2404 10.1101 27.5489 11.2826L26.6016 13.0788ZM22.9832 14.9865C21.6536 14.9865 20.3784 15.5147 19.4382 16.4549C18.498 17.3951 17.9698 18.6702 17.9698 19.9999C17.9698 21.3295 18.498 22.6047 19.4382 23.5449C20.3784 24.485 21.6536 25.0132 22.9832 25.0132V27.0441C21.1149 27.0441 19.3232 26.3019 18.0022 24.9809C16.6811 23.6598 15.939 21.8681 15.939 19.9999C15.939 18.1316 16.6811 16.3399 18.0022 15.0189C19.3232 13.6978 21.1149 12.9557 22.9832 12.9557V14.9865Z\" fill=\"currentColor\"/>\n<path d=\"M24.8474 18.3138C24.6315 18.0812 24.3826 17.8816 24.1087 17.7213C23.8701 17.5796 23.5982 17.5036 23.3207 17.5011C22.9513 17.5011 22.621 17.5692 22.3299 17.7039C22.0485 17.8307 21.7956 18.0131 21.5865 18.2401C21.3774 18.4672 21.2164 18.7341 21.1131 19.025C21.0059 19.319 20.9538 19.6276 20.9538 19.939C20.9538 20.2548 21.0059 20.5619 21.1131 20.853C21.2172 21.1436 21.3786 21.4104 21.5876 21.6375C21.7966 21.8647 22.049 22.0476 22.3299 22.1756C22.6196 22.3103 22.9528 22.3783 23.3207 22.3783C23.6336 22.3783 23.9247 22.3117 24.1927 22.1828C24.465 22.0524 24.6997 21.8569 24.8808 21.615L26.225 23.0722C26.0222 23.275 25.7904 23.4503 25.5268 23.598C25.0392 23.8699 24.5086 24.0561 23.958 24.1484C23.7118 24.1861 23.4989 24.2064 23.3207 24.2064C22.7362 24.21 22.156 24.107 21.6085 23.9022C21.0909 23.7108 20.6174 23.4166 20.2165 23.0374C19.8178 22.6565 19.5004 22.1987 19.2836 21.6917C19.0481 21.1378 18.9306 20.5409 18.9389 19.939C18.9389 19.2959 19.0548 18.7121 19.2836 18.1863C19.5009 17.6793 19.8167 17.2216 20.215 16.8406C20.6177 16.4625 21.0914 16.1685 21.6085 15.9773C22.156 15.7725 22.7362 15.6694 23.3207 15.6731C23.8349 15.6731 24.352 15.7716 24.8735 15.9686C25.3964 16.1685 25.8658 16.4901 26.2409 16.9087L24.8474 18.3138Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"},"vercel":{"s":"<path d=\"M35.5 33.5949H4.5L20 6.40511L35.5 33.5949Z\" fill=\"currentColor\"/>","vb":"0 0 40 40"}};
    // __BRAND_LOGO_END__
    // __BRAND_ICON_EXTRA_BEGIN__（由 scripts/update-brand-icons.mjs 生成于 2026-09-17，HF 头像矢量化，请勿手改）
    const BRAND_ICON_EXTRAS = {"zhipu":{"d":"M 21.293 1.449 C 11.939 4.372, 3.003 14.013, 0.984 23.360 C 0.210 26.945, -0.032 51.042, 0.187 103 L 0.500 177.500 2.923 182.423 C 6.014 188.703, 11.920 194.609, 17.851 197.351 C 22.481 199.491, 22.816 199.500, 100 199.500 L 177.500 199.500 182.220 197.320 C 188.511 194.413, 195.439 187.128, 197.510 181.239 C 198.427 178.633, 199.587 175.719, 200.089 174.764 C 201.274 172.506, 201.306 23.693, 200.122 24.425 C 199.639 24.723, 198.959 23.544, 198.611 21.804 C 196.952 13.512, 187.669 4.209, 178.212 1.363 C 171.700 -0.596, 27.586 -0.518, 21.293 1.449 M 0.475 100 C 0.475 141.525, 0.599 158.513, 0.750 137.750 C 0.901 116.988, 0.901 83.013, 0.750 62.250 C 0.599 41.488, 0.475 58.475, 0.475 100 M 35 49.968 L 35 59 61.750 58.965 C 81.074 58.939, 89.118 58.586, 90.726 57.692 C 92.519 56.696, 103.013 43.143, 102.995 41.847 C 102.993 41.656, 87.693 41.373, 68.995 41.218 L 35 40.936 35 49.968 M 73.321 98.821 C 51.080 130.348, 32.633 156.793, 32.328 157.588 C 31.851 158.830, 35.598 158.995, 59.024 158.766 L 86.275 158.500 127.137 100.660 C 149.612 68.848, 168 42.523, 168 42.160 C 168 41.797, 155.796 41.500, 140.880 41.500 L 113.759 41.500 73.321 98.821 M 109.315 142.286 C 107.409 143.346, 97 157.019, 97 158.463 C 97 158.758, 112.300 159, 131 159 L 165 159 165 150 L 165 141 138.250 141.035 C 119.188 141.061, 110.872 141.420, 109.315 142.286","w":200,"h":200},"sensenova":{"d":"M 13 71 L 13 130 42.500 130 L 72 130 72 158.878 L 72 187.756 130.077 188.501 C 169.955 189.012, 188.481 188.919, 189.196 188.204 C 189.911 187.489, 190.004 168.962, 189.492 129.082 L 188.748 71 159.874 71 L 131 71 131 41.500 L 131 12 72 12 L 13 12 13 71 M 72 100.515 L 72 130.030 101.250 129.765 L 130.500 129.500 130.765 100.250 L 131.030 71 101.515 71 L 72 71 72 100.515","w":200,"h":200},"baichuan":{"d":"M 79 103.500 L 79 185 99.500 185 L 120 185 120 103.500 L 120 22 99.500 22 L 79 22 79 103.500 M 136 38.500 L 136 55 156.500 55 L 177 55 177 38.500 L 177 22 156.500 22 L 136 22 136 38.500 M 28.623 39.635 L 20 56.270 20 102.290 L 20 148.310 10.459 166.655 L 0.919 185 21.855 185 L 42.791 185 52.396 166.939 L 62 148.878 62 85.939 L 62 23 49.623 23 L 37.247 23 28.623 39.635 M 136 125.500 L 136 185 156.500 185 L 177 185 177 125.500 L 177 66 156.500 66 L 136 66 136 125.500","w":200,"h":200},"xai":{"d":"M 115.969 59.712 C 108.011 71.103, 98.484 84.758, 94.797 90.056 L 88.095 99.688 94.137 108.371 L 100.178 117.054 102.889 113.277 C 113.577 98.385, 154 40.141, 154 39.633 C 154 39.285, 148.698 39, 142.219 39 L 130.437 39 115.969 59.712 M 147.101 59 C 143.031 64.775, 138.644 70.932, 137.351 72.683 L 135 75.867 135 118.433 L 135 161 144.531 161 C 151.235 161, 154.205 160.629, 154.541 159.750 C 154.804 159.063, 154.903 133.750, 154.760 103.500 L 154.500 48.500 147.101 59 M 46 82.568 C 46 82.880, 58.258 100.655, 73.239 122.068 L 100.478 161 112.322 161 C 119.732 161, 124.042 160.628, 123.833 160.005 C 123.650 159.458, 111.384 141.683, 96.576 120.505 L 69.653 82 57.826 82 C 51.322 82, 46 82.255, 46 82.568 M 58.020 142.458 C 51.707 151.489, 46.382 159.355, 46.187 159.939 C 45.951 160.647, 49.783 161, 57.716 161 L 69.599 161 75.810 152.038 L 82.020 143.076 75.913 134.538 C 72.554 129.842, 69.737 126.008, 69.653 126.019 C 69.569 126.029, 64.334 133.426, 58.020 142.458","w":200,"h":200},"cohere":{"d":"M 119.564 34.329 C 118.309 35.248, 116.416 40.986, 113.445 52.880 C 108.775 71.574, 106.278 76.805, 98.800 83.562 C 92.073 89.639, 84.874 92.411, 74.720 92.835 C 66.538 93.176, 64.876 92.874, 50.357 88.408 C 35.865 83.950, 34.592 83.718, 32.138 85.089 C 29.246 86.705, 28.219 90.673, 29.887 93.790 C 30.525 94.982, 33.739 96.522, 38.600 97.965 C 47.135 100.498, 47.041 100.826, 37 103.546 C 33.425 104.514, 29.691 106.002, 28.701 106.852 C 26.185 109.015, 26.858 113.830, 30 116.144 C 32.468 117.961, 32.705 117.926, 48.500 113.421 C 67.761 107.926, 76.226 107.661, 86.218 112.240 C 99.923 118.520, 106.149 128.230, 111.071 151 C 112.794 158.975, 114.622 166.282, 115.131 167.238 C 116.517 169.838, 120.596 170.495, 123.507 168.587 C 126.686 166.504, 126.703 163.053, 123.604 149.250 C 122.339 143.613, 121.516 139, 121.776 139 C 122.036 139, 126.476 142.825, 131.642 147.500 C 141.686 156.589, 144.352 157.648, 148 154 C 151.930 150.070, 150.747 147.838, 139.250 137.480 C 125.192 124.815, 123.352 122.708, 119.729 115.111 C 114.157 103.429, 115.054 88.948, 122.030 78 C 123.607 75.525, 130.095 68.364, 136.449 62.087 C 148.686 49.997, 150.138 47.245, 146.171 43.655 C 143.163 40.933, 139.861 41.700, 134.923 46.267 C 132.406 48.595, 129.399 51.329, 128.242 52.343 L 126.137 54.186 127.533 48.343 C 129.586 39.747, 129.403 36.396, 126.777 34.557 C 124.056 32.650, 121.951 32.584, 119.564 34.329 M 97.750 99.416 L 94 101.643 98.743 104.745 C 101.352 106.451, 103.591 107.743, 103.718 107.615 C 104.225 107.108, 102.682 97.006, 102.111 97.094 C 101.775 97.146, 99.812 98.191, 97.750 99.416","w":200,"h":200},"groq":{"d":"M 89.500 1.040 C 87.850 1.499, 82.727 2.573, 78.116 3.427 C 42.861 9.951, 10.272 42.386, 3.471 77.717 C 2.647 81.998, 1.485 87.750, 0.889 90.500 C -1.803 102.909, 3.033 128.077, 11.266 144.500 C 27.568 177.021, 58.792 196.913, 97.924 199.706 C 105.182 200.224, 107.347 199.923, 124.758 195.965 C 153.213 189.498, 179.062 167.253, 191.345 138.661 C 195.236 129.605, 198.888 114.664, 199.084 107 C 199.180 103.248, 199.332 102.916, 200 105 C 200.549 106.713, 200.832 104.885, 200.900 99.191 C 200.960 94.176, 200.624 91.115, 200.051 91.469 C 199.528 91.792, 198.822 90.356, 198.482 88.278 C 195.848 72.210, 193.840 65.549, 188.368 54.730 C 175.575 29.435, 148.557 8.484, 122.298 3.494 C 118.009 2.679, 112.581 1.559, 110.236 1.006 C 105.234 -0.174, 93.791 -0.155, 89.500 1.040 M 93.081 53.540 C 86.155 55.464, 82.278 57.890, 77.032 63.581 C 70.625 70.532, 68.594 75.896, 68.543 86 C 68.489 96.708, 71.464 103.491, 79.372 110.690 C 85.832 116.571, 91.949 118.929, 102.750 119.705 L 111 120.297 111 113.649 L 111 107 103.316 107 C 85.692 107, 75.193 94.042, 80.539 78.890 C 86.770 61.229, 111.164 60.350, 119.104 77.500 C 120.710 80.969, 120.958 84.156, 120.968 101.500 C 120.983 125.004, 119.887 129.034, 111.996 134.503 C 105.906 138.723, 95.428 138.872, 89.312 134.825 L 85.269 132.150 81.059 136.440 L 76.849 140.730 80.643 143.857 C 96.053 156.560, 121.805 149.828, 130.591 130.800 L 133.500 124.500 133.500 102 C 133.500 81.972, 133.280 78.905, 131.500 74.085 C 125.927 58.996, 107.984 49.401, 93.081 53.540 M 0.349 100 C 0.349 104.675, 0.522 106.587, 0.732 104.250 C 0.943 101.912, 0.943 98.087, 0.732 95.750 C 0.522 93.412, 0.349 95.325, 0.349 100","w":200,"h":200},"hunyuan":{"d":"M 133.714 11.619 C 132.964 12.369, 135.441 15, 136.897 15 C 140.299 15, 153.744 26.436, 158 32.949 C 158.825 34.212, 160.081 35.852, 160.792 36.593 C 161.502 37.334, 162.559 39.304, 163.139 40.970 C 163.720 42.637, 164.602 44, 165.098 44 C 165.594 44, 166 44.943, 166 46.096 C 166 47.248, 166.640 49.386, 167.423 50.846 C 172.685 60.658, 172.573 89.252, 167.236 98.684 C 166.556 99.886, 166 101.695, 166 102.706 C 166 106.405, 148.673 129, 145.836 129 C 145.365 129, 142.739 130.575, 140 132.500 C 137.261 134.425, 134.325 136, 133.475 136 C 132.625 136, 130.805 136.737, 129.430 137.638 C 125.921 139.937, 107.644 139.893, 105.087 137.579 C 104.127 136.710, 102.686 136, 101.884 136 C 100.197 136, 91 126.977, 91 125.323 C 91 124.713, 90.325 123.955, 89.500 123.638 C 88.565 123.280, 88 121.754, 88 119.590 C 88 117.681, 87.519 115.821, 86.931 115.457 C 86.343 115.094, 85.977 112.911, 86.119 110.607 C 86.575 103.198, 84.326 102.296, 76.376 106.702 C 70.959 109.704, 60 120.225, 60 122.423 C 60 123.199, 59.642 123.983, 59.205 124.167 C 58.768 124.350, 57.394 126.472, 56.152 128.883 C 52.956 135.086, 51.407 148.185, 52.843 156.876 C 53.960 163.643, 57.510 173.201, 59.141 173.833 C 59.613 174.017, 60.008 174.692, 60.017 175.333 C 60.039 176.834, 68.108 185.452, 70.880 186.936 C 72.046 187.560, 73 189.003, 73 190.144 C 73 191.876, 73.427 192.110, 75.596 191.565 C 77.146 191.176, 78.809 191.426, 79.726 192.187 C 85.091 196.640, 107.660 198.656, 116.500 195.471 C 118.700 194.679, 121.741 194.023, 123.257 194.015 C 126.407 193.998, 143.700 187.453, 146.079 185.377 C 146.947 184.620, 148.116 184, 148.676 184 C 150.237 184, 166.040 171.720, 170.088 167.363 C 175.189 161.871, 182.686 151.943, 183.955 149 C 184.548 147.625, 186.151 144.517, 187.517 142.093 C 188.883 139.669, 190 137.262, 190 136.744 C 190 136.226, 190.660 134.384, 191.467 132.651 C 198.517 117.501, 198.517 83.499, 191.467 68.349 C 190.660 66.616, 190 64.767, 190 64.241 C 190 60.007, 175.203 38.228, 167.353 30.907 C 158.702 22.839, 145.133 14, 141.398 14 C 140.550 14, 139.182 13.325, 138.357 12.500 C 136.795 10.938, 134.778 10.555, 133.714 11.619 M 26.868 43.333 C 22.582 45.338, 18.301 49.391, 16.657 53 C 16.282 53.825, 14.855 56.483, 13.487 58.907 C 12.119 61.331, 11 63.738, 11 64.256 C 11 64.774, 10.340 66.616, 9.533 68.349 C 6.588 74.677, 4 89.716, 4 100.500 C 4 125.111, 13.236 148.331, 30.394 166.854 C 34.312 171.084, 48.925 182.602, 52.105 183.967 C 53.422 184.533, 55.175 185.382, 56 185.856 C 63.175 189.971, 67 191.064, 67 189 C 67 188.450, 66.386 188, 65.636 188 C 64.885 188, 60.948 185.379, 56.886 182.174 C 46.577 174.043, 36.313 159.940, 33.470 150 C 33.077 148.625, 32.420 147.050, 32.010 146.500 C 31.600 145.950, 30.679 141.143, 29.964 135.818 C 28.538 125.208, 29.684 110.161, 32.403 103.775 C 33.170 101.974, 34.623 98.475, 35.631 96 C 37.670 90.997, 43.356 82.350, 48.125 77 C 53.748 70.692, 54.412 69.115, 54.412 62.062 C 54.412 52.236, 50.108 46.027, 40.967 42.667 C 35.173 40.537, 32.585 40.659, 26.868 43.333","w":200,"h":200}};
    // __BRAND_ICON_EXTRA_END__
    // 品牌解析：平台型厂家（OpenRouter / NIM / OpenCode Zen 等）只是“货架”，
    // 行内图标要认模型本身的品牌；认不出再退厂家 logo，最后字母兜底。
    // 品牌声明表（唯一事实源）：图标、模型识别、厂家识别一处维护。
    // 图标 = BRAND_ICON_PATHS[key]（simple-icons 24×24）或 BRAND_ICON_EXTRAS[key]
    // （矢量化，自带坐标空间），两者都缺则该品牌退回字母兜底。
    const BRANDS = [
      { key: 'deepseek', model: /deepseek/i, group: /deepseek/i },
      { key: 'kimi', model: /kimi|moonshot/i, group: /moonshot|kimi/i },
      { key: 'meta', model: /llama/i },
      { key: 'googlegemini', model: /gemma|gemini/i, group: /google|gemini|vertex/i },
      { key: 'mistralai', model: /mistral|mixtral|codestral|devstral|magistral|ministral/i, group: /mistral/i },
      { key: 'qwen', model: /qwen|tongyi/i },
      { key: 'minimax', model: /minimax/i },
      { key: 'nvidia', model: /nemotron|nvidia/i, group: /nvidia|nim/i },
      { key: 'anthropic', model: /claude|anthropic/i, group: /anthropic|claude/i },
      { key: 'bytedance', model: /doubao|bytedance/i, group: /volc|doubao|bytedance|ark-coding/i },
      { key: 'baidu', model: /ernie|wenxin/i, group: /baidu|ernie|wenxin|qianfan/i },
      { key: 'huawei', model: /pangu/i, group: /huawei|pangu/i },
      { key: 'perplexity', model: /sonar|perplexity|pplx/i, group: /perplexity|sonar/i },
      { key: 'xai', model: /grok|xai/i, group: /grok|xai/i },
      { key: 'cohere', model: /command|cohere/i, group: /cohere|command/i },
      { key: 'hunyuan', model: /hunyuan/i, group: /hunyuan|tencent/i },
      { key: 'zhipu', model: /glm|zhipu|z\.ai/i, group: /glm|zhipu|zai-org|z\.ai/i },
      { key: 'sensenova', model: /sensenova|sensechat/i, group: /sensenova|sensechat/i },
      { key: 'stepfun', model: /stepfun|step-?\d/i, group: /stepfun|step-?\d|stepfun-ai/i },
      { key: 'baichuan', model: /baichuan/i, group: /baichuan/i },
      { key: 'internlm', model: /internlm|intern-/i, group: /internlm|intern-/i },
      { key: 'yi', model: /(?:^|\W)yi[-\d]/i, group: /(?:^|\W)yi[-\d]/i },
      { key: 'openai', model: /gpt|openai|codex/i, group: /openai|codex/i },
      // 纯平台货架（没有自研模型，只按厂家名认）。
      { key: 'openrouter', group: /openrouter/i },
      { key: 'opencode', group: /opencode/i },
      { key: 'alibabacloud', group: /alibaba|dashscope/i },
      { key: 'huggingface', group: /huggingface|hf\.co/i },
      { key: 'ollama', group: /ollama/i },
      { key: 'replicate', group: /replicate/i },
      { key: 'vllm', group: /vllm/i },
      { key: 'lmstudio', group: /lmstudio|lm-studio/i },
      { key: 'deepmind', group: /deepmind/i },
      { key: 'cloudflare', group: /cloudflare|workers-ai/i },
      { key: 'groq', group: /groq/i },
      // 只有 models.dev 官方标的品牌（simple-icons 没有，HF 头像不合适）。
      { key: 'bedrock', group: /bedrock|amazon-aws|aws-/i },
      { key: 'azure', group: /azure/i },
      { key: 'togetherai', group: /together/i },
      { key: 'cerebras', group: /cerebras/i },
      { key: 'vercel', group: /vercel|v0-/i },
    ];
    // 命中了规则但图标缺失（矢量化被跳过）时返回 null，让字母兜底生效。
    const resolveBrandKey = (group, model) => {
      let key = null;
      if (model) {
        const haystack = `${model.id ?? ''} ${model.name ?? ''}`;
        for (const brand of BRANDS) if (brand.model?.test(haystack)) { key = brand.key; break; }
      }
      if (key === null) {
        const groupHaystack = `${group.id ?? ''} ${group.name ?? ''}`;
        for (const brand of BRANDS) if (brand.group?.test(groupHaystack)) { key = brand.key; break; }
      }
      if (key === null) return null;
      return BRAND_LOGOS[key] || BRAND_ICON_PATHS[key] || BRAND_ICON_EXTRAS[key] ? key : null;
    };
    const ProviderBadge = memo(function ProviderBadge({ group, model, size = 30 }) {
      const hue = providerHue(String(group.id ?? ''));
      const brandKey = resolveBrandKey(group, model);
      // 图标三级优先级：models.dev 官方标（currentColor 内嵌标记）
      // > simple-icons 手工表（24×24 单 path）> HF 矢量化补位（自带坐标空间）。
      const logo = brandKey ? BRAND_LOGOS[brandKey] : null;
      const extra = brandKey ? BRAND_ICON_EXTRAS[brandKey] : null;
      const brandPath = !logo && brandKey ? (BRAND_ICON_PATHS[brandKey] ?? extra?.d ?? null) : null;
      const brandViewBox = logo ? logo.vb : extra && !BRAND_ICON_PATHS[brandKey] ? `0 0 ${extra.w} ${extra.h}` : '0 0 24 24';
      const letter = String(group.name ?? group.id ?? '?').trim().charAt(0).toUpperCase() || '?';
      const svgProps = {
        viewBox: brandViewBox, width: Math.round(size * 0.62), height: Math.round(size * 0.62),
        fill: 'currentColor', preserveAspectRatio: 'xMidYMid meet', style: { display: 'block' },
      };
      return React.createElement('span', {
        'data-provider-badge': String(group.id ?? ''),
        'data-brand': brandKey ?? 'letter',
        'aria-hidden': 'true',
        style: {
          width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.3)}px`, flex: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: `${Math.round(size * 0.44)}px`, fontWeight: 700,
          background: `hsla(${hue},65%,60%,.16)`, color: `hsl(${hue},75%,72%)`,
        },
      }, logo
        // 官方标是构建期从 models.dev 抓的固定内容（非用户输入），直接内嵌。
        ? React.createElement('svg', { ...svgProps, dangerouslySetInnerHTML: { __html: logo.s } })
        : brandPath
          ? React.createElement('svg', svgProps, React.createElement('path', {
            d: brandPath,
            // 矢量化补位的镂空（如 Z.ai 黑底上的白 Z）用 evenodd 才不被实心化。
            fillRule: extra && !BRAND_ICON_PATHS[brandKey] ? 'evenodd' : undefined,
          }))
          : letter);
    });

    const ModelRow = memo(function ModelRow({ group, model, current, favoriteKey, favorite, onFavorite, onSelect, showProvider, showProviderBadge, t }) {
      const selected = current?.provider === group.id && current?.model === model.id;
      const distinctName = isDistinctText(model.name, model.id);
      const distinctDescription = isDistinctText(model.description, model.name, model.id);
      // 平铺视图附带厂家名，避免跨厂家同名单看不出归属。
      const subLine = [distinctName ? model.id : null, showProvider ? String(group.name) : null].filter(Boolean).join(' · ');
      // 行悬停反馈（内联样式没有 :hover，用 DOM 事件实现 200ms 提亮）。
      const hoverOn = (event) => {
        if (selected) return;
        event.currentTarget.style.background = colors.hoverBg;
        event.currentTarget.style.borderColor = colors.border;
      };
      const hoverOff = (event) => {
        if (selected) return;
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.borderColor = 'transparent';
      };
      return React.createElement('div', {
        onMouseEnter: hoverOn,
        onMouseLeave: hoverOff,
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 9px', marginBottom: '2px',
          borderRadius: '10px', border: `1px solid ${selected ? tint(colors.accent, 35) : 'transparent'}`,
          background: selected ? tint(colors.accent, 9) : 'transparent',
          boxShadow: selected ? `inset 3px 0 0 ${colors.accent}` : 'none',
          transition: 'background .18s, border-color .18s',
        },
      },
        showProviderBadge ? React.createElement(ProviderBadge, { group, model }) : null,
        React.createElement('button', {
          type: 'button',
          'data-model-option': 'true',
          'aria-current': selected ? 'true' : undefined,
          onClick: () => onSelect(selectionFor(group, model, current)),
          style: {
            flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'transparent',
            color: colors.text, cursor: 'pointer', textAlign: 'left',
          },
        },
          React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 } },
            React.createElement('span', {
              style: {
                fontSize: '13px', fontWeight: selected ? 650 : 600, color: colors.text,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, modelLabel(model)),
          ),
          subLine !== ''
            ? React.createElement('span', {
              style: { display: 'block', color: colors.muted, fontSize: '10.5px', marginTop: '2px', fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, subLine)
            : null,
          distinctDescription
            ? React.createElement('span', {
              style: { display: 'block', color: colors.muted, fontSize: '11px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, model.description)
            : null,
        ),
        React.createElement('span', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: '4px' } },
          isFreeModel(group, model) ? React.createElement(CapPill, { cap: 'free', label: t('free') }) : null,
          isVisionModel(group, model) ? React.createElement(CapPill, { cap: 'vision', label: t('vision') }) : null,
          isOmniModel(model) ? React.createElement(CapPill, { cap: 'omni', label: t('omni') }) : null,
          isReasoningModel(model) ? React.createElement(CapPill, { cap: 'reason', label: t('reasoning') }) : null,
          hasToolsModel(model) ? React.createElement(CapPill, { cap: 'tools', label: t('tools') }) : null,
          React.createElement('button', {
            type: 'button',
            title: favorite ? t('removeFavorite') : t('addFavorite'),
            'aria-label': favorite ? t('removeFavorite') : t('addFavorite'),
            'aria-pressed': favorite,
            onClick: () => onFavorite(favoriteKey),
            onMouseEnter: (event) => { event.currentTarget.style.color = '#f5c542'; },
            onMouseLeave: (event) => { event.currentTarget.style.color = favorite ? '#f5c542' : colors.muted; },
            style: {
              border: 'none', background: 'transparent', cursor: 'pointer', padding: '5px', lineHeight: 1,
              color: favorite ? '#f5c542' : colors.muted, fontSize: '16px', transition: 'color .15s',
            },
          }, favorite ? '★' : '☆'),
        ),
      );
    });

    const ModelSection = memo(function ModelSection({ title, rows, current, favoriteSet, toggleFavorite, choose, t }) {
      if (rows.length === 0) return null;
      return React.createElement('div', { style: { marginBottom: '10px' } },
        React.createElement('div', { style: { fontSize: '11px', fontWeight: 700, color: colors.muted, margin: '2px 0 5px 2px' } }, title),
        rows.map(({ group, model }) => {
          const key = modelKey(group.id, model.id);
          return React.createElement(ModelRow, {
            key,
            group,
            model,
            current,
            favoriteKey: key,
            favorite: favoriteSet.has(key),
            onFavorite: toggleFavorite,
            onSelect: choose,
            showProviderBadge: true,
            t,
          });
        }),
      );
    });

    const RecommendationRow = memo(function RecommendationRow({ row, current, favoriteSet, toggleFavorite, choose, busy, task, t }) {
      const { group, model } = row;
      const key = modelKey(group.id, model.id);
      const selected = current?.provider === group.id && current?.model === model.id;
      const badges = [
        isReasoningModel(model) ? { cap: 'reason', label: t('reasoning') } : null,
        isVisionModel(group, model) ? { cap: 'vision', label: t('vision') } : null,
        hasToolsModel(model) ? { cap: 'tools', label: t('tools') } : null,
        isFreeModel(group, model) ? { cap: 'free', label: t('free') } : null,
      ].filter(Boolean).slice(0, 3);
      return React.createElement('div', {
        onMouseEnter: (event) => {
          if (selected) return;
          event.currentTarget.style.background = colors.hoverBg;
          event.currentTarget.style.borderColor = colors.border;
        },
        onMouseLeave: (event) => {
          if (selected) return;
          event.currentTarget.style.background = 'transparent';
          event.currentTarget.style.borderColor = 'transparent';
        },
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', marginBottom: '2px',
          borderRadius: '10px', border: `1px solid ${selected ? tint(colors.accent, 35) : 'transparent'}`,
          background: selected ? tint(colors.accent, 9) : 'transparent',
          boxShadow: selected ? `inset 3px 0 0 ${colors.accent}` : 'none',
          transition: 'background .18s, border-color .18s',
        },
      },
        React.createElement(ProviderBadge, { group, model, size: 28 }),
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 } },
            React.createElement('span', { style: { fontSize: '13px', fontWeight: selected ? 650 : 600, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, modelLabel(model)),
          ),
          // 推荐理由只跟任务有关，在顶部说明条统一展示；行内只保留厂家归属。
          React.createElement('div', { style: { color: colors.muted, fontSize: '10.5px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(group.name)),
        ),
        React.createElement('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: '5px' } },
          badges.map(badge => React.createElement(CapPill, { key: badge.label, cap: badge.cap, label: badge.label })),
          React.createElement('button', {
            type: 'button',
            title: favoriteSet.has(key) ? t('removeFavorite') : t('addFavorite'),
            'aria-label': favoriteSet.has(key) ? t('removeFavorite') : t('addFavorite'),
            'aria-pressed': favoriteSet.has(key),
            onClick: () => toggleFavorite(key),
            onMouseEnter: (event) => { event.currentTarget.style.color = '#f5c542'; },
            onMouseLeave: (event) => { event.currentTarget.style.color = favoriteSet.has(key) ? '#f5c542' : colors.muted; },
            style: { border: 'none', background: 'transparent', color: favoriteSet.has(key) ? '#f5c542' : colors.muted, cursor: 'pointer', fontSize: '16px', padding: '5px', lineHeight: 1, transition: 'color .15s' },
          }, favoriteSet.has(key) ? '★' : '☆'),
          React.createElement('button', {
            type: 'button', 'data-model-option': 'true', onClick: () => choose(selectionFor(group, model, current)), disabled: busy,
            style: { padding: '5px 9px', borderRadius: '6px', border: `1px solid ${selected ? colors.ok : colors.accent}`, background: selected ? tint(colors.ok, 9) : tint(colors.accent, 9), color: selected ? colors.ok : colors.accent, cursor: busy ? 'default' : 'pointer', fontSize: '11px', whiteSpace: 'nowrap' },
          }, t('useModel')),
        ),
      );
    });

    function ModelPickerPlus({ locked, available, directory, load, select, quickCurrent }) {
      const t = translate;
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
      const menuRef = useRef(null);
      const [state, setState] = useState(() => directory?.getSnapshot?.() ?? {
        current: null, groups: [], failures: [], status: 'loading', error: null,
      });
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [expanded, setExpanded] = useState({});
      const [menuPos, setMenuPos] = useState(null);
      const [actionError, setActionError] = useState(null);
      const [favorites, setFavorites] = useState(() => storageGet(FAVORITES_KEY, []));
      const [recents, setRecents] = useState(() => storageGet(RECENTS_KEY, []));
      const [capabilityMode, setCapabilityMode] = useState('all');
      const [viewMode, setViewMode] = useState('recommend');
      const [taskMode, setTaskMode] = useState('code');
      const [slowLoad, setSlowLoad] = useState(false);
      // 运行时元数据补查完成后 bump 一下触发重渲染（新模型的徽章才显示）。
      const [, setMetaTick] = useState(0);

      useEffect(() => {
        mark('mount', { available, hasDirectory: Boolean(directory) });
        if (!directory || typeof directory.subscribe !== 'function') return undefined;
        const update = () => {
          const snapshot = directory.getSnapshot();
          const summary = summarizeState(snapshot);
          diagSnapshot = summary;
          diagGroups = (snapshot?.groups ?? []).map(g => ({ id: g.id, name: g.name, models: g.models?.length ?? 0 }));
          diagFailures = snapshot?.failures ?? [];
          mark('directory snapshot', summary);
          if (diagFailures.length) mark('directory failures', diagFailures);
          setState(snapshot);
        };
        update();
        return directory.subscribe(update);
      }, [directory]);

      const groups = state.groups ?? [];
      const failures = state.failures ?? [];
      const queryText = query.trim();
      // 目录里出现快照不认识的模型时，后台静默补查一次（节流+缓存，详见函数注释）。
      useEffect(() => {
        ensureRuntimeMetadata(groups, () => setMetaTick(tick => tick + 1), (msg) => mark('runtime meta', msg));
      }, [groups]);
      // 视图布局：「全部模型」按厂家分组；其后每个厂家一个 tab（只看该厂
      // 家的平铺模型）；搜索始终走跨厂家平铺；全部来源失败时直接列失败。
      const isProviderView = viewMode.startsWith('provider:');
      const providerId = isProviderView ? viewMode.slice('provider:'.length) : null;
      const providerGroup = providerId ? groups.find(group => group.id === providerId) ?? null : null;
      // 选中的厂家从目录消失（卸载/重载）时回退到全部模型。
      const effectiveViewMode = isProviderView && !providerGroup ? 'all' : viewMode;
      const showFlatList = queryText !== '';
      const showProviderGroups = effectiveViewMode === 'all' || (groups.length === 0 && failures.length > 0);

      // 永远不空转：目录停在 loading 超过 8 秒（例如 Provider 插件被卸载），
      // 就降级成明确的「未就绪」说明 + 重试按钮，而不是无限转圈。
      useEffect(() => {
        setSlowLoad(false);
        if (state.status !== 'loading' || groups.length > 0) return undefined;
        const timer = setTimeout(() => {
          mark('directory still loading after 8s', summarizeState(state));
          setSlowLoad(true);
        }, 8000);
        return () => clearTimeout(timer);
      }, [state.status, groups.length]);

      const modelIndex = useMemo(() => createModelIndex(groups), [groups]);
      const current = state.current ?? null;
      const currentChoice = current ? modelIndex.byKey.get(modelKey(current.provider, current.model)) : undefined;
      const currentModel = currentChoice?.model;
      const currentEffort = effortLabel(currentModel, current, t);
      const filteredGroups = useMemo(() => filterGroups(groups, query)
        .map(group => ({
          ...group,
          models: group.models.filter(model => matchesCapability(group, model, capabilityMode)),
        }))
        .filter(group => group.models.length > 0), [groups, query, capabilityMode]);
      const filteredFailures = useMemo(() => {
        if (!queryText) return failures;
        const needle = normalize(queryText);
        return failures.filter(failure => normalize(`${failure.provider ?? ''} ${failure.error ?? ''}`).includes(needle));
      }, [failures, queryText]);
      // 平铺列表：跨厂家打平成行（搜索用），行内附带厂家名。
      const flatRows = useMemo(() => filteredGroups.flatMap(group => group.models.map(model => ({ group, model }))), [filteredGroups]);
      // 厂家 tab 的平铺行：只含选中厂家，经能力过滤。
      const providerRows = useMemo(() => {
        if (!providerGroup || effectiveViewMode !== viewMode) return [];
        return providerGroup.models
          .filter(model => matchesCapability(providerGroup, model, capabilityMode))
          .map(model => ({ group: providerGroup, model }));
      }, [providerGroup, effectiveViewMode, viewMode, capabilityMode]);
      // 收藏集合：O(1) 判断 + 稳定引用，配合 memo 行组件减少列表重渲染。
      const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
      const favoriteRowsAll = useMemo(() => rowsForKeys(modelIndex, favorites), [modelIndex, favorites]);
      const recentRowsAll = useMemo(() => rowsForKeys(modelIndex, recents).filter(({ key }) => !favoriteSet.has(key)), [modelIndex, recents, favoriteSet]);
      // 最近使用/收藏同样过能力筛选（此前只滤了全部模型/厂家/搜索）。
      const favoriteRows = useMemo(() => favoriteRowsAll.filter(row => matchesCapability(row.group, row.model, capabilityMode)), [favoriteRowsAll, capabilityMode]);
      const recentRows = useMemo(() => recentRowsAll.filter(row => matchesCapability(row.group, row.model, capabilityMode)), [recentRowsAll, capabilityMode]);
      // 能力筛选跟着当前浏览范围的模型走：统计范围内真实存在的能力，
      // 点了会落空的选项不渲染（治“一点击就没得咯”）。
      // 范围按视图取：搜索=搜索结果；厂家=该厂家；最近/收藏=对应清单；其余=全目录。
      const capabilityScope = useMemo(() => {
        if (queryText !== '') return filterGroups(groups, query).flatMap(group => group.models.map(model => ({ group, model })));
        if (providerGroup) return providerGroup.models.map(model => ({ group: providerGroup, model }));
        if (effectiveViewMode === 'recent') return recentRowsAll;
        if (effectiveViewMode === 'favorites') return favoriteRowsAll;
        return groups.flatMap(group => group.models.map(model => ({ group, model })));
      }, [queryText, groups, query, providerGroup, effectiveViewMode, recentRowsAll, favoriteRowsAll]);
      const capAvailability = useMemo(() => {
        const availability = { free: false, vision: false, reasoning: false, tools: false };
        for (const { group, model } of capabilityScope) {
          if (isFreeModel(group, model)) availability.free = true;
          if (isVisionModel(group, model)) availability.vision = true;
          if (isReasoningModel(model)) availability.reasoning = true;
          if (hasToolsModel(model)) availability.tools = true;
        }
        return availability;
      }, [capabilityScope]);
      // 切换厂家/视图后，已失效的选中筛选自动复位，避免残留空列表。
      useEffect(() => {
        if (capabilityMode !== 'all' && !capAvailability[capabilityMode]) setCapabilityMode('all');
      }, [capabilityMode, capAvailability]);
      const capChipDefs = [
        ['all', 'all', t('filterAll'), true],
        ['free', 'free', t('filterFree'), capAvailability.free],
        ['vision', 'vision', t('filterVision'), capAvailability.vision],
        ['reasoning', 'reason', t('filterReasoning'), capAvailability.reasoning],
        ['tools', 'tools', t('filterTools'), capAvailability.tools],
      ].filter(([, , , available]) => available);
      // 失败来源的可见范围：全部模型全量；搜索只显示命中的；厂家 tab 只显示本厂家。
      const visibleFailures = queryText !== ''
        ? filteredFailures
        : showProviderGroups
          ? failures
          : providerId ? failures.filter(failure => failure.provider === providerId) : [];
      const effectiveCurrent = current ?? quickCurrent ?? null;
      const recommendationRows = useMemo(() => recommendedRows(groups, effectiveCurrent, recents, taskMode, modelIndex), [groups, effectiveCurrent, recents, taskMode, modelIndex]);
      const busy = state.status === 'selecting' || state.status === 'loading';
      const disabled = locked === true || available === false || !directory;

      const closeMenu = useCallback(() => {
        setOpen(false);
        Promise.resolve().then(() => triggerRef.current?.focus?.());
      }, []);

      const placeMenu = useCallback(() => {
        const rect = triggerRef.current?.getBoundingClientRect?.();
        if (!rect) return;
        const width = Math.min(640, Math.max(420, window.innerWidth - 24));
        setMenuPos({
          left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
          bottom: Math.max(12, window.innerHeight - rect.top + 8),
          width,
          maxHeight: Math.min(560, Math.max(320, window.innerHeight - 90)),
        });
      }, []);

      useEffect(() => {
        if (!open) return undefined;
        mark('menu open', directory ? summarizeState(directory.getSnapshot?.()) : { directory: null });
        placeMenu();
        setQuery('');
        setActionError(null);
        try {
          void load?.();
        } catch (error) {
          mark('directory load threw', String(error?.message ?? error));
        }
        const closeOutside = (event) => {
          if (rootRef.current?.contains(event.target) === true) return;
          if (menuRef.current?.contains(event.target) === true) return;
          closeMenu();
        };
        const closeEscape = (event) => { if (event.key === 'Escape') closeMenu(); };
        document.addEventListener('mousedown', closeOutside);
        document.addEventListener('keydown', closeEscape);
        window.addEventListener('resize', placeMenu);
        return () => {
          document.removeEventListener('mousedown', closeOutside);
          document.removeEventListener('keydown', closeEscape);
          window.removeEventListener('resize', placeMenu);
        };
      }, [open, load, placeMenu, closeMenu]);

      const toggleFavorite = useCallback((key) => {
        setFavorites(previous => {
          const next = previous.includes(key) ? previous.filter(item => item !== key) : [key, ...previous];
          storageSet(FAVORITES_KEY, next);
          return next;
        });
      }, []);

      const choose = useCallback(async (selection) => {
        // 只在真正「切换中」时拦截重复点击。离线（loading）状态下点击必须
        // 放行：select() 会先重试绑定，服务已恢复的话立刻就能选上。
        if (disabled || state.status === 'selecting') return;
        setActionError(null);
        mark('select attempt', selection);
        try {
          const selectStarted = performance.now();
          const ok = await select(selection);
          // 底层返回 false 只有一种含义：该会话不允许切换（子代理会话），
          // 或绑定尚未就绪。给出可读原因，不再抛无意义的英文占位错误。
          if (ok === false) throw new Error(t(available === false ? 'subagentLocked' : 'selectNotReady'));
          mark('select ok', { model: `${selection.provider}/${selection.model}`, tookMs: Math.round(performance.now() - selectStarted) });
          const key = modelKey(selection.provider, selection.model);
          setRecents(previous => {
            const next = [key, ...previous.filter(item => item !== key)].slice(0, MAX_RECENTS);
            storageSet(RECENTS_KEY, next);
            return next;
          });
          closeMenu();
        } catch (error) {
          mark('select failed', String(error?.message ?? error));
          setActionError(error instanceof Error ? error.message : String(error));
        }
      }, [disabled, select, state.status, closeMenu]);

      const chooseEffort = useCallback((effort) => {
        if (!currentChoice) return;
        void choose({
          provider: currentChoice.group.id,
          model: currentChoice.model.id,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        });
      }, [choose, currentChoice]);

      const setAllExpanded = (value) => {
        const next = {};
        for (const group of groups) next[group.id] = value;
        for (const failure of failures) next[`failed:${failure.provider}`] = value;
        setExpanded(next);
      };

      const handleMenuKeyDown = useCallback((event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const options = Array.from(menuRef.current?.querySelectorAll?.('[data-model-option="true"]:not(:disabled)') ?? []);
        if (options.length === 0) return;
        event.preventDefault();
        const currentIndex = options.indexOf(document.activeElement);
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = currentIndex < 0
          ? (direction > 0 ? 0 : options.length - 1)
          : (currentIndex + direction + options.length) % options.length;
        options[nextIndex]?.focus?.();
      }, []);

      const triggerText = currentModel
        ? modelLabel(currentModel)
        : effectiveCurrent?.model
          ? String(effectiveCurrent.model)
          : state.status === 'loading'
            ? (slowLoad ? t('loadingSlow') : t('loading'))
            : t('unavailable');
      const triggerCapabilities = currentChoice
        ? [
          isReasoningModel(currentChoice.model) ? { color: colors.accent, label: t('reasoning') } : null,
          isVisionModel(currentChoice.group, currentChoice.model) ? { color: '#b48cff', label: t('vision') } : null,
          hasToolsModel(currentChoice.model) ? { color: '#f5a524', label: t('tools') } : null,
        ].filter(Boolean)
        : [];
      // 子代理会话不允许换模型：按钮禁用并说明原因（原生选择器同样不可用）。
      const lockedBySubagent = available === false;
      const triggerTitle = lockedBySubagent
        ? t('subagentLocked')
        : current
          ? `${current.provider} / ${current.model}${triggerCapabilities.length > 0 ? ` · ${triggerCapabilities.map(cap => cap.label).join(' / ')}` : ''}`
          : t('unavailable');

      const trigger = React.createElement('button', {
        ref: triggerRef,
        type: 'button',
        disabled,
        onClick: () => setOpen(value => !value),
        title: triggerTitle,
        style: {
          // 严格保持原生 ModelSelect 的占位尺寸；其他输入栏插件会围绕它布局。
          display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0, position: 'relative',
          maxWidth: 'min(360px, 45cqw)', height: '28px',
          padding: '0 4px 0 8px', borderRadius: '24px', border: 'none', background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', fontWeight: 500, lineHeight: '20px',
          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
        },
      },
        React.createElement('span', {
          style: {
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'inherit',
          },
        }, triggerText),
        currentEffort
          ? React.createElement('span', {
            style: {
              minWidth: 0, flexShrink: 1000, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: 'var(--dsw-alias-label-caption)',
            },
          }, `· ${currentEffort}`)
          : null,
        React.createElement('span', {
          style: { color: 'var(--dsw-alias-label-caption)', fontSize: '10px', flex: 'none' },
        }, open ? '▴' : '▾'),
        triggerCapabilities.slice(0, 4).map((cap, index) => React.createElement('span', {
          key: cap.label,
          title: cap.label,
          style: {
            position: 'absolute', top: '3px', right: `${4 + index * 6}px`, width: '4px', height: '4px',
            borderRadius: '50%', background: cap.color, pointerEvents: 'none', boxShadow: `0 0 0 1px ${colors.panel2}`,
          },
        })),
      );

      const effortChoices = currentModel?.reasoning
        ? [
          ...(currentModel.reasoning.defaultEffort === undefined ? [{ id: undefined, name: t('providerDefault') }] : []),
          ...currentModel.reasoning.efforts,
        ]
        : [];
      const activeEffort = current?.reasoningEffort ?? currentModel?.reasoning?.defaultEffort;

      const menu = open && menuPos ? ReactDOM.createPortal(
        React.createElement('div', {
          ref: menuRef,
          role: 'dialog',
          'aria-modal': true,
          onKeyDown: handleMenuKeyDown,
          'aria-label': t('title'),
          style: {
            position: 'fixed', left: menuPos.left, bottom: menuPos.bottom, width: menuPos.width,
            // 高度固定为视口可用高度：筛选/切 tab 只改变列表内容，
            // 弹层本身不再忽高忽低（短列表内部留白即可）。
            height: `${menuPos.maxHeight}px`, maxHeight: menuPos.maxHeight,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: colors.panel2, border: `1px solid ${colors.border}`, borderRadius: '14px',
            boxShadow: '0 18px 60px rgba(0,0,0,.45)', color: colors.text, zIndex: 9999,
          },
        },
          React.createElement('div', { style: { padding: '12px', borderBottom: `1px solid ${colors.border}` } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
              React.createElement('div', { style: { fontSize: '14px', fontWeight: 700, flex: 1 } },
                t('title'),
                React.createElement('span', { style: { marginLeft: '6px', fontSize: '10px', color: colors.muted, fontWeight: 500 } }, `v${VERSION}`),
              ),
              React.createElement('button', {
                type: 'button', onClick: closeMenu, 'aria-label': t('close'),
                style: { border: 'none', background: 'transparent', color: colors.muted, cursor: 'pointer', fontSize: '11px' },
              }, t('close')),
            ),
            React.createElement('input', {
              autoFocus: true,
              type: 'search',
              value: query,
              'aria-label': t('search'),
              placeholder: t('search'),
              onChange: event => setQuery(event.target.value),
              style: {
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '9px',
                border: `1px solid ${colors.border}`, background: colors.panel, color: colors.text,
                outline: 'none', fontSize: '13px',
              },
            }),
            React.createElement('div', { role: 'tablist', style: { display: 'flex', gap: '4px', marginTop: '10px', borderBottom: `1px solid ${colors.border}`, flexWrap: 'wrap' } },
              [
                ['recommend', t('recommend'), null], ['recent', t('recentModels'), null], ['favorites', t('favoriteModels'), null], ['all', t('allModels'), null],
                // 全部模型之后：每个厂家各一个 tab，附带模型计数。
                ...groups.map(group => [`provider:${group.id}`, String(group.name ?? group.id), group.models.length]),
              ].map(([mode, label, count]) => React.createElement('button', {
                key: mode, type: 'button', role: 'tab', 'aria-selected': viewMode === mode, onClick: () => setViewMode(mode),
                style: { padding: '5px 8px', border: 'none', borderBottom: `2px solid ${viewMode === mode ? colors.accent : 'transparent'}`, background: 'transparent', color: viewMode === mode ? colors.text : colors.muted, cursor: 'pointer', fontSize: '11px', fontWeight: viewMode === mode ? 650 : 400, whiteSpace: 'nowrap' },
              },
                label,
                count === null ? null : React.createElement('span', {
                  'data-count': count,
                  style: {
                    display: 'inline-block', marginLeft: '4px', padding: '0 5px', borderRadius: '8px',
                    background: viewMode === mode ? tint(colors.accent, 18) : colors.panel,
                    color: viewMode === mode ? colors.accent : colors.muted, fontSize: '10px', lineHeight: '15px', fontWeight: 400,
                  },
                }, count),
              )),
            ),
          ),

          currentChoice ? React.createElement('div', {
            style: { padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, background: colors.panel },
          },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', { style: { fontSize: '11px', color: colors.muted, fontWeight: 700 } }, t('current')),
              React.createElement('span', { style: { fontSize: '13px', fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, modelLabel(currentChoice.model)),
              React.createElement('span', { style: { fontSize: '11px', color: colors.muted } }, currentChoice.group.name),
              React.createElement('button', {
                type: 'button', onClick: () => setViewMode('all'),
                style: { marginLeft: 'auto', padding: '3px 8px', borderRadius: '6px', border: `1px solid ${colors.accent}`, background: tint(colors.accent, 9), color: colors.accent, cursor: 'pointer', fontSize: '11px' },
              }, t('changeModel')),
            ),
            effortChoices.length > 0 ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
              React.createElement('span', { style: { fontSize: '11px', color: colors.muted } }, t('effort')),
              effortChoices.map(effort => {
                const active = effort.id === undefined ? activeEffort === undefined : effort.id === activeEffort;
                return React.createElement('button', {
                  key: effort.id ?? 'default',
                  type: 'button',
                  onClick: () => chooseEffort(effort.id),
                  style: {
                    padding: '3px 8px', borderRadius: '999px', fontSize: '11px', cursor: 'pointer',
                    border: `1px solid ${active ? colors.accent : colors.border}`,
                    background: active ? colors.accent : 'transparent',
                    color: active ? colors.accentFg : colors.muted,
                  },
                }, effort.name);
              }),
            ) : null,
          ) : quickCurrent
            // 最小当前卡：远端目录挂掉时，本地投影依然知道当前模型。
            ? React.createElement('div', {
              style: { padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, background: colors.panel },
            },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                React.createElement('span', { style: { fontSize: '11px', color: colors.muted, fontWeight: 700 } }, t('current')),
                React.createElement('span', { style: { fontSize: '13px', fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(quickCurrent.model)),
                React.createElement('span', { style: { fontSize: '11px', color: colors.muted } }, String(quickCurrent.provider ?? '')),
                React.createElement('button', {
                  type: 'button', onClick: () => setViewMode('all'),
                  style: { marginLeft: 'auto', padding: '3px 8px', borderRadius: '6px', border: `1px solid ${colors.accent}`, background: tint(colors.accent, 9), color: colors.accent, cursor: 'pointer', fontSize: '11px' },
                }, t('changeModel')),
              ),
            )
            : null,

          React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '10px 8px' } },
            state.status === 'error'
              ? React.createElement('div', { style: { padding: '14px', color: colors.danger, fontSize: '13px' } },
                fill(t('loadFailed'), { message: state.error ?? 'unknown' }),
                React.createElement('button', {
                  type: 'button', onClick: () => void load?.(),
                  style: { marginTop: '8px', padding: '5px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, cursor: 'pointer' },
                }, t('retry')),
              )
              : null,
            actionError
              ? React.createElement('div', { style: { margin: '0 4px 8px', padding: '8px 10px', borderRadius: '8px', color: colors.danger, border: `1px solid ${colors.danger}`, fontSize: '12px' } },
                fill(t('selectFailed'), { message: actionError }),
              )
              : null,
            // 能力筛选放在 tab 内容区里：只作用于下方列表，推荐页不显示
            // （任务胶囊本身就是筛选）。选项按当前视图的模型能力动态生成，
            // 只剩「全部」时整行隐藏。
            (effectiveViewMode !== 'recommend' || queryText !== '') && capChipDefs.length > 1
              ? React.createElement('div', { style: { display: 'flex', gap: '6px', margin: '0 2px 8px', flexWrap: 'wrap' } },
                capChipDefs.map(([mode, icon, label]) => React.createElement('button', {
                  key: mode,
                  type: 'button',
                  onClick: () => setCapabilityMode(mode),
                  'aria-pressed': capabilityMode === mode,
                  style: {
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    padding: '3px 10px', borderRadius: '999px', fontSize: '11px', cursor: 'pointer',
                    border: `1px solid ${capabilityMode === mode ? colors.accent : colors.border}`,
                    background: capabilityMode === mode ? colors.accent : 'transparent',
                    color: capabilityMode === mode ? colors.accentFg : colors.muted,
                  },
                }, React.createElement(CapIcon, { name: icon }), label)),
              )
              : null,
            groups.length === 0 && state.status === 'loading'
              ? slowLoad
                ? React.createElement('div', { style: { margin: '6px 4px', padding: '14px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: 'rgba(245,165,36,.05)' } },
                  React.createElement('div', { style: { fontSize: '13px', fontWeight: 650, color: colors.text, marginBottom: '5px' } }, t('loadSlowTitle')),
                  React.createElement('div', { style: { fontSize: '11.5px', color: colors.muted, lineHeight: 1.6 } }, t('loadSlowHint')),
                  React.createElement('button', {
                    type: 'button', onClick: () => { setSlowLoad(false); void load?.(); },
                    style: { marginTop: '9px', padding: '5px 10px', borderRadius: '7px', border: `1px solid ${colors.accent}`, background: tint(colors.accent, 9), color: colors.accent, cursor: 'pointer', fontSize: '12px' },
                  }, t('retry')),
                )
                : React.createElement('div', { style: { padding: '18px', color: colors.muted, fontSize: '13px' } }, t('loading'))
              : null,
            groups.length > 0 && query.trim() === '' && viewMode === 'recommend' ? React.createElement(React.Fragment, null,
              React.createElement('div', { style: { fontSize: '12px', fontWeight: 700, color: colors.text, margin: '3px 2px 8px' } }, t('taskPrompt')),
              React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '0 2px 10px' } },
                [['code', t('taskCode')], ['vision', t('taskVision')], ['reasoning', t('taskReasoning')], ['fast', t('taskFast')], ['free', t('taskFree')]].map(([task, label]) => React.createElement('button', {
                  key: task, type: 'button', onClick: () => setTaskMode(task), 'aria-pressed': taskMode === task,
                  style: { padding: '4px 8px', borderRadius: '999px', border: `1px solid ${taskMode === task ? colors.accent : colors.border}`, background: taskMode === task ? colors.accent : 'transparent', color: taskMode === task ? colors.accentFg : colors.muted, cursor: 'pointer', fontSize: '11px' },
                }, label)),
              ),
              // 推荐理由说明条：一行瘦条，不再每行重复。
              React.createElement('div', { style: { fontSize: '11px', color: colors.muted, padding: '3px 9px', borderLeft: '2px solid #f5a524', margin: '0 2px 8px' } }, recommendationReason(taskMode, t)),
              React.createElement('div', { style: { fontSize: '11px', fontWeight: 700, color: colors.muted, margin: '2px 0 6px' } }, t('recommended')),
              recommendationRows.length > 0
                ? recommendationRows.map(row => React.createElement(RecommendationRow, { key: modelKey(row.group.id, row.model.id), row, current, favoriteSet, toggleFavorite, choose, busy, task: taskMode, t }))
                : React.createElement('div', { style: { padding: '18px 4px', color: colors.muted, fontSize: '12px' } }, t('noTaskResults')),
              React.createElement('button', { type: 'button', onClick: () => setViewMode('all'), style: { display: 'block', margin: '4px auto 10px', border: 'none', background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: '11px' } }, `${t('viewAll')} →`),
            ) : null,
            groups.length > 0 && query.trim() === '' && viewMode === 'recent' ? React.createElement(ModelSection, { title: t('recent'), rows: recentRows, current, favoriteSet, toggleFavorite, choose, t }) : null,
            groups.length > 0 && query.trim() === '' && viewMode === 'favorites' ? React.createElement(ModelSection, { title: t('favorites'), rows: favoriteRows, current, favoriteSet, toggleFavorite, choose, t }) : null,
            // 「全部来源」标题行：收起/展开只作用于分组视图，跟随内容区
            // （此前挂在全局头部，在厂家 tab 等无分组的视图里是摆设）。
            showProviderGroups ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', margin: '10px 0 5px 2px' } },
              React.createElement('span', { style: { fontSize: '11px', fontWeight: 700, color: colors.muted, flex: 1 } }, t('providers')),
              filteredGroups.length > 1
                ? React.createElement('button', {
                  type: 'button', onClick: () => setAllExpanded(false),
                  style: { border: 'none', background: 'transparent', color: colors.muted, cursor: 'pointer', fontSize: '11px', padding: '2px 4px' },
                }, t('collapseAll'))
                : null,
              filteredGroups.length > 1
                ? React.createElement('button', {
                  type: 'button', onClick: () => setAllExpanded(true),
                  style: { border: 'none', background: 'transparent', color: colors.muted, cursor: 'pointer', fontSize: '11px', padding: '2px 4px' },
                }, t('expandAll'))
                : null,
            ) : null,
            showProviderGroups ? filteredGroups.map(group => {
              const isCurrentGroup = current?.provider === group.id;
              const isExpanded = query.trim() !== '' || expanded[group.id] === true || (expanded[group.id] !== false && isCurrentGroup);
              return React.createElement('div', { key: group.id, style: { marginBottom: '6px', contentVisibility: 'auto', containIntrinsicSize: 'auto 240px' } },
                React.createElement('button', {
                  type: 'button',
                  'aria-expanded': isExpanded,
                  onClick: () => setExpanded(previous => ({ ...previous, [group.id]: !isExpanded })),
                  style: {
                    width: '100%', display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 8px',
                    border: 'none', borderRadius: '8px', background: isCurrentGroup ? tint(colors.accent, 8) : 'transparent',
                    color: colors.text, cursor: 'pointer', textAlign: 'left',
                  },
                },
                  React.createElement('span', { style: { color: colors.muted, fontSize: '10px', width: '12px' } }, isExpanded ? '▾' : '▸'),
                  React.createElement(ProviderBadge, { group, size: 20 }),
                  React.createElement('span', { style: { flex: 1, fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.name),
                  React.createElement('span', { style: { fontSize: '11px', color: colors.muted } }, fill(t('modelsCount'), { count: group.models.length })),
                ),
                isExpanded
                  ? React.createElement('div', { style: { marginTop: '2px' } },
                    group.models.map(model => {
                      const key = modelKey(group.id, model.id);
                      return React.createElement(ModelRow, {
                        key,
                        group,
                        model,
                        current,
                        favoriteKey: key,
                        favorite: favoriteSet.has(key),
                        onFavorite: toggleFavorite,
                        onSelect: choose,
                        t,
                      });
                    }),
                  )
                  : null,
              );
            }) : null,
            // 搜索：跨厂家平铺列表，行内标注厂家归属。
            showFlatList && flatRows.length > 0
              ? React.createElement('div', { style: { contentVisibility: 'auto', containIntrinsicSize: 'auto 600px' } },
                flatRows.map(({ group, model }) => {
                  const key = modelKey(group.id, model.id);
                  return React.createElement(ModelRow, {
                    key,
                    group,
                    model,
                    current,
                    favoriteKey: key,
                    favorite: favoriteSet.has(key),
                    onFavorite: toggleFavorite,
                    onSelect: choose,
                    showProvider: true,
                    showProviderBadge: true,
                    t,
                  });
                }),
              )
              : null,
            // 厂家 tab：只平铺该厂家的模型（不重复标注厂家名）。
            providerRows.length > 0 && queryText === ''
              ? React.createElement('div', null,
                providerRows.map(({ group, model }) => {
                  const key = modelKey(group.id, model.id);
                  return React.createElement(ModelRow, {
                    key,
                    group,
                    model,
                    current,
                    favoriteKey: key,
                    favorite: favoriteSet.has(key),
                    onFavorite: toggleFavorite,
                    onSelect: choose,
                    showProviderBadge: true,
                    t,
                  });
                }),
              )
              : null,
            // 空态按当前浏览上下文判断：搜索平铺空 / 全部模型分组空 /
            // 厂家 tab 被能力筛选筛空——任何一种都要明说，不留空白。
            (groups.length > 0 || failures.length > 0) && visibleFailures.length === 0 && (
              (showFlatList && flatRows.length === 0)
              || (showProviderGroups && filteredGroups.length === 0)
              || (providerGroup !== null && queryText === '' && providerRows.length === 0)
            )
              ? React.createElement('div', { style: { padding: '18px', color: colors.muted, fontSize: '13px' } }, t('noResults'))
              : null,
            // 失败的来源也列在清单里：状态标在行上，点开看错误详情 + 重试，
            // 不再整组消失（只剩页脚一行小字）。
            visibleFailures.length > 0
              ? visibleFailures.map((failure) => {
                const failureKey = `failed:${failure.provider}`;
                const isExpanded = expanded[failureKey] === true;
                return React.createElement('div', { key: failureKey, style: { marginBottom: '6px' } },
                  React.createElement('button', {
                    type: 'button',
                    'aria-expanded': isExpanded,
                    onClick: () => setExpanded(previous => ({ ...previous, [failureKey]: !isExpanded })),
                    style: {
                      width: '100%', display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 8px',
                      border: 'none', borderRadius: '8px', background: 'rgba(255,77,79,.06)',
                      color: colors.text, cursor: 'pointer', textAlign: 'left',
                    },
                  },
                    React.createElement('span', { style: { color: colors.muted, fontSize: '10px', width: '12px' } }, isExpanded ? '▾' : '▸'),
                    React.createElement('span', { style: { flex: 1, fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(failure.provider)),
                    React.createElement('span', { style: { fontSize: '11px', color: colors.danger, fontWeight: 650 } }, `⚠ ${t('sourceFailed')}`),
                  ),
                  isExpanded
                    ? React.createElement('div', { style: { margin: '2px 4px 4px', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${colors.border}`, fontSize: '11.5px', color: colors.muted, lineHeight: 1.6 } },
                      String(failure.error ?? 'unknown'),
                      React.createElement('button', {
                        type: 'button', onClick: () => void load?.(),
                        style: { marginLeft: '8px', padding: '3px 8px', borderRadius: '6px', border: `1px solid ${colors.accent}`, background: tint(colors.accent, 9), color: colors.accent, cursor: 'pointer', fontSize: '11px' },
                      }, t('retry')),
                    )
                    : null,
                );
              })
              : null,
          ),
          React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '7px 12px', borderTop: `1px solid ${colors.border}`, color: colors.muted, fontSize: '10.5px' },
          },
            React.createElement('span', null, t('keyboardNavigate')),
            React.createElement('span', null, t('keyboardUse')),
            React.createElement('span', null, t('keyboardClose')),
          ),
        ),
        document.body,
      ) : null;

      return React.createElement('div', {
        ref: rootRef,
        style: { minWidth: 0, position: 'relative' },
      }, trigger, menu);
    }

    const name = 'model-picker-plus-client';
    const inject = ['slots', 'locale', 'modelDirectories', 'sessions'];

    function apply(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      if (locale && typeof locale.register === 'function') {
        localeSvc = locale;
        ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }));
      } else {
        localeSvc = undefined;
      }

      if (typeof ctx.inject !== 'function') return;
      ctx.inject(['slots', 'modelDirectories', 'sessions'], (scope) => {
        const slots = scope.slots;
        const modelDirectories = scope.modelDirectories;
        const sessions = scope.sessions;
        if (!slots || typeof slots.inject !== 'function' || !modelDirectories || !sessions) {
          mark('service scope incomplete', {
            slots: Boolean(slots), modelDirectories: Boolean(modelDirectories), sessions: Boolean(sessions),
          });
          return;
        }
        slots.inject('conversation.input.model', () => slots.register(
          {
            name: 'conversation.input.model',
            // 单槽位通过优先级覆盖：原生项为隐式 0，本插件用 -1 抢占；
            // 卸载后原生选择器自动恢复，无需手动删除。
            priority: -1,
            locale: NS,
            inject: (sessionId) => {
              // 懒绑定 + 自愈重试：directoryFor 在运行时重载 / Provider 插件
              // 被关闭时抛 remote.session 错，只绑一次会永久卡死。改为先给
              // 代理 store，探测成功再接管；失败最多记 3 条探针日志（不是
              // 崩溃），每 5 秒静默重试。路径：resolver（新鲜取件）→ 应急目录。
              let real = null;       // 绑定成功后的真实目录
              let available = true;  // 寻址子代理会话为 false（不允许换模型）
              let attempts = 0;       // 失败探测计数（用于日志封顶）
              let fallbackVia = null; // 应急目录的 RPC 来源（诊断用）
              let disposed = false;
              let retryTimer = null;
              let idleDisposeTimer = null;
              let realUnsubscribe = null;
              let selectionUnsubscribe = null;
              const listeners = new Set();

              // 未绑定时的兜底快照：与「目录仍在加载」等价，界面走降级而不是崩溃。
              const fallbackSnapshot = () => ({ current: null, groups: [], failures: [], status: 'loading', error: null });

              // 广播 store 更新；单个监听器异常不影响其他。
              const notify = () => {
                if (disposed) return;
                for (const listener of [...listeners]) {
                  try { listener(); } catch { /* 监听器异常不能打断广播 */ }
                }
              };

              // 子代理会话不允许换模型；该检查在运行时重载期间可能抛错——
              // 宁可假定可用，也不能让它把选择器一起拖死。
              const computeAvailable = () => {
                try {
                  available = sessions.subagentAddress(sessionId) === undefined;
                } catch (error) {
                  available = true;
                  if (attempts === 0) mark('inject: subagentAddress failed, assuming available', { sessionId, error: String(error?.message ?? error) });
                }
              };

              // 新鲜取件：热重载可能换掉 modelDirectories 实例，apply 时
              // 捕获的引用也许是死掉的旧实例——每次探测先要最新的。
              const resolveDirectories = () => {
                try {
                  if (typeof ctx.get === 'function') {
                    const fresh = ctx.get('modelDirectories');
                    if (fresh && typeof fresh.directoryFor === 'function') return fresh;
                  }
                } catch { /* 取不到就用捕获的引用兜底 */ }
                return modelDirectories;
              };

              // 应急目录的 RPC 客户端来源，按存活概率排序：
              //   1. 搭便车：sessions 服务为聊天功能捕获的客户端，就挂在
              //      会话对象的普通属性 .remote 上（聊天正常＝它活着）；
              //   2. ctx.get('remote.session')：直接拿会话命名空间；
              //   3. ctx.get('remote')：Cordis 服务取件。
              let fallback = null;
              const resolveFallback = () => {
                if (fallback) return fallback;
                const candidates = [];
                try { candidates.push({ via: 'session.remote', remote: sessions.binding(sessionId)?.session?.remote }); } catch { /* 忽略 */ }
                try {
                  const ns = typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined;
                  if (ns) candidates.push({ via: 'ctx.get(remote.session)', remote: { session: ns } });
                } catch { /* 忽略 */ }
                try { candidates.push({ via: 'ctx.get(remote)', remote: typeof ctx.get === 'function' ? ctx.get('remote') : undefined }); } catch { /* 忽略 */ }
                for (const { via, remote } of candidates) {
                  if (typeof remote?.session?.modelCatalog === 'function' && typeof remote?.session?.selectModel === 'function') {
                    fallbackVia = via;
                    fallback = createFallbackDirectory(remote, sessions, sessionId);
                    return fallback;
                  }
                }
                return null;
              };

              // 同一模块世代只预热一次，避免每个会话重复请求目录。
              const warmup = () => {
                if (disposed || directoryWarmupStarted || typeof real?.load !== 'function') return;
                directoryWarmupStarted = true;
                try {
                  Promise.resolve(real.load()).then(
                    () => mark('directory warmup ok'),
                    (error) => {
                      directoryWarmupStarted = false;
                      mark('directory warmup failed', String(error?.message ?? error));
                    },
                  );
                } catch {
                  directoryWarmupStarted = false;
                }
              };

              // 单次绑定探测（幂等，绑上即短路）。探测是纯本地 try/catch，
              // 网络请求只有目录 RPC，已由共享目录全会话去重。
              const tryBind = () => {
                if (disposed) return false;
                if (real) return true;
                let probeError = null;
                try {
                  const candidate = resolveDirectories().directoryFor(sessionId);
                  if (candidate?.store) {
                    real = candidate;
                    computeAvailable();
                    try {
                      const unsubscribe = candidate.store.subscribe?.(notify);
                      if (typeof unsubscribe === 'function') realUnsubscribe = unsubscribe;
                    } catch { /* 忽略订阅失败 */ }
                    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
                    mark(attempts === 0 ? 'inject ok' : 'inject bound after retry', { sessionId, available, attempts });
                    notify();
                    warmup();
                    return true;
                  }
                } catch (error) {
                  probeError = error;
                }
                const candidate = resolveFallback();
                if (candidate?.store) {
                  real = candidate;
                  computeAvailable();
                  try {
                    const unsubscribe = candidate.store.subscribe?.(notify);
                    if (typeof unsubscribe === 'function') realUnsubscribe = unsubscribe;
                  } catch { /* 忽略订阅失败 */ }
                  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
                  mark('inject bound via fallback directory (bypassed dead resolver)', { sessionId, available, attempts, via: fallbackVia });
                  notify();
                  warmup();
                  return true;
                }
                attempts += 1;
                if (attempts <= 3) {
                  mark('inject: directoryFor probe failed (service down, will retry)', {
                    sessionId,
                    error: String(probeError?.message ?? probeError ?? 'directory unavailable'),
                    fallbackAvailable: candidate !== null,
                  });
                }
                return false;
              };

              // 先探一次；失败则每 5 秒再探，绑定成功或控制器销毁后停止。
              const scheduleRetry = () => {
                if (disposed || real || retryTimer !== null) return;
                retryTimer = setTimeout(() => {
                  retryTimer = null;
                  if (!tryBind()) scheduleRetry();
                }, 5000);
                retryTimer.unref?.();
              };
              if (!tryBind()) scheduleRetry();

              // store 门面：绑定后返回真实快照，否则返回兜底；订阅先收集，绑定后转发。
              const storeProxy = {
                getSnapshot: () => real?.store?.getSnapshot?.() ?? fallbackSnapshot(),
                subscribe: (listener) => {
                  if (disposed) return () => {};
                  if (idleDisposeTimer !== null) { clearTimeout(idleDisposeTimer); idleDisposeTimer = null; }
                  listeners.add(listener);
                  let active = true;
                  return () => {
                    if (!active) return;
                    active = false;
                    listeners.delete(listener);
                    if (listeners.size === 0 && idleDisposeTimer === null) {
                      // 延迟一个任务：StrictMode 立即重订阅时取消销毁，真正卸载才释放。
                      idleDisposeTimer = setTimeout(() => {
                        idleDisposeTimer = null;
                        if (listeners.size === 0) dispose();
                      }, 0);
                    }
                  };
                },
              };

              // 快速通道：当前模型在本地投影里（DSH 算法也是
              // current = 投影 ?? catalog.default），零网络秒显触发器。
              let selectionFace = null;
              try {
                selectionFace = sessions.binding(sessionId)?.session?.projections?.faceOf?.('modelSelection') ?? null;
                if (selectionFace) try {
                  const unsubscribe = selectionFace.subscribe?.(notify);
                  if (typeof unsubscribe === 'function') selectionUnsubscribe = unsubscribe;
                } catch { /* 忽略订阅失败 */ }
              } catch { /* 快速通道是可选优化——代理 store 依然兜底 */ }

              const dispose = () => {
                if (disposed) return;
                disposed = true;
                if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
                if (idleDisposeTimer !== null) { clearTimeout(idleDisposeTimer); idleDisposeTimer = null; }
                try { realUnsubscribe?.(); } catch { /* 清理失败不影响其他资源 */ }
                try { selectionUnsubscribe?.(); } catch { /* 清理失败不影响其他资源 */ }
                try { real?.dispose?.(); } catch { /* 应急目录清理失败忽略 */ }
                realUnsubscribe = null;
                selectionUnsubscribe = null;
                listeners.clear();
              };

              // 关键：inject 阶段同步判定一次可用性（原生实现同样在 inject 里算），
              // 否则子代理会话会先渲染出可点击的选择器，点击后才被 select 门卫拒绝，
              // 界面又因状态翻转变成"点了没反应"。
              computeAvailable();

              return {
                // 取值器：绑定自愈后每次渲染读到最新值。
                get available() { return available; },
                // 本地投影里的当前选择；face 不可用时为 null。
                get quickCurrent() {
                  try {
                    return selectionFace?.getSnapshot?.()?.next ?? null;
                  } catch {
                    return null;
                  }
                },
                directory: storeProxy,
                dispose,
                // 返回 Promise：组件照常 void 掉，测试/调用方可精确等待。
                load: () => {
                  if (disposed || !tryBind() || !available) return Promise.resolve(false);
                  const started = performance.now();
                  mark('directory load start');
                  return real.load().then(
                    () => {
                      mark('directory load ok', { tookMs: Math.round(performance.now() - started) });
                      return true;
                    },
                    (error) => {
                      mark('directory load failed', { tookMs: Math.round(performance.now() - started), error: String(error?.message ?? error) });
                      return false;
                    },
                  );
                },
                select: async (selection) => {
                  if (disposed || !tryBind() || !available) return false;
                  await real.select(selection); // 保留底层具体错误，交给界面显示。
                  return true;
                },
              };
            },
          },
          ModelPickerPlus,
        ));
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.__test = {
      modelKey,
      splitModelKey,
      selectionFor,
      findChoice,
      filterGroups,
      createModelIndex,
      rowsForKeys,
      effortLabel,
      isDistinctText,
      isVisionModel,
      isReasoningModel,
      hasToolsModel,
      isOmniModel,
      declaredInputModalities,
      isFreeModel,
      pricingDeclaresFree,
      lookupModelMetadata,
      ensureRuntimeMetadata,
      mergeRuntimeMetadata,
      BRAND_LOGOS,
      matchesCapability,
      resolveBrandKey,
      taskMatches,
      recommendedRows,
      createFallbackDirectory,
      resetResilienceState,
      setCatalogRpcTimeout: (ms) => { catalogRpcTimeoutMs = ms; },
      setCatalogSwr: (ms) => { catalogSwrMs = ms; },
      DICT,
    };
    return exports;
  },
});
