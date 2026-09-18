"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpenIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  StopIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";

/* 三条粗横条的实心菜单图标，与实心图标集的笔画粗细一致 */
function SolidMenuIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="4.6" width="18" height="2.8" />
      <rect x="3" y="10.6" width="18" height="2.8" />
      <rect x="3" y="16.6" width="18" height="2.8" />
    </svg>
  );
}

/* 粗笔画「‹」返回图标，笔画粗细与菜单横条一致 */
function SolidBackIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 5 L8 12 L15 19"
        stroke="currentColor"
        strokeWidth={2.8}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function MiniPhoneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 5h4M10.7 18.6h2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Avatar } from "@/components/ui/primitives";
import { StoryHtmlRenderer, type StoryVoiceSegment } from "@/components/ui/story-html-renderer";
import { StorySettingsPage, STORY_DEFAULT_STATUS_RENDER, STORY_DEFAULT_THEATER_RENDER } from "@/components/story/story-settings-page";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { incrementEventCounter } from "@/lib/memory-storage";
import { loadBindingConfig, loadPresets, resolveBinding, resolveUserIdentity } from "@/lib/settings-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  createOrGetStorySession,
  hydrateStoryStorage,
  loadStoryMessages,
  loadStorySessions,
  loadStorySchemeRepository,
  pushStoryMessage,
  resolveActiveQuickInputScheme,
  saveStorySchemeRepository,
  STORY_DEFAULT_QUICK_INPUT_OPTIONS,
  STORY_SCHEME_REPO_EVENT,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  editStoryMessage,
  type StoryMessage,
  type StorySchemeRepository,
  type StorySession,
  updateStorySession,
  type StoryCharacterSettings,
} from "@/lib/story-storage";
import { createOrGetSession, hydrateChatStorage, loadChatMessages, loadChatSessions, markChatSessionRead, pushChatMessage } from "@/lib/chat-storage";
import { flattenCompletionResult, generateChatCompletion } from "@/lib/chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import {
  playAudioBlobViaMediaElement,
  resolveVoiceConfig,
  synthesizeSpeech,
  unlockAudioPlayback,
} from "@/lib/tts-service";

type StoryAppProps = {
  onClose: () => void;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
};

const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();
const storyVoiceCache = new Map<string, Blob>();
const STORY_VOICE_CACHE_LIMIT = 24;
const STORY_ACTIVE_CHARACTER_KEY = "story-last-active-character-id";
const DEFAULT_AUTO_READING_SPEED = 36;

registerKvMigration(STORY_ACTIVE_CHARACTER_KEY);

function cacheStoryVoice(key: string, blob: Blob) {
  if (storyVoiceCache.has(key)) storyVoiceCache.delete(key);
  storyVoiceCache.set(key, blob);
  while (storyVoiceCache.size > STORY_VOICE_CACHE_LIMIT) {
    const oldest = storyVoiceCache.keys().next().value;
    if (!oldest) break;
    storyVoiceCache.delete(oldest);
  }
}

function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
  };
  activeStoryGenerationRuns.set(sessionId, run);
  return run;
}

function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run || run.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;
const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "纸白" },
  { id: "warm", color: "#b89870", name: "手账" },
  { id: "night", color: "#3a4560", name: "夜读" },
  { id: "ink", color: "#1a1a1a", name: "水墨" },
  { id: "rose", color: "#d4889a", name: "玫瑰" },
  { id: "sage", color: "#7a9a6a", name: "青苔" },
] as const;

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "从这里开始新的剧情。";
  const source = last.renderedContent || last.rawContent || "";
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "继续上次的场景。";
}

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["整理场景", "续写剧情", "打磨对白", "写入故事"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

function StoryGeneratingIndicator({
  characterName,
  avatar,
}: {
  characterName: string;
  avatar?: string;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="story-row" data-role="assistant">
      <div className="story-msg-head">
        <div className="story-avatar-wrap">
          <Avatar src={avatar || undefined} name={characterName} size="md" />
        </div>
        <div className="story-msg-meta">
          <span className="story-msg-name">{characterName}</span>
          <span className="story-msg-time story-generating-head">{status}</span>
        </div>
      </div>
      <div className="story-bubble-wrap">
        <div className="story-bubble story-generating-bubble" aria-label="正在生成剧情">
          <span className="story-generating-copy">{status}</span>
          <span className="story-generating-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  isGenerating,
  appendRequest,
  voiceEnabled,
  voicePlaying,
  voiceProgress,
  onSend,
  onContinue,
  autoReadingEnabled,
  autoReading,
  currentReadExpanded,
  canAutoRead,
  onToggleAutoReading,
  onCurrentReadControl,
  onStop,
  onPlayNext,
  quickInputEnabled,
  quickInputOptions,
  quickInputCursor,
}: {
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  voiceEnabled: boolean;
  voicePlaying: boolean;
  voiceProgress: { current: number; total: number };
  onSend: (text: string) => void;
  onContinue: () => void;
  autoReadingEnabled: boolean;
  autoReading: boolean;
  currentReadExpanded: boolean;
  canAutoRead: boolean;
  onToggleAutoReading: () => void;
  onCurrentReadControl: () => void;
  onStop: () => void;
  onPlayNext: () => void;
  quickInputEnabled: boolean;
  quickInputOptions: string[];
  quickInputCursor: "left" | "middle" | "right";
}) {
  const [draft, setDraft] = useState("");
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);
  // 记录输入框最近一次选区/光标：点快捷选项时按钮会抢走焦点，
  // 这时 selectionStart 已经不可靠，用这个 ref 兜底
  const lastSelectionRef = useRef<{ start: number; end: number } | null>(null);

  const rememberSelection = (el: HTMLTextAreaElement) => {
    lastSelectionRef.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  const insertQuickOption = (option: string) => {
    const sel = lastSelectionRef.current;
    const start = Math.min(sel ? sel.start : draft.length, draft.length);
    const end = Math.max(start, Math.min(sel ? sel.end : draft.length, draft.length));
    const nextDraft = draft.slice(0, start) + option + draft.slice(end);
    // 光标落点：左边=插入内容之前；中间=成对符号正中（单字符视作末尾）；右边=插入内容之后
    const caretOffset = quickInputCursor === "left"
      ? 0
      : quickInputCursor === "right"
        ? option.length
        : Math.ceil(option.length / 2);
    const caret = start + caretOffset;
    setDraft(nextDraft);
    lastSelectionRef.current = { start: caret, end: caret };
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caret, caret);
    });
  };

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    onSend(text);
  };

  return (
    <div className="story-composer" data-quick-input={quickInputEnabled ? "true" : undefined}>
      {quickInputEnabled && quickPanelOpen && quickInputOptions.length > 0 ? (
        <div className="story-quick-panel" role="toolbar" aria-label="快捷输入面板">
          {quickInputOptions.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              className="story-quick-chip"
              onClick={() => insertQuickOption(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="story-sequence-play"
        data-enabled={voiceEnabled ? "true" : undefined}
        data-playing={voicePlaying ? "true" : undefined}
        onClick={onPlayNext}
        disabled={voicePlaying}
        aria-label="播放下一句角色对白"
        title="播放下一句"
      >
        <span aria-hidden="true">{voicePlaying ? "…" : "▶"}</span>
        {voiceProgress.total > 0 ? (
          <small>{voiceProgress.current}/{voiceProgress.total}</small>
        ) : null}
      </button>
      <button
        type="button"
        className="story-continue-btn"
        onClick={onContinue}
        disabled={isGenerating}
      >
        续写
      </button>
      {quickInputEnabled ? (
        <button
          type="button"
          className="story-quick-input-btn"
          data-open={quickPanelOpen ? "true" : undefined}
          onClick={() => setQuickPanelOpen((open) => !open)}
          aria-expanded={quickPanelOpen}
          aria-label={quickPanelOpen ? "收起快捷输入面板" : "展开快捷输入面板"}
        >
          输入
        </button>
      ) : null}
      {autoReadingEnabled ? (
        <>
          <button
            type="button"
            className="story-auto-read-btn"
            data-reading={autoReading ? "true" : undefined}
            onClick={onToggleAutoReading}
            disabled={!autoReading && !canAutoRead}
            aria-label={autoReading ? "停止自动阅读" : "从最新角色消息开始自动阅读"}
          >
            {autoReading ? "停止" : "自动"}
          </button>
          <button
            type="button"
            className="story-current-read-btn"
            data-expanded={currentReadExpanded ? "true" : undefined}
            onClick={onCurrentReadControl}
            disabled={!canAutoRead}
            aria-label={currentReadExpanded ? "从当前位置开始自动阅读" : "展开当前位置阅读按钮"}
            title="从当前位置开始阅读"
          >
            <BookOpenIcon width={14} height={14} aria-hidden="true" />
            {currentReadExpanded ? <span>从当前位置开始阅读</span> : null}
          </button>
        </>
      ) : null}
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => { resizeStoryComposerTextarea(event.currentTarget); rememberSelection(event.currentTarget); }}
        onSelect={(event) => rememberSelection(event.currentTarget)}
        onKeyUp={(event) => rememberSelection(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          rememberSelection(event.currentTarget);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="你该怎么回应"
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        title={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? <StopIcon width={17} height={17} /> : <PaperAirplaneIcon width={17} height={17} className="story-send-icon" />}
      </button>
    </div>
  );
});

export function StoryApp({ onClose }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  const [, setStorageVersion] = useState(0);
  // 公用方案仓库版本：仓库内容变化（设置页/小卷工具写入）时刷新方案相关 UI
  const [schemeRepoVersion, setSchemeRepoVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [floatingPhoneOpen, setFloatingPhoneOpen] = useState(false);
  const [floatingChatDraft, setFloatingChatDraft] = useState("");
  const [floatingChatGenerating, setFloatingChatGenerating] = useState(false);
  const [floatingChatVersion, setFloatingChatVersion] = useState(0);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("");
  // 生成状态按会话记录：避免在 A 会话生成时切到 B 会话也显示"正在生成"
  const [generatingSessionIds, setGeneratingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  // 抽屉滑动手势用 ref 而不是 state：手指按住时 touchmove 每帧都在触发，
  // 逐帧 setState 会让整个剧情页以事件频率重渲染（iOS 上拉到顶/底按住不动时
  // 表现为持续的重排/闪烁）
  const dragStartXRef = useRef<number | null>(null);
  const dragDeltaXRef = useRef(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const [playingVoiceSegmentId, setPlayingVoiceSegmentId] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [voiceSequenceProgress, setVoiceSequenceProgress] = useState({ current: 0, total: 0 });
  const [autoReading, setAutoReading] = useState(false);
  const [currentReadExpanded, setCurrentReadExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  // ── 设置页往返的滚动位置恢复 ──
  // 设置页会整体卸载 story-stage（提前 return 渲染设置页），返回后是全新 DOM，
  // scrollTop 归零表现为"一进设置再回来就跳回顶部"。这里在 onScroll 里持续记录
  // 位置，返回时写回；设置期间切换角色或消息数量变化则放弃恢复、贴到底部。
  const stageScrollMemoRef = useRef(0);
  const settingsOpenSnapshotRef = useRef<{ sessionId: string; messageCount: number } | null>(null);
  const messagesLengthRef = useRef(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const voicePlaybackRef = useRef<{ abort: () => void } | null>(null);
  const voiceRequestIdRef = useRef(0);
  const voiceNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceSequenceIndexRef = useRef(0);
  const miniPhoneScrollRef = useRef<HTMLDivElement | null>(null);

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const uiPrefs = currentSession?.uiPrefs || {};
  const storySettings: StoryCharacterSettings = currentSession?.settings || {};
  // 方案定义统一来自公用仓库（所有角色共享），角色设置里只有“启用哪一个”
  const schemeRepo: StorySchemeRepository = useMemo(
    () => loadStorySchemeRepository(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schemeRepoVersion, ready],
  );
  const activeStatusScheme = schemeRepo.statusSchemes.find((item) => item.id === storySettings.activeStatusSchemeId)
    ?? storySettings.statusSchemes?.find((item) => item.id === storySettings.activeStatusSchemeId);
  const activeTheaterScheme = schemeRepo.theaterSchemes.find((item) => item.id === storySettings.activeTheaterSchemeId)
    ?? storySettings.theaterSchemes?.find((item) => item.id === storySettings.activeTheaterSchemeId);
  const activeStatusRenderHtml = activeStatusScheme?.renderHtml
    ?? (["status-default", "status-html"].includes(activeStatusScheme?.id || "") ? STORY_DEFAULT_STATUS_RENDER : "");
  const activeTheaterRenderHtml = activeTheaterScheme?.renderHtml
    ?? (["theater-default", "theater-furry"].includes(activeTheaterScheme?.id || "") ? STORY_DEFAULT_THEATER_RENDER : "");
  const boundPreset = useMemo(() => {
    if (!activeCharacterId) return null;
    const slot = resolveBinding(loadBindingConfig(), activeCharacterId, "story");
    return (slot.presetId ? loadPresets().find((item) => item.id === slot.presetId) : null)
      || loadPresets().find((item) => item.builtIn)
      || null;
  }, [activeCharacterId]);
  const floatingChatSession = useMemo(() => {
    if (!activeCharacterId) return null;
    return loadChatSessions().find((item) => item.contactId === activeCharacterId && !item.isGroup) || null;
  }, [activeCharacterId, floatingChatVersion]);
  const floatingChatMessages = useMemo(() => floatingChatSession
    ? loadChatMessages(floatingChatSession.id).filter((item) => item.role === "user" || item.role === "assistant").slice(-30)
    : [], [floatingChatSession, floatingChatVersion]);
  const floatingChatContext = useMemo(() => floatingChatMessages.map((message) => {
    const name = message.role === "user" ? (userIdentity?.name || "用户") : (currentCharacter?.name || "角色");
    const text = message.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return `${new Date(message.createdAt).toLocaleString()} ${name}：${text}`;
  }).join("\n"), [currentCharacter?.name, floatingChatMessages, userIdentity?.name]);
  const isGenerating = Boolean(activeSessionId) && generatingSessionIds.has(activeSessionId);
  const latestAssistantMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.id || "",
    [messages],
  );

  const markGenerating = useCallback((sessionId: string, on: boolean) => {
    setGeneratingSessionIds((prev) => {
      if (on === prev.has(sessionId)) return prev;
      const next = new Set(prev);
      if (on) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      voiceRequestIdRef.current += 1;
      voicePlaybackRef.current?.abort();
      if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
      if (activeSessionIdRef.current) {
        cancelStoryGenerationRun(activeSessionIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    voiceSequenceIndexRef.current = 0;
    setVoiceSequenceProgress({ current: 0, total: 0 });
    voiceRequestIdRef.current += 1;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    setPlayingVoiceSegmentId(null);
  }, [activeSessionId, latestAssistantMessageId]);

  useLayoutEffect(() => {
    if (!floatingPhoneOpen) return;
    const node = miniPhoneScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [floatingChatGenerating, floatingChatVersion, floatingPhoneOpen]);

  useEffect(() => {
    hydrateStoryStorage().then(() => {
      const availableCharacters = loadCharacters();
      const rememberedCharacterId = kvGet(STORY_ACTIVE_CHARACTER_KEY) || "";
      const recentCharacterId = loadStorySessions()[0]?.characterId || "";
      const initialChar = availableCharacters.some((item) => item.id === rememberedCharacterId)
        ? rememberedCharacterId
        : availableCharacters.some((item) => item.id === recentCharacterId)
          ? recentCharacterId
          : availableCharacters[0]?.id || "";
      if (initialChar) {
        const session = createOrGetStorySession(initialChar);
        setActiveCharacterId(initialChar);
        setActiveSessionId(session.id);
        activeSessionIdRef.current = session.id; // 同步更新，堵住生成完成回调的守卫空窗
        setVisibleMessageCount(STORY_INITIAL_LOAD);
        setMessages(loadStoryMessages(session.id));
        setCustomCssDraft(session.customCSS || "");
        setFoldTagsDraft(session.foldTags ?? "think,thinking,story_status,story_theater");
        setContextExcludedTagsDraft(session.contextExcludedTags ?? "think,thinking,story_theater");
        setStorageVersion((value) => value + 1);
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!activeCharacterId) return;
    kvSet(STORY_ACTIVE_CHARACTER_KEY, activeCharacterId);
    const session = createOrGetStorySession(activeCharacterId);
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id; // 同步更新，堵住生成完成回调的守卫空窗
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setCustomCssDraft(session.customCSS || "");
    setFoldTagsDraft(session.foldTags ?? "think,thinking,story_status,story_theater");
    setContextExcludedTagsDraft(session.contextExcludedTags ?? "think,thinking,story_theater");
    setStorageVersion((value) => value + 1);
  }, [activeCharacterId]);

  useEffect(() => {
    setAutoReading(false);
    setCurrentReadExpanded(false);
  }, [activeSessionId]);

  // Listen for live CSS updates from 小卷
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === activeSessionId) {
        setCustomCssDraft(detail.css || "");
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, [activeSessionId]);

  // Listen for story tail scheme updates from 小卷 (剧情方案套件)
  useEffect(() => {
    const onSettingsUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId && detail.sessionId === activeSessionIdRef.current) {
        setStorageVersion((value) => value + 1);
      }
    };
    window.addEventListener("story-session-settings-updated", onSettingsUpdate);
    return () => window.removeEventListener("story-session-settings-updated", onSettingsUpdate);
  }, []);

  // 公用方案仓库变化（设置页保存/小卷工具写入/迁移）时刷新方案相关 UI
  useEffect(() => {
    const onRepoUpdate = () => {
      setSchemeRepoVersion((value) => value + 1);
      setStorageVersion((value) => value + 1);
    };
    window.addEventListener(STORY_SCHEME_REPO_EVENT, onRepoUpdate);
    return () => window.removeEventListener(STORY_SCHEME_REPO_EVENT, onRepoUpdate);
  }, []);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // 段落编辑期间：贴底锁必须关掉，否则编辑框自适应高度每次变化都会被
  // ResizeObserver 拽到底部（表现为"一打字就滚到底"）
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // 编辑草稿放 ref、textarea 非受控：逐键 setState 会让 React 回写 value，
  // 中文输入法下 iOS 会光标错位；逐键改 style.height 又会触发 iOS 自动滚动。
  // 高度自适应改由纯 CSS 镜像（.story-grow-wrap::after）完成，打字零 JS 干预。
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // 段落编辑期间任何路径都不允许自动贴底
    const node = scrollRef.current;
    if (!node) return;
    // 已经贴底（或 iOS 橡皮筋回弹超出底部）时不再强写 scrollTop：
    // 否则 ResizeObserver → 贴底 → scroll 事件 → 再贴底会形成每帧循环，
    // 并和 iOS 的回弹动画互相打架
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 1) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // 编辑中不自动贴底
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom, settingsOpen]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId, settingsOpen]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const startAutoReading = useCallback((from: "latest" | "current") => {
    const node = scrollRef.current;
    if (!node || messages.length === 0) return;
    autoBottomLockRef.current = false;

    if (from === "latest" && latestAssistantMessageId) {
      const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(latestAssistantMessageId)
        : latestAssistantMessageId.replace(/["\\]/g, "\\$&");
      const latest = node.querySelector<HTMLElement>(`[data-story-message-id="${escapedId}"]`);
      if (latest) {
        const nodeRect = node.getBoundingClientRect();
        const latestRect = latest.getBoundingClientRect();
        const target = node.scrollTop + latestRect.top - nodeRect.top - node.clientHeight / 2;
        node.scrollTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, Math.round(target)));
      }
    }

    setCurrentReadExpanded(false);
    requestAnimationFrame(() => setAutoReading(true));
  }, [latestAssistantMessageId, messages.length]);

  useEffect(() => {
    if (!autoReading) return;
    const node = scrollRef.current;
    if (!node) {
      setAutoReading(false);
      return;
    }

    const speed = Math.max(12, Math.min(120, uiPrefs.autoReadingSpeed ?? DEFAULT_AUTO_READING_SPEED));
    const previousScrollBehavior = node.style.getPropertyValue("scroll-behavior");
    const previousScrollBehaviorPriority = node.style.getPropertyPriority("scroll-behavior");
    // iOS PWA 会让 CSS smooth scrolling 和逐帧 scrollTop 互相抢位置。
    node.style.setProperty("scroll-behavior", "auto", "important");
    let frame = 0;
    let previousTime = performance.now();
    // Safari 会把不足 1px 的 scrollTop 写入取整；单独累计目标位置后再写整数，
    // 慢速（默认每帧约 0.6px）也能稳定前进。
    let desiredScrollTop = node.scrollTop;
    const tick = (time: number) => {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      if (desiredScrollTop >= maxScrollTop - 1) {
        node.scrollTop = maxScrollTop;
        setAutoReading(false);
        return;
      }
      const elapsed = Math.min(64, time - previousTime);
      previousTime = time;
      desiredScrollTop = Math.min(maxScrollTop, desiredScrollTop + (speed * elapsed) / 1000);
      node.scrollTop = Math.floor(desiredScrollTop);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (previousScrollBehavior) {
        node.style.setProperty("scroll-behavior", previousScrollBehavior, previousScrollBehaviorPriority);
      } else {
        node.style.removeProperty("scroll-behavior");
      }
    };
  }, [autoReading, uiPrefs.autoReadingSpeed]);

  useEffect(() => {
    if (!uiPrefs.autoReadingEnabled && autoReading) setAutoReading(false);
  }, [autoReading, uiPrefs.autoReadingEnabled]);

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  useEffect(() => {
    messagesLengthRef.current = messages.length;
  }, [messages.length]);

  // 从剧情设置页返回：把滚动位置恢复到进设置之前停留的地方
  useLayoutEffect(() => {
    if (settingsOpen) {
      settingsOpenSnapshotRef.current = {
        sessionId: activeSessionIdRef.current,
        messageCount: messagesLengthRef.current,
      };
      return;
    }
    const snapshot = settingsOpenSnapshotRef.current;
    settingsOpenSnapshotRef.current = null;
    const node = scrollRef.current;
    if (!node || !snapshot) return;
    const contentChanged = snapshot.sessionId !== activeSessionIdRef.current
      || snapshot.messageCount !== messagesLengthRef.current;
    if (contentChanged) {
      // 设置期间切换了角色或有新消息：贴到底部看最新内容（贴底 effect 在设置
      // 打开期间已按旧依赖跑过空转，返回时不会再触发，需要在这里补一次）
      autoBottomLockRef.current = true;
      scrollStoryToBottom();
      const stickTimers = [80, 300, 800].map((delay) => window.setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay));
      return () => stickTimers.forEach((id) => window.clearTimeout(id));
    }
    const target = stageScrollMemoRef.current;
    if (target <= 0) return;
    autoBottomLockRef.current = false; // 恢复期间不要被贴底逻辑拽走
    // .story-stage 的 CSS scroll-behavior:smooth 会把 scrollTop 赋值变成
    // 平滑滚动动画（表现为"返回后看着页面从顶部一路滑下来"，很晕）。
    // 恢复期间用内联样式强制瞬时定位，全部校正结束后再交还给 CSS。
    node.style.scrollBehavior = "auto";
    let done = false;
    let cancelled = false;
    const timers: number[] = [];
    const restoreBehavior = () => {
      if (done) return;
      done = true;
      if (node.style.scrollBehavior === "auto") node.style.scrollBehavior = "";
    };
    const apply = () => {
      if (cancelled) return;
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.min(target, max);
    };
    apply();
    // iOS 上刚挂载的容器同帧写 scrollTop 偶发不生效；rAF 回调仍在首帧
    // 绘制前执行，补写一次确保用户看到的第一帧就是目标位置
    requestAnimationFrame(apply);
    // 状态栏/小剧场 iframe 高度异步确定，内容高度随后会变，补几次校正；
    // 校正期间保持瞬时定位，最后一次校正结束后才还原平滑滚动
    [80, 300, 800].forEach((delay, index) => timers.push(window.setTimeout(() => {
      if (cancelled) return;
      apply();
      if (index === 2) restoreBehavior();
    }, delay)));
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      restoreBehavior();
    };
    // 用户一动手（触摸/滚轮）就停止校正，避免和手动滚动打架
    node.addEventListener("pointerdown", cancel, { capture: true, once: true });
    node.addEventListener("wheel", cancel, { capture: true, once: true, passive: true });
    return () => {
      cancel();
      node.removeEventListener("pointerdown", cancel, { capture: true });
      node.removeEventListener("wheel", cancel, { capture: true });
    };
  }, [settingsOpen, scrollStoryToBottom]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  // Close context menu when clicking outside (delay to avoid the opening tap closing it)
  useEffect(() => {
    if (!activeMessageId) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".story-ctx-menu")) {
        setActiveMessageId(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [activeMessageId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentSession || isGenerating) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    // 配置解析可能抛错（如绑定的 API 配置已被删除）；这里在渲染 effect 里，
    // 抛出去会让整个剧情页白屏，所以失败时跳过缓存刷新，错误留到发送时提示
    let signature: { regexSignature: string; parserVersion: number };
    try {
      signature = getStoryRenderSignature(activeCharacterId);
    } catch {
      return;
    }
    const { regexSignature, parserVersion } = signature;
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentSession.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      let rebuilt: StoryMessage[];
      try {
        rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
      } catch {
        if (cacheRefreshKeyRef.current === refreshKey) cacheRefreshKeyRef.current = null;
        return;
      }
      if (cancelled) return;
      if (activeSessionIdRef.current === currentSession.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
    // 依赖用 id/foldTags 原始值而不是 session 对象：会话缓存归一化会更换对象
    // 引用，按对象依赖会让本 effect 在无关渲染中反复重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeCharacterId, currentSession?.id, currentSession?.foldTags, messages, isGenerating]);

  function applySessionUpdates(updates: Partial<StorySession>) {
    if (!currentSession) return;
    const next = updateStorySession(currentSession.id, updates);
    if (!next) return;
    setCustomCssDraft(next.customCSS || "");
    setFoldTagsDraft(next.foldTags ?? "think,thinking,story_status,story_theater");
    setContextExcludedTagsDraft(next.contextExcludedTags ?? "think,thinking,story_theater");
    setStorageVersion((value) => value + 1);
  }

  const showVoiceNotice = useCallback((message: string) => {
    setVoiceNotice(message);
    if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
    voiceNoticeTimerRef.current = setTimeout(() => setVoiceNotice(null), 2600);
  }, []);

  const playStoryVoice = useCallback(async (segment: StoryVoiceSegment): Promise<boolean> => {
    if (!activeCharacterId || !segment.text.trim()) return false;

    if (!uiPrefs.voiceEnabled) {
      showVoiceNotice("请先在剧情语音中开启语音");
      return false;
    }

    if (playingVoiceSegmentId === segment.id) {
      voiceRequestIdRef.current += 1;
      voicePlaybackRef.current?.abort();
      voicePlaybackRef.current = null;
      setPlayingVoiceSegmentId(null);
      return false;
    }

    const voiceConfig = resolveVoiceConfig(activeCharacterId, "story");
    if (!voiceConfig || !voiceConfig.enableTTS) {
      showVoiceNotice("请先在配置绑定中为剧情绑定可用的语音方案");
      return false;
    }

    unlockAudioPlayback();
    voiceRequestIdRef.current += 1;
    const requestId = voiceRequestIdRef.current;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    setPlayingVoiceSegmentId(segment.id);

    try {
      const cacheKey = `${voiceConfig.id}:${voiceConfig.speechSpeed ?? 1}:${segment.text}`;
      let blob = storyVoiceCache.get(cacheKey) || null;
      if (!blob) {
        blob = await synthesizeSpeech(segment.text, voiceConfig);
        if (blob) cacheStoryVoice(cacheKey, blob);
      }
      if (requestId !== voiceRequestIdRef.current) return false;
      if (!blob) throw new Error("语音服务没有返回音频");

      const playback = playAudioBlobViaMediaElement(blob);
      voicePlaybackRef.current = playback;
      await playback.promise;
      return requestId === voiceRequestIdRef.current;
    } catch (error) {
      if (requestId === voiceRequestIdRef.current) {
        showVoiceNotice(error instanceof Error ? error.message : "语音播放失败，请检查语音配置");
      }
      return false;
    } finally {
      if (requestId === voiceRequestIdRef.current) {
        voicePlaybackRef.current = null;
        setPlayingVoiceSegmentId(null);
      }
    }
  }, [activeCharacterId, playingVoiceSegmentId, showVoiceNotice, uiPrefs.voiceEnabled]);

  const handleStoryVoicePlay = useCallback((segment: StoryVoiceSegment) => {
    void playStoryVoice(segment);
  }, [playStoryVoice]);

  const collectStoryVoiceSegments = useCallback((): StoryVoiceSegment[] => {
    const stage = scrollRef.current;
    if (!stage) return [];
    const assistantRows = Array.from(stage.querySelectorAll<HTMLElement>('.story-row[data-role="assistant"]'));
    const latestRowWithDialogue = assistantRows.reverse().find((row) => row.querySelector("[data-story-voice-segment]"));
    if (!latestRowWithDialogue) return [];
    return Array.from(latestRowWithDialogue.querySelectorAll<HTMLElement>("[data-story-voice-segment]")).flatMap((element) => {
      const id = element.dataset.storyVoiceSegment;
      const encodedText = element.dataset.storyVoiceText;
      if (!id || !encodedText) return [];
      return [{
        id,
        text: decodeURIComponent(encodedText),
        speaker: element.dataset.storyVoiceSpeaker
          ? decodeURIComponent(element.dataset.storyVoiceSpeaker)
          : undefined,
      }];
    });
  }, []);

  const handlePlayNextStoryVoice = useCallback(async () => {
    if (!uiPrefs.voiceEnabled) {
      showVoiceNotice("请先在剧情语音中开启语音");
      return;
    }
    if (playingVoiceSegmentId) return;
    const segments = collectStoryVoiceSegments();
    if (segments.length === 0) {
      showVoiceNotice("当前页面还没有可播放的角色对白");
      return;
    }

    let index = voiceSequenceIndexRef.current;
    if (index >= segments.length) {
      const restart = window.confirm("已经播放完，是否从头开始？");
      if (!restart) return;
      index = 0;
      voiceSequenceIndexRef.current = 0;
    }
    setVoiceSequenceProgress({ current: index + 1, total: segments.length });
    const completed = await playStoryVoice(segments[index]);
    if (!completed) return;

    const nextIndex = index + 1;
    if (nextIndex < segments.length) {
      voiceSequenceIndexRef.current = nextIndex;
      return;
    }

    voiceSequenceIndexRef.current = segments.length;
  }, [collectStoryVoiceSegments, playStoryVoice, playingVoiceSegmentId, showVoiceNotice, uiPrefs.voiceEnabled]);

  async function handleSend(userTextInput: string) {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;

    const userMessage = pushStoryMessage({
      sessionId,
      role: "user",
      rawContent: userText,
      renderedContent: userText,
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const historyForGeneration = loadStoryMessages(sessionId);
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        settings: currentSession?.settings,
        floatingChatContext,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId)); // 按会话从存储重读，杜绝跨会话串消息
      }
      setStorageVersion((value) => value + 1);

      const storyCharacter = characters.find((character) => character.id === characterId);
      if (storyCharacter) {
        void (async () => {
          try {
            incrementEventCounter(characterId);
            incrementEventCounter(characterId);
            await maybeRunSummarization(characterId, storyCharacter.name);
          } catch (err) {
            console.warn("[StoryApp] Memory counter/summarization failed:", err);
          }
        })();
      }
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
      const systemMessage = pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId));
      }
      setStorageVersion((value) => value + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  async function handleFloatingChatSend() {
    const text = floatingChatDraft.trim();
    if (!text || !activeCharacterId || floatingChatGenerating) return;
    const storySessionId = activeSessionId;
    const characterId = activeCharacterId;
    const characterName = currentCharacter?.name || "角色";
    const userName = userIdentity?.name || "用户";
    setFloatingChatDraft("");
    setFloatingChatGenerating(true);
    try {
      await hydrateChatStorage();
      const chatSession = createOrGetSession(characterId);
      pushChatMessage({ sessionId: chatSession.id, role: "user", content: text, origin: "story_floating_phone" });
      setFloatingChatVersion((value) => value + 1);

      const history = loadChatMessages(chatSession.id);
      const completion = await generateChatCompletion(chatSession, history, { appTags: ["chat", "text"], appId: "chat" });
      const rawReply = flattenCompletionResult(completion).trim();
      if (!rawReply) throw new Error("角色没有返回可显示的聊天内容");
      const previousState = [...history].reverse().find((item) => item.stateValues?.length)?.stateValues || [];
      const parsed = parseAIResponse(rawReply, previousState);
      const parts = parsed.parts.length ? parsed.parts : [{ content: rawReply }];
      const replyLines: string[] = [];
      parts.forEach((part, index) => {
        const saved = pushChatMessage({
          sessionId: chatSession.id,
          role: "assistant",
          content: part.content,
          mediaType: part.mediaType,
          mediaData: part.mediaData,
          senderCharacterId: characterId,
          senderName: characterName,
          origin: "story_floating_phone",
          statusPanel: index === 0 ? (parsed.statusPanel || undefined) : undefined,
          innerMonologue: index === 0 ? (parsed.innerMonologue || undefined) : undefined,
          stateValues: index === 0 && parsed.stateValues.length ? parsed.stateValues : undefined,
          freshStateValues: index === 0 && parsed.freshStateValues.length ? parsed.freshStateValues : undefined,
        });
        void saved;
        const visible = part.content.trim() || part.mediaData?.label || (part.mediaType ? `[${part.mediaType}]` : "");
        if (visible) replyLines.push(visible);
      });

      const stamp = new Date().toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const transcript = [
        `【线上聊天 · ${stamp}】`,
        `${userName}：${text}`,
        ...replyLines.map((line) => `${characterName}：${line}`),
      ].join("\n");
      if (storySessionId) {
        pushStoryMessage({ sessionId: storySessionId, role: "system", rawContent: transcript, renderedContent: transcript });
        if (activeSessionIdRef.current === storySessionId) setMessages(loadStoryMessages(storySessionId));
      }
      // 这轮聊天就在悬浮小手机里完成，用户已经看过，不在剧情 APP 外保留未读红点。
      markChatSessionRead(chatSession.id);
      setFloatingChatVersion((value) => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "悬浮聊天发送失败";
      const chatSession = loadChatSessions().find((item) => item.contactId === characterId && !item.isGroup);
      if (chatSession) pushChatMessage({ sessionId: chatSession.id, role: "system", content: `⚠️ ${message}` });
      setFloatingChatVersion((value) => value + 1);
      showVoiceNotice(message);
    } finally {
      setFloatingChatGenerating(false);
    }
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    markGenerating(activeSessionId, false);
  }

  function handleTouchStart(clientX: number) {
    dragStartXRef.current = clientX;
    dragDeltaXRef.current = 0;
  }

  function handleTouchMove(clientX: number) {
    if (dragStartXRef.current == null) return;
    dragDeltaXRef.current = clientX - dragStartXRef.current;
  }

  function handleTouchEnd() {
    const dragStartX = dragStartXRef.current;
    const dragDeltaX = dragDeltaXRef.current;
    if (dragStartX == null) return;
    // 从右边缘向左滑进入完整剧情设置页
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (dragStartX > screenW - 32 && dragDeltaX < -54) {
      setSettingsOpen(true);
    }
    dragStartXRef.current = null;
    dragDeltaXRef.current = 0;
  }

  // ── Long-press & context menu handlers ──
  function getClampedContextMenuPoint(clientX: number, clientY: number) {
    if (typeof window === "undefined") return { x: clientX, y: clientY };
    const menuHalfWidth = 112;
    const menuHeight = 96;
    return {
      x: Math.min(Math.max(clientX, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(clientY + 12, 16), window.innerHeight - menuHeight),
    };
  }

  function handleMsgPointerDown(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button,a,input,textarea,select,summary,iframe,[data-action],[data-story-interactive]")) return;
    // Don't preventDefault — it blocks clicks on <details>, <summary>, <input> etc. inside messages
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      const point = startPosRef.current ?? { x: e.clientX, y: e.clientY };
      setContextMenuPoint(getClampedContextMenuPoint(point.x, point.y));
      setActiveMessageId(msgId);
      longPressTimerRef.current = null;
    }, 500);
  }
  function handleMsgPointerMove(e: React.PointerEvent) {
    if (!startPosRef.current) return;
    if (Math.abs(e.clientX - startPosRef.current.x) > 10 || Math.abs(e.clientY - startPosRef.current.y) > 10) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
  }
  function handleMsgPointerUp(e: React.PointerEvent) {
    startPosRef.current = null;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressTriggeredRef.current) { e.stopPropagation(); e.preventDefault(); longPressTriggeredRef.current = false; }
  }
  function handleMsgPointerCancel() {
    startPosRef.current = null; longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function handleStoryDelete(msgId: string) {
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // 仅作为非受控 textarea 的初始值
    editingDraftRef.current = msg.rawContent;
    setActiveMessageId(null);
  }
  function handleStoryEditSave() {
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId);
      if (regexes.length > 0) {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "用户");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
    setActiveMessageId(null);
  }
  async function handleStoryRetry(msgId: string) {
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = retryMessage.role === "user"
      ? messages.slice(0, msgIndex + 1)
      : messages.slice(0, msgIndex);
    const firstDiscardedMessage = messages[contextMessages.length];
    if (firstDiscardedMessage) {
      deleteStoryMessagesFrom(activeSessionId, firstDiscardedMessage.id);
    }
    setMessages(contextMessages);
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
    // 重试会截掉一条长消息，内容变矮时浏览器把滚动位置钳回新底部，
    // 看起来像"页面跳到上面"；这里主动贴底，让视线落在生成指示器上
    autoBottomLockRef.current = true;
    requestAnimationFrame(() => scrollStoryToBottom());
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, contextMessages, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        settings: currentSession?.settings,
        floatingChatContext,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "重试失败，请稍后再试。";
      const systemMessage = pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  // 快捷输入面板：选项与光标位置来自公用仓库中当前角色选中的方案；选项全空时回落默认符号
  const activeQuickInputScheme = resolveActiveQuickInputScheme(uiPrefs, schemeRepo);
  const quickInputOptionsRaw = activeQuickInputScheme.options.filter((item) => item.trim());
  const quickInputOptions = quickInputOptionsRaw.length > 0 ? quickInputOptionsRaw : STORY_DEFAULT_QUICK_INPUT_OPTIONS;
  const quickInputCursor = activeQuickInputScheme.cursor ?? "middle";

  if (!ready) return null;

  if (characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <SolidBackIcon size={16} />
                </button>
              </div>
              <div className="story-header-center" />
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <BookOpenIcon width={30} height={30} opacity={0.45} />
                <div>
                  <div className="story-empty-title">还没有角色卡</div>
                  <div className="story-empty-desc">请先创建或导入角色卡，再进入剧情 APP 开始故事。</div>
                </div>
                <button className="story-empty-action" onClick={onClose}>
                  返回
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentCharacter || !currentSession) return null;

  const sessionScope = `.story-session-${currentSession.id}`;

  if (settingsOpen) {
    return (
      <div className={`story-app-shell story-session-${currentSession.id}`} data-story-theme={uiPrefs.theme || "paper"}>
        <StorySettingsPage
          characters={characters}
          activeCharacterId={activeCharacterId}
          userName={userIdentity?.name || "用户"}
          uiPrefs={uiPrefs}
          settings={storySettings}
          schemeRepo={schemeRepo}
          boundPreset={boundPreset}
          foldTags={foldTagsDraft}
          contextExcludedTags={contextExcludedTagsDraft}
          onClose={() => setSettingsOpen(false)}
          onCharacterChange={setActiveCharacterId}
          onUiPrefsChange={(next) => applySessionUpdates({ uiPrefs: next })}
          onSettingsChange={(next) => applySessionUpdates({ settings: next })}
          onSchemeRepoChange={saveStorySchemeRepository}
          onTagsChange={(foldTags, contextExcludedTags) => {
            setFoldTagsDraft(foldTags);
            setContextExcludedTagsDraft(contextExcludedTags);
            applySessionUpdates({ foldTags: foldTags.trim() || undefined, contextExcludedTags: contextExcludedTags.trim() || undefined });
          }}
          onOpenCss={() => {
            setSettingsOpen(false);
            setCssModalOpen(true);
          }}
          onRebuildCache={() => {
            try {
              const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
              setMessages(rebuilt);
              setStorageVersion((value) => value + 1);
              alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
            } catch (error) {
              alert(error instanceof Error ? error.message : "缓存重建失败，请检查 API 绑定配置");
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`story-app-shell story-session-${currentSession.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartXRef.current != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {/* Styles moved to styles/story.css */}
      {uiPrefs.wallpaper ? <div className="story-wallpaper-layer" style={{ backgroundImage: `url(${uiPrefs.wallpaper})` }} /> : null}
      {currentSession.customCSS ? (
        <SessionCustomCSS css={currentSession.customCSS} scope={sessionScope} />
      ) : null}

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== 固定顶部标题栏 ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                <SolidBackIcon size={16} />
              </button>
              <div className="story-header-person">
                <Avatar src={currentCharacter.avatar || undefined} name={currentCharacter.name} size="sm" />
                <span>{currentCharacter.name}</span>
              </div>
            </div>
            <div className="story-header-center" />
            <div className="story-header-right" style={{ gap: 8 }}>
              <button className="story-top-btn" onClick={() => setCssModalOpen(true)} aria-label="页面样式">
                <PaintBrushIcon width={16} height={16} />
              </button>
              <button className="story-top-btn" onClick={() => setSettingsOpen(true)} aria-label="打开剧情设置">
                <SolidMenuIcon size={16} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            stageScrollMemoRef.current = node.scrollTop; // 持续记录，供设置页返回时恢复
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">
            
            {/* ====== 顶部信息阅读卡片 ====== */}
            <div className="story-meta">
              <div className="story-meta-layout">
                <div className="story-meta-cover">
                  {currentCharacter.avatar ? (
                    <img src={currentCharacter.avatar} alt="cover" />
                  ) : (
                    <div className="story-meta-cover-fallback" aria-hidden="true">
                      <span className="story-meta-cover-char">{currentCharacter.name.trim().charAt(0) || "书"}</span>
                      <span className="story-meta-cover-line" />
                      <span className="story-meta-cover-sub">STORY</span>
                    </div>
                  )}
                </div>
                <div className="story-meta-body">
                  <div className="story-meta-title">本次阅读：《 {currentCharacter.name} 》</div>
                  <div className="story-meta-tags">
                    {userIdentity?.name || "我"} x {currentCharacter.name}
                  </div>
                  <div className="story-meta-desc">
                    {/* Character type might not have description, so we use a stylized default text */}
                    “有些故事，在开始之前就已经写好了结局。”
                  </div>
                </div>
              </div>
            </div>

            {messages.length === 0 ? (
              <div className="story-empty">
                <BookOpenIcon width={28} height={28} opacity={0.45} />
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading,#1e293b)] mb-1">故事从这里开始</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">从底部输入一段引导，剧情会继续展开。</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>查看更多消息</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message) => {
                  const speakerName = message.role === "user"
                    ? (userIdentity?.name?.trim() || "我")
                    : message.role === "assistant"
                      ? currentCharacter.name
                      : "系统";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (currentCharacter.avatar || undefined)
                      : undefined;
                  return (
                    <article
                      key={message.id}
                      className="story-row"
                      data-role={message.role}
                      data-story-message-id={message.id}
                      onPointerDown={(e) => handleMsgPointerDown(e, message.id)}
                      onPointerMove={handleMsgPointerMove}
                      onPointerUp={handleMsgPointerUp}
                      onPointerCancel={handleMsgPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenuPoint(getClampedContextMenuPoint(e.clientX, e.clientY));
                        setActiveMessageId(message.id);
                      }}
                    >
                      {message.role !== "system" ? (
                        <div className="story-msg-head">
                          <div className="story-avatar-wrap">
                            <Avatar src={avatarUrl} name={speakerName} size="md" />
                          </div>
                          <div className="story-msg-meta">
                            <span className="story-msg-name">{speakerName}</span>
                            <span className="story-msg-time">{formatStoryTime(message.createdAt)}</span>
                          </div>
                        </div>
                      ) : null}
                      <div className="story-bubble-wrap" style={{ position: "relative" }}>
                        <div className="story-bubble">
                          {editingMessageId === message.id ? (
                            <div className="story-inline-edit">
                              <div className="story-grow-wrap" data-value={editingContent}>
                                <textarea
                                  autoFocus
                                  defaultValue={editingContent}
                                  onInput={(e) => {
                                    const el = e.currentTarget;
                                    editingDraftRef.current = el.value;
                                    const wrap = el.parentElement;
                                    if (wrap) wrap.dataset.value = el.value;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                                    if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                                  }}
                                />
                              </div>
                              <div className="story-inline-edit-actions">
                                <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">取消</button>
                                <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">保存</button>
                              </div>
                            </div>
                          ) : (
                            <StoryHtmlRenderer
                              content={message.renderedContent || message.rawContent}
                              messageId={message.id}
                              onOptionSelect={handleOptionSelect}
                              onVoicePlay={message.role === "assistant" ? handleStoryVoicePlay : undefined}
                              playingVoiceSegmentId={playingVoiceSegmentId}
                              statusRenderHtml={activeStatusRenderHtml}
                              theaterRenderHtml={activeTheaterRenderHtml}
                              serifIframeFallback
                            />
                          )}
                        </div>
                        {activeMessageId === message.id && (() => {
                          const menu = (
                            <div
                              className="story-ctx-menu"
                              style={contextMenuPoint ? { left: contextMenuPoint.x, top: contextMenuPoint.y } : undefined}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryCopy(message.rawContent)} className="story-ctx-btn">复制</button>
                                <button onClick={() => handleStoryEditStart(message)} className="story-ctx-btn">编辑</button>
                                {(message.role === "assistant" || message.role === "user") && (
                                  <button onClick={() => { void handleStoryRetry(message.id); }} className="story-ctx-btn story-ctx-btn-danger">重试</button>
                                )}
                              </div>
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryDelete(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除</button>
                                <button onClick={() => handleStoryDeleteFrom(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除以下</button>
                              </div>
                              <div className="story-ctx-triangle" />
                            </div>
                          );
                          return shellInnerRef.current ? createPortal(menu, shellInnerRef.current) : menu;
                        })()}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating ? (
              <StoryGeneratingIndicator
                characterName={currentCharacter.name}
                avatar={currentCharacter.avatar || undefined}
              />
            ) : null}
          </div>
        </div>
      </div>

      {voiceNotice ? (
        <div className="story-voice-notice" role="status">{voiceNotice}</div>
      ) : null}

      <StoryComposer
        isGenerating={isGenerating}
        appendRequest={composerAppendRequest}
        voiceEnabled={Boolean(uiPrefs.voiceEnabled)}
        voicePlaying={Boolean(playingVoiceSegmentId)}
        voiceProgress={voiceSequenceProgress}
        onSend={(text) => { void handleSend(text); }}
        onContinue={() => { void handleSend("继续"); }}
        autoReadingEnabled={Boolean(uiPrefs.autoReadingEnabled)}
        autoReading={autoReading}
        currentReadExpanded={currentReadExpanded}
        canAutoRead={messages.length > 0}
        onToggleAutoReading={() => {
          if (autoReading) setAutoReading(false);
          else startAutoReading("latest");
        }}
        onCurrentReadControl={() => {
          if (!currentReadExpanded) setCurrentReadExpanded(true);
          else startAutoReading("current");
        }}
        onStop={handleStopGeneration}
        onPlayNext={() => { void handlePlayNextStoryVoice(); }}
        quickInputEnabled={Boolean(uiPrefs.quickInputEnabled)}
        quickInputOptions={quickInputOptions}
        quickInputCursor={quickInputCursor}
      />

      {storySettings.floatingPhoneEnabled ? (
        <button className="story-floating-phone-ball" type="button" onClick={() => { setFloatingChatVersion((value) => value + 1); setFloatingPhoneOpen(true); }} aria-label="打开悬浮小手机"><MiniPhoneIcon size={18} /></button>
      ) : null}
      {floatingPhoneOpen ? (
        <div className="story-mini-phone-overlay" onClick={() => setFloatingPhoneOpen(false)}>
          <section className="story-mini-phone" onClick={(event) => event.stopPropagation()}>
            <header><button type="button" onClick={() => setFloatingPhoneOpen(false)}><XMarkIcon width={15} /></button><div><Avatar src={currentCharacter.avatar || undefined} name={currentCharacter.name} size="sm" /><strong>{currentCharacter.name}</strong></div><span /></header>
            <div className="story-mini-phone-messages" ref={miniPhoneScrollRef}>
              {floatingChatMessages.length ? floatingChatMessages.map((message) => (
                <div key={message.id} data-role={message.role}>
                  <small>{message.role === "user" ? (userIdentity?.name || "我") : currentCharacter.name} · {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                  <p>{message.content || message.mediaData?.label || (message.mediaType ? `[${message.mediaType}]` : "")}</p>
                </div>
              )) : <p className="story-mini-phone-empty">还没有与该角色的线上聊天记录</p>}
              {floatingChatGenerating ? <div className="story-mini-phone-typing"><i /><i /><i /></div> : null}
            </div>
            <div className="story-mini-phone-composer">
              <textarea
                rows={1}
                value={floatingChatDraft}
                onChange={(event) => setFloatingChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleFloatingChatSend();
                  }
                }}
                placeholder="发消息…"
                disabled={floatingChatGenerating}
              />
              <button type="button" onClick={() => { void handleFloatingChatSend(); }} disabled={!floatingChatDraft.trim() || floatingChatGenerating} aria-label="发送消息">
                {floatingChatGenerating ? <span>···</span> : <PaperAirplaneIcon width={14} />}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* CSS Style Modal */}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #fdfdfd)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #94a3b8)" }}>
              页面样式
            </span>
            <button className="story-top-btn" onClick={() => setCssModalOpen(false)}>
              <XMarkIcon width={17} height={17} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
                {STORY_THEMES.map(t => {
                  const active = (uiPrefs.theme || "paper") === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`切换到${t.name}主题`}
                      aria-pressed={active}
                      onClick={() => applySessionUpdates({ uiPrefs: { ...uiPrefs, theme: t.id } })}
                      style={{
                        minHeight: 54,
                        borderRadius: 0,
                        border: "none",
                        boxShadow: "none",
                        background: active ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))",
                        color: "var(--c-story-text, #3a3b3c)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        padding: "7px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: t.color,
                        border: "none",
                        boxShadow: active
                          ? "inset 0 0 0 2px var(--c-story-bg-top, #fdfdfd), 0 0 0 2px var(--c-story-text, #3a3b3c)"
                          : "none",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-sub, #94a3b8)", lineHeight: 1.1 }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 这里写剧情模式的 session CSS */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "none",
                borderRadius: 0,
                boxShadow: "none",
                background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))",
                color: "var(--c-story-text, #3a3b3c)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, #fdfdfd)",
                border: "var(--c-story-drawer-border, rgba(0,0,0,0.06))",
                text: "var(--c-story-text, #3a3b3c)",
                textDim: "var(--c-story-sub, #94a3b8)",
                input: "var(--c-story-css-box-bg, rgba(248,250,252,0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(0,0,0,0.06))",
                accent: "var(--c-story-send-bg-active, #0f172a)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={() => { applySessionUpdates({ customCSS: customCssDraft }); setCssModalOpen(false); }}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0, border: "none", boxShadow: "none",
                  background: "var(--c-story-send-bg-active, #dbe3ea)", color: "var(--c-story-send-color-active, #475569)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}