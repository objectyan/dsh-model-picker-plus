/* global window, document, localStorage */
// client.js — replace DSH's flat composer model selector with a grouped model library.
//
// The plugin deliberately reuses the shipped modelDirectories service and
// sessions.selectModel. It changes presentation only: provider grouping,
// search, favorites, recents, and effort chips. Provider plugins remain the
// source of truth for catalogs and selection.
window.__ModuleLoader__.load({
  id: 'dsh-model-picker-plus',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const ReactDOM = require('react-dom');
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const NS = 'model-picker-plus';
    const VERSION = '0.2.5';
    const RECENTS_KEY = 'dsh-model-picker-plus:recents';
    const FAVORITES_KEY = 'dsh-model-picker-plus:favorites';
    const HEALTH_KEY = 'dsh-model-health:test-results';
    const MAX_RECENTS = 8;

    let localeSvc;
    const translate = (key) => {
      if (localeSvc && typeof localeSvc.bind === 'function') return localeSvc.bind(NS)(key);
      return DICT.zh[key] || key;
    };

    const DICT = {
      zh: {
        loading: '加载模型…',
        unavailable: '模型不可用',
        search: '搜索模型、Provider、用途…',
        title: '模型库',
        current: '当前',
        effort: '思考强度',
        providerDefault: '默认',
        favorites: '收藏',
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
        healthOk: '{latency}ms',
        healthFail: '失败',
        healthSkip: '跳过',
        failures: '{count} 个来源加载失败',
        collapseAll: '全部收起',
        expandAll: '全部展开',
      },
      en: {
        loading: 'Loading models…',
        unavailable: 'Models unavailable',
        search: 'Search models, providers, use cases…',
        title: 'Model library',
        current: 'Current',
        effort: 'Reasoning effort',
        providerDefault: 'Default',
        favorites: 'Favorites',
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
        healthOk: '{latency}ms',
        healthFail: 'Failed',
        healthSkip: 'Skipped',
        failures: '{count} providers failed to load',
        collapseAll: 'Collapse all',
        expandAll: 'Expand all',
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
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
    }

    function loadHealthResults() {
      const parsed = storageGet(HEALTH_KEY, {});
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }

    const healthKey = (provider, model) => `${provider}/${model}`;
    const healthFor = (map, provider, model) => map[healthKey(provider, model)]
      ?? map[healthKey(provider.replace(/^free-/, ''), model)];

    async function loadFreeHubHealth() {
      try {
        const payload = await fetch('/api-free-models/health', { headers: { accept: 'application/json' } }).then(r => r.json());
        return payload && payload.ok === true && payload.results && typeof payload.results === 'object'
          ? payload.results
          : {};
      } catch {
        return {};
      }
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

    function rowsForKeys(groups, keys) {
      const rows = [];
      const seen = new Set();
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const parsed = splitModelKey(key);
        if (!parsed) continue;
        const choice = findChoice(groups, parsed);
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

    function isVisionModel(group, model) {
      return /vision|modlens|image/i.test(`${group.name} ${group.id} ${model.name} ${model.id} ${model.description ?? ''}`);
    }

    function isReasoningModel(model) {
      return model.reasoning !== undefined || /reasoning|efforts?:/i.test(String(model.description ?? ''));
    }

    function hasToolsModel(model) {
      return /(?:^|\W)tools?(?:\W|$)|tool_call|function calling/i.test(String(model.description ?? ''));
    }

    function isOmniModel(model) {
      return /audio|video|omni|multimodal/i.test(String(model.description ?? ''));
    }

    function matchesCapability(group, model, mode) {
      if (mode === 'free') return group.id.startsWith('free-');
      if (mode === 'vision') return isVisionModel(group, model);
      if (mode === 'reasoning') return isReasoningModel(model);
      if (mode === 'tools') return hasToolsModel(model);
      return true;
    }

    const colors = {
      text: 'var(--dsh-color-foreground, #e6e6e6)',
      muted: 'var(--dsh-color-muted-foreground, #9a9a9a)',
      border: 'var(--dsh-color-border, #333)',
      panel: 'var(--dsh-color-card, #1c1c1c)',
      panel2: 'var(--dsh-color-popover, #242424)',
      accent: 'var(--dsh-color-primary, #4c8bf5)',
      accentFg: 'var(--dsh-color-primary-foreground, #fff)',
      danger: 'var(--dsh-color-destructive, #e05252)',
      ok: 'var(--dsh-color-success, #3fa95b)',
    };

    function Badge({ children, tone }) {
      const color = tone === 'free' ? colors.ok
        : tone === 'vision' ? '#b48cff'
          : tone === 'tools' ? '#f5a524'
            : tone === 'omni' ? '#35c2c1'
              : colors.accent;
      return React.createElement('span', {
        style: {
          flex: 'none', fontSize: '10px', lineHeight: '16px', padding: '0 5px', borderRadius: '999px',
          color, border: `1px solid ${color}`, opacity: 0.9,
        },
      }, children);
    }

    function ModelRow({ group, model, current, favorite, health, onFavorite, onSelect, t }) {
      const selected = current?.provider === group.id && current?.model === model.id;
      const distinctName = isDistinctText(model.name, model.id);
      const distinctDescription = isDistinctText(model.description, model.name, model.id);
      return React.createElement('div', {
        role: 'button',
        tabIndex: 0,
        onClick: () => onSelect(selectionFor(group, model, current)),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(selectionFor(group, model, current)); },
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 9px', borderRadius: '9px',
          cursor: 'pointer', background: selected ? 'var(--dsh-color-accent, rgba(76,139,245,.13))' : 'transparent',
        },
      },
        React.createElement('button', {
          type: 'button',
          title: favorite ? 'unfavorite' : 'favorite',
          onClick: (event) => { event.stopPropagation(); onFavorite(); },
          style: {
            width: '24px', height: '24px', border: 'none', background: 'transparent', cursor: 'pointer',
            color: favorite ? '#f5c542' : colors.muted, fontSize: '15px', padding: 0,
          },
        }, favorite ? '★' : '☆'),
        health?.status
          ? React.createElement('span', {
            title: health.error ?? health.status,
            style: {
              width: '7px', height: '7px', borderRadius: '50%', flex: 'none',
              background: health.status === 'ok' ? colors.ok : health.status === 'fail' ? colors.danger : colors.muted,
              boxShadow: health.status === 'testing' ? `0 0 0 3px ${colors.accent}33` : 'none',
            },
          })
          : null,
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', {
            style: {
              color: selected ? colors.text : colors.text, fontSize: '13px', fontWeight: selected ? 650 : 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, modelLabel(model)),
          distinctName
            ? React.createElement('div', {
              style: {
                color: colors.muted, fontSize: '11px', marginTop: '1px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, model.id)
            : null,
          distinctDescription
            ? React.createElement('div', {
              style: {
                color: colors.muted, fontSize: '11px', marginTop: '2px', lineHeight: 1.35,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, model.description)
            : null,
        ),
        health?.status === 'ok' && typeof health.latency === 'number'
          ? React.createElement('span', { style: { color: colors.muted, fontSize: '10px', flex: 'none', fontVariantNumeric: 'tabular-nums' } }, fill(t('healthOk'), { latency: Math.round(health.latency) }))
          : null,
        group.id.startsWith('free-') ? React.createElement(Badge, { tone: 'free' }, t('free')) : null,
        isVisionModel(group, model) ? React.createElement(Badge, { tone: 'vision' }, t('vision')) : null,
        isOmniModel(model) ? React.createElement(Badge, { tone: 'omni' }, t('omni')) : null,
        isReasoningModel(model) ? React.createElement(Badge, null, t('reasoning')) : null,
        hasToolsModel(model) ? React.createElement(Badge, { tone: 'tools' }, t('tools')) : null,
      );
    }

    function ModelSection({ title, rows, current, favorites, healthMap, toggleFavorite, choose, t }) {
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
            favorite: favorites.includes(key),
            health: healthFor(healthMap, group.id, model.id),
            onFavorite: () => toggleFavorite(key),
            onSelect: choose,
            t,
          });
        }),
      );
    }

    function ModelPickerPlus({ locked, available, directory, load, select }) {
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
      const [healthMap, setHealthMap] = useState(() => loadHealthResults());

      useEffect(() => {
        if (!directory || typeof directory.subscribe !== 'function') return undefined;
        const update = () => setState(directory.getSnapshot());
        update();
        return directory.subscribe(update);
      }, [directory]);

      const groups = state.groups ?? [];
      const current = state.current ?? null;
      const currentChoice = findChoice(groups, current);
      const currentModel = currentChoice?.model;
      const currentEffort = effortLabel(currentModel, current, t);
      const filteredGroups = useMemo(() => filterGroups(groups, query)
        .map(group => ({
          ...group,
          models: group.models.filter(model => matchesCapability(group, model, capabilityMode)),
        }))
        .filter(group => group.models.length > 0), [groups, query, capabilityMode]);
      const favoriteRows = useMemo(() => rowsForKeys(groups, favorites), [groups, favorites]);
      const recentRows = useMemo(() => rowsForKeys(groups, recents).filter(({ group, model }) => !favorites.includes(modelKey(group.id, model.id))), [groups, recents, favorites]);
      const busy = state.status === 'selecting' || state.status === 'loading';
      const disabled = locked === true || available === false || !directory;

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
        placeMenu();
        setQuery('');
        setActionError(null);
        setHealthMap(loadHealthResults());
        void loadFreeHubHealth().then(freeHubHealth => {
          setHealthMap({ ...loadHealthResults(), ...freeHubHealth });
        });
        void load?.();
        const closeOutside = (event) => {
          if (rootRef.current?.contains(event.target) === true) return;
          if (menuRef.current?.contains(event.target) === true) return;
          setOpen(false);
        };
        const closeEscape = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', closeOutside);
        document.addEventListener('keydown', closeEscape);
        window.addEventListener('resize', placeMenu);
        return () => {
          document.removeEventListener('mousedown', closeOutside);
          document.removeEventListener('keydown', closeEscape);
          window.removeEventListener('resize', placeMenu);
        };
      }, [open, load, placeMenu]);

      const toggleFavorite = useCallback((key) => {
        setFavorites(previous => {
          const next = previous.includes(key) ? previous.filter(item => item !== key) : [key, ...previous];
          storageSet(FAVORITES_KEY, next);
          return next;
        });
      }, []);

      const choose = useCallback(async (selection) => {
        if (disabled || busy) return;
        setActionError(null);
        try {
          const ok = await select(selection);
          if (ok === false) throw new Error('selection rejected');
          const key = modelKey(selection.provider, selection.model);
          setRecents(previous => {
            const next = [key, ...previous.filter(item => item !== key)].slice(0, MAX_RECENTS);
            storageSet(RECENTS_KEY, next);
            return next;
          });
          setOpen(false);
        } catch (error) {
          setActionError(error instanceof Error ? error.message : String(error));
        }
      }, [busy, disabled, select]);

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
        setExpanded(next);
      };

      const triggerText = state.status === 'loading' && !current
        ? t('loading')
        : currentModel
          ? modelLabel(currentModel)
          : current?.model ?? t('unavailable');
      const currentHealth = current ? healthFor(healthMap, current.provider, current.model) : undefined;
      const triggerCapabilities = currentChoice
        ? [
          currentHealth?.status === 'ok' ? { color: colors.ok, label: fill(t('healthOk'), { latency: Math.round(currentHealth.latency ?? 0) }) } : null,
          isReasoningModel(currentChoice.model) ? { color: colors.accent, label: t('reasoning') } : null,
          isVisionModel(currentChoice.group, currentChoice.model) ? { color: '#b48cff', label: t('vision') } : null,
          hasToolsModel(currentChoice.model) ? { color: '#f5a524', label: t('tools') } : null,
        ].filter(Boolean)
        : [];
      const triggerTitle = current
        ? `${current.provider} / ${current.model}${triggerCapabilities.length > 0 ? ` · ${triggerCapabilities.map(cap => cap.label).join(' / ')}` : ''}`
        : t('unavailable');

      const trigger = React.createElement('button', {
        ref: triggerRef,
        type: 'button',
        disabled,
        onClick: () => setOpen(value => !value),
        title: triggerTitle,
        style: {
          // Match the shipped ModelSelect trigger's layout footprint exactly.
          // Other composer plugins (Codex fast mode, quota, context meter) are
          // positioned around this seat, so changing its width/height shifts them.
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
          'aria-label': t('title'),
          style: {
            position: 'fixed', left: menuPos.left, bottom: menuPos.bottom, width: menuPos.width,
            maxHeight: menuPos.maxHeight, display: 'flex', flexDirection: 'column', overflow: 'hidden',
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
                type: 'button', onClick: () => setAllExpanded(false),
                style: { border: 'none', background: 'transparent', color: colors.muted, cursor: 'pointer', fontSize: '11px' },
              }, t('collapseAll')),
              React.createElement('button', {
                type: 'button', onClick: () => setAllExpanded(true),
                style: { border: 'none', background: 'transparent', color: colors.muted, cursor: 'pointer', fontSize: '11px' },
              }, t('expandAll')),
            ),
            React.createElement('input', {
              autoFocus: true,
              type: 'search',
              value: query,
              placeholder: t('search'),
              onChange: event => setQuery(event.target.value),
              style: {
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '9px',
                border: `1px solid ${colors.border}`, background: colors.panel, color: colors.text,
                outline: 'none', fontSize: '13px',
              },
            }),
            React.createElement('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
              [
                ['all', t('filterAll')],
                ['free', t('filterFree')],
                ['vision', t('filterVision')],
                ['reasoning', t('filterReasoning')],
                ['tools', t('filterTools')],
              ].map(([mode, label]) => React.createElement('button', {
                key: mode,
                type: 'button',
                onClick: () => setCapabilityMode(mode),
                style: {
                  padding: '3px 8px', borderRadius: '999px', fontSize: '11px', cursor: 'pointer',
                  border: `1px solid ${capabilityMode === mode ? colors.accent : colors.border}`,
                  background: capabilityMode === mode ? colors.accent : 'transparent',
                  color: capabilityMode === mode ? colors.accentFg : colors.muted,
                },
              }, label)),
            ),
          ),

          currentChoice ? React.createElement('div', {
            style: { padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, background: 'rgba(255,255,255,.02)' },
          },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', { style: { fontSize: '11px', color: colors.muted, fontWeight: 700 } }, t('current')),
              React.createElement('span', { style: { fontSize: '13px', fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, modelLabel(currentChoice.model)),
              React.createElement('span', { style: { fontSize: '11px', color: colors.muted } }, currentChoice.group.name),
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
          ) : null,

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
            groups.length === 0 && state.status !== 'error'
              ? React.createElement('div', { style: { padding: '18px', color: colors.muted, fontSize: '13px' } }, t('loading'))
              : null,
            query.trim() === '' ? React.createElement(React.Fragment, null,
              React.createElement(ModelSection, { title: t('favorites'), rows: favoriteRows, current, favorites, healthMap, toggleFavorite, choose, t }),
              React.createElement(ModelSection, { title: t('recent'), rows: recentRows, current, favorites, healthMap, toggleFavorite, choose, t }),
            ) : null,
            React.createElement('div', { style: { fontSize: '11px', fontWeight: 700, color: colors.muted, margin: '10px 0 5px 2px' } }, t('providers')),
            filteredGroups.map(group => {
              const isCurrentGroup = current?.provider === group.id;
              const isExpanded = query.trim() !== '' || expanded[group.id] === true || (expanded[group.id] !== false && isCurrentGroup);
              return React.createElement('div', { key: group.id, style: { marginBottom: '6px' } },
                React.createElement('button', {
                  type: 'button',
                  onClick: () => setExpanded(previous => ({ ...previous, [group.id]: !isExpanded })),
                  style: {
                    width: '100%', display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 8px',
                    border: 'none', borderRadius: '8px', background: isCurrentGroup ? 'rgba(76,139,245,.08)' : 'transparent',
                    color: colors.text, cursor: 'pointer', textAlign: 'left',
                  },
                },
                  React.createElement('span', { style: { color: colors.muted, fontSize: '10px', width: '12px' } }, isExpanded ? '▾' : '▸'),
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
                        favorite: favorites.includes(key),
                        health: healthFor(healthMap, group.id, model.id),
                        onFavorite: () => toggleFavorite(key),
                        onSelect: choose,
                        t,
                      });
                    }),
                  )
                  : null,
              );
            }),
            filteredGroups.length === 0 && groups.length > 0
              ? React.createElement('div', { style: { padding: '18px', color: colors.muted, fontSize: '13px' } }, t('noResults'))
              : null,
          ),

          state.failures?.length
            ? React.createElement('div', { style: { padding: '7px 12px', borderTop: `1px solid ${colors.border}`, color: colors.muted, fontSize: '11px' } },
              fill(t('failures'), { count: state.failures.length }),
            )
            : null,
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
        if (!slots || typeof slots.inject !== 'function' || !modelDirectories || !sessions) return;
        slots.inject('conversation.input.model', () => slots.register(
          {
            name: 'conversation.input.model',
            // Single slots are priority-shadowed: the built-in seat is implicit
            // priority 0, so -1 renders instead without removing it. Unloading
            // this plugin restores the shipped selector automatically.
            priority: -1,
            locale: NS,
            inject: (sessionId) => {
              try {
                const directory = modelDirectories.directoryFor(sessionId);
                const available = sessions.subagentAddress(sessionId) === undefined;
                return {
                  available,
                  directory: directory.store,
                  load: () => {
                    if (available) directory.load().catch(() => {});
                  },
                  select: (selection) => available
                    ? directory.select(selection).then(() => true, () => false)
                    : Promise.resolve(false),
                };
              } catch {
                return {
                  available: false,
                  directory: null,
                  load: () => {},
                  select: () => Promise.resolve(false),
                };
              }
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
      rowsForKeys,
      effortLabel,
      isDistinctText,
      isVisionModel,
      isReasoningModel,
      hasToolsModel,
      isOmniModel,
      matchesCapability,
      healthFor,
      DICT,
    };
    return exports;
  },
});
