 <details>, <summary>, <input> etc. inside messages
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
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
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
            stageScrollMemoRef.current = node.scrollTop;
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
                        boxShadow: "var(--story-paper-shadow-soft)",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", letterSpacing: "0.03em" }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", letterSpacing: "0.12em", textTransform: "uppercase" as const, color: "var(--c-story-sub, #94a3b8)", fontWeight: 600 }}>
                  自定义 CSS
                </span>
                <button
                  onClick={() => applySessionUpdates({ customCSS: CSS_EXAMPLE })}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-accent, #94a3b8)",
                    textDecoration: "underline",
                  }}
                >
                  填入示例
                </button>
              </div>
              <CSSSchemeBar
                target="story"
                currentCSS={customCssDraft}
                onApply={(css) => applySessionUpdates({ customCSS: css })}
              />
              <textarea
                className="story-css-box"
                value={customCssDraft}
                onChange={(e) => setCustomCssDraft(e.target.value)}
                onBlur={() => applySessionUpdates({ customCSS: customCssDraft.trim() || undefined })}
                placeholder="/* 可以在此编写专属于此会话的 CSS 代码 */"
                spellCheck={false}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
