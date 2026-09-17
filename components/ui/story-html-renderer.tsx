"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { LanguageIcon } from "@heroicons/react/24/solid";
import { marked } from "marked";
import { translateReasoningText } from "@/lib/reasoning-translate";
import { CustomStatusFrame } from "@/components/chat/custom-status-frame";

export type StoryVoiceSegment = {
    id: string;
    text: string;
    speaker?: string;
};

/** Standard HTML tags — anything not in this set gets stripped (content kept) */
const STANDARD_TAGS = new Set([
    "a","abbr","address","area","article","aside","audio","b","base","bdi","bdo",
    "blockquote","body","br","button","canvas","caption","cite","code","col",
    "colgroup","data","datalist","dd","del","details","dfn","dialog","div","dl",
    "dt","em","embed","fieldset","figcaption","figure","footer","form","h1","h2",
    "h3","h4","h5","h6","head","header","hgroup","hr","html","i","iframe","img",
    "input","ins","kbd","label","legend","li","link","main","map","mark","menu",
    "meta","meter","nav","noscript","object","ol","optgroup","option","output","p",
    "picture","pre","progress","q","rp","rt","ruby","s","samp","script","search",
    "section","select","slot","small","source","span","strong","style","sub",
    "summary","sup","table","tbody","td","template","textarea","tfoot","th",
    "thead","time","title","tr","track","u","ul","var","video","wbr",
    "svg","path","circle","rect","line","polyline","polygon","text","g","defs",
    "use","clippath","mask","filter","lineargradient","radialgradient","stop",
    "center","font","marquee","strike","tt","big",
]);

// 允许以 story_ 开头的自定义标签
function isSafeTag(tag: string) {
    const lower = tag.toLowerCase();
    return STANDARD_TAGS.has(lower) || lower.startsWith("story_");
}

// ── Content splitting: separate ```html blocks from regular content ──

type Segment = 
    | { type: "markdown"; content: string }
    | { type: "html-page"; content: string }
    | { type: "fold"; label: string; content: string };

/** 折叠块：think/thinking（思维链）带「翻译」按钮与 中文/原文/对照 切换；其余折叠标签（summary、自定义等）不带 */
function StoryFoldBlock({ label, content, scopeClass, children }: {
    label: string;
    content: string;
    scopeClass: string;
    children: ReactNode;
}) {
    const canTranslate = /^(think|thinking)$/i.test(label.trim());
    const [translation, setTranslation] = useState<string | null>(null);
    const [translating, setTranslating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"both" | "zh" | "orig">("both");
    const [hasOpened, setHasOpened] = useState(false);
    const handleTranslate = async (e: { preventDefault(): void; stopPropagation(): void }) => {
        e.preventDefault();
        e.stopPropagation();
        if (translating) return;
        setTranslating(true);
        setError(null);
        try {
            const result = await translateReasoningText(content);
            if (result.content) { setTranslation(result.content); setViewMode("both"); }
            else setError(result.error || "翻译失败，请重试");
        } catch {
            setError("翻译失败，请重试");
        } finally {
            setTranslating(false);
        }
    };
    const pickMode = (mode: "both" | "zh" | "orig") => (e: { preventDefault(): void; stopPropagation(): void }) => {
        e.preventDefault();
        e.stopPropagation();
        setViewMode(mode);
    };
    return (
        <details
            className="story-fold-block"
            data-fold-tag={label}
            onToggle={(e) => { if (e.currentTarget.open) setHasOpened(true); }}
        >
            <summary>
                {label}
                {canTranslate && !translation && (
                    <button
                        type="button"
                        className="story-fold-translate-btn story-fold-translate-icon"
                        onClick={handleTranslate}
                        aria-label={translating ? "翻译中" : "翻译"}
                        title={translating ? "翻译中" : "翻译"}
                    >
                        {translating
                            ? <Loader2 size={13} className="story-fold-icon-spin" aria-hidden="true" />
                            : <LanguageIcon width={13} height={13} aria-hidden="true" />}
                    </button>
                )}
                {canTranslate && translation && (
                    <span className="story-fold-view-switch">
                        {([["zh", "中文"], ["orig", "原文"], ["both", "对照"]] as const).map(([mode, text]) => (
                            <button
                                key={mode}
                                type="button"
                                className="story-fold-translate-btn"
                                {...(viewMode === mode ? { "data-active": "" } : {})}
                                onClick={pickMode(mode)}
                            >{text}</button>
                        ))}
                    </span>
                )}
            </summary>
            <div className="story-fold-block__content">
                {error && <div className="story-fold-translate-error">{error}</div>}
                {translation && viewMode !== "orig" && (
                    <div className={viewMode === "both" ? "story-fold-translation" : undefined}>
                        <MarkdownSegment content={translation} scopeClass={scopeClass} />
                    </div>
                )}
                {(viewMode !== "zh" || !translation) && hasOpened ? children : null}
            </div>
        </details>
    );
}

function splitContent(text: string): Segment[] {
    if (!text) return [];
    const segments: Segment[] = [];
    const foldRx = /<!--RHR-FOLD:([^>]+)-->\s*([\s\S]*?)\s*<!--\/RHR-FOLD-->/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = foldRx.exec(text)) !== null) {
        segments.push(...splitNonFoldContent(text.slice(lastIndex, match.index)));
        const content = match[2].trim();
        if (content) segments.push({ type: "fold", label: match[1] || "fold", content });
        lastIndex = match.index + match[0].length;
    }
    segments.push(...splitNonFoldContent(text.slice(lastIndex)));
    return segments;
}

function splitNonFoldContent(text: string): Segment[] {
    const whole = text.trim();
    if (whole && /<script\b/i.test(whole)) {
        return [{ type: "html-page", content: whole }];
    }
    const segments: Segment[] = [];
    const rx = /```html\s*\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rx.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index).trim();
        if (before) segments.push({ type: "markdown", content: before });
        const html = match[1].trim();
        if (html) segments.push({ type: "html-page", content: html });
        lastIndex = match.index + match[0].length;
    }
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ type: "markdown", content: remaining });
    return segments;
}

function scopeStyles(html: string, scopeClass: string): string {
    return html.replace(/<style>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
        const scoped = css.replace(
            /([^{}@/][^{}]*)\{/g,
            (ruleMatch: string, selector: string) => {
                const trimmed = selector.trim();
                if (!trimmed || trimmed.startsWith("@") || trimmed.startsWith("from") ||
                    trimmed.startsWith("to") || /^\d+%/.test(trimmed)) {
                    return ruleMatch;
                }
                const prefixed = trimmed.split(",").map(s => {
                    const st = s.trim();
                    if (!st) return st;
                    if (st === ":root") return `.${scopeClass}`;
                    return `.${scopeClass} ${st}`;
                }).join(", ");
                return `${prefixed} {`;
            }
        );
        return `<style>${scoped}</style>`;
    });
}

marked.setOptions({
    breaks: true,
    gfm: true,
});

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function parseLegacyStoryVoiceMarker(inner: string): { text: string; speaker?: string } {
    const normalized = inner.trim();
    const separator = normalized.match(/^([^：:\n]{1,32})[：:]\s*([\s\S]+)$/);
    if (!separator) return { text: normalized };
    return { speaker: separator[1].trim(), text: separator[2].trim() };
}

function MarkdownSegment({
    content,
    scopeClass,
    voiceIdPrefix,
    playingVoiceSegmentId,
}: {
    content: string;
    scopeClass: string;
    voiceIdPrefix?: string;
    playingVoiceSegmentId?: string | null;
}) {
    const html = useMemo(() => {
        const voicePlaceholders: Array<{ token: string; html: string }> = [];
        const semanticPlaceholders: Array<{ token: string; html: string }> = [];
        let voiceIndex = 0;
        const voicePrepared = voiceIdPrefix
            ? content.replace(/「([^」\n]+)」|⌈([^⌈⌋]+)⌋|“([^“”\n]+)”/g, (_whole, standardInner: string | undefined, legacyInner: string | undefined, curlyInner: string | undefined) => {
                if (curlyInner != null && /^[…．.。・~～！!？?\s]+$/.test(curlyInner)) return _whole;
                const parsed = legacyInner == null
                    ? { text: (standardInner ?? curlyInner ?? "").trim(), speaker: undefined }
                    : parseLegacyStoryVoiceMarker(legacyInner);
                if (!parsed.text) return _whole;
                const id = `${voiceIdPrefix}:${voiceIndex++}`;
                const token = `STORYVOICEPLACEHOLDER${voicePlaceholders.length}END`;
                const playing = id === playingVoiceSegmentId;
                const speakerAttr = parsed.speaker
                    ? ` data-story-voice-speaker="${escapeHtmlAttribute(encodeURIComponent(parsed.speaker))}"`
                    : "";
                voicePlaceholders.push({
                    token,
                    html: `<span class="story-voice-segment${playing ? " is-playing" : ""}" data-story-voice-segment="${escapeHtmlAttribute(id)}" data-story-voice-text="${escapeHtmlAttribute(encodeURIComponent(parsed.text))}"${speakerAttr}>「${escapeHtmlAttribute(parsed.text)}」<button type="button" class="story-voice-play" data-story-voice-play="${escapeHtmlAttribute(id)}" aria-label="${playing ? "停止朗读" : "朗读这句对白"}" title="${playing ? "停止" : "播放"}"><span aria-hidden="true">${playing ? "■" : "▶"}</span></button></span>`,
                });
                return token;
            })
            : content;

        const scenePrepared = voicePrepared.replace(/^\s*【([^】\n]{1,80})】\s*$/gm, (_whole, label: string) => {
            const token = `STORYSCENEPLACEHOLDER${semanticPlaceholders.length}END`;
            semanticPlaceholders.push({
                token,
                html: `<div class="story-scene"><span aria-hidden="true">— </span>${escapeHtmlAttribute(label.trim())}<span aria-hidden="true"> —</span></div>`,
            });
            return token;
        });

        let customTagsPrepared = scenePrepared;
        const customTagPlaceholders: Array<{ token: string; html: string }> = [];
        customTagsPrepared = customTagsPrepared.replace(/<(story_[a-zA-Z0-9_-]+)([^>]*)>([\s\S]*?)<\/\1>/g, (wholeMatch, tagName, attrs, innerHTML) => {
            const token = `STORYCUSTOMTAGPLACEHOLDER${customTagPlaceholders.length}END`;
            customTagPlaceholders.push({
                token,
                html: `<${tagName}${attrs}>${innerHTML}</${tagName}>`,
            });
            return token;
        });

        const semanticPrepared = customTagsPrepared.replace(/(^|[^~])~([^~\n<>{};]{1,60})~(?!~)/g, (_whole, prefix: string, emphasized: string) => {
            const token = `STORYACCENTPLACEHOLDER${semanticPlaceholders.length}END`;
            semanticPlaceholders.push({
                token,
                html: `<span class="story-accent">${escapeHtmlAttribute(emphasized)}</span>`,
            });
            return `${prefix}${token}`;
        });

        const preprocessed = semanticPrepared
            .replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>/g, (match, tag) =>
                isSafeTag(tag) ? match : "")
            .replace(/^[ \t]+/gm, "")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/(>)\s*\n\n\s*(<)/g, "$1\n$2");

        const rawHtml = marked.parse(preprocessed, { async: false }) as string;
        let clean = rawHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
        clean = clean.replace(/<br\s*\/?>/gi, '<br><span class="story-br-indent"></span>');
        const scoped = scopeStyles(clean, scopeClass);

        let trimmed = scoped
            .replace(/(<\/div>|<\/details>|<\/table>|<\/p>)\s*(<br\s*\/?>)\s*/gi, "$1")
            .replace(/(<br\s*\/?>){3,}/gi, "<br>")
            .replace(/<p>\s*<\/p>/gi, "")
            .replace(/<p>\s*(<br\s*\/?>)\s*<\/p>/gi, "");

        for (const placeholder of voicePlaceholders) {
            trimmed = trimmed.replace(placeholder.token, placeholder.html);
        }
        for (const placeholder of semanticPlaceholders) {
            trimmed = trimmed.replace(placeholder.token, placeholder.html);
        }
        for (const placeholder of customTagPlaceholders) {
            trimmed = trimmed.replace(placeholder.token, placeholder.html);
        }
        trimmed = trimmed.replace(/<em>/g, '<em class="story-thought">');

        return trimmed;
    }, [content, scopeClass, voiceIdPrefix, playingVoiceSegmentId]);

    return <div className={scopeClass} style={{ whiteSpace: "normal" }} dangerouslySetInnerHTML={{ __html: html }} />;
}

function useActionDelegate(containerRef: React.RefObject<HTMLDivElement | null>, onAction?: (text: string) => void) {
    useEffect(() => {
        if (!onAction) return;
        const el = containerRef.current;
        if (!el) return;
        const handler = (e: MouseEvent) => {
            const target = (e.target as HTMLElement).closest("[data-action]");
            if (target) {
                e.preventDefault();
                e.stopPropagation();
                const action = target.getAttribute("data-action");
                if (action) onAction(action);
            }
        };
        el.addEventListener("click", handler, true);
        return () => el.removeEventListener("click", handler, true);
    }, [containerRef, onAction]);
}

function useStoryVoiceDelegate(
    containerRef: React.RefObject<HTMLDivElement | null>,
    onVoicePlay?: (segment: StoryVoiceSegment) => void,
) {
    useEffect(() => {
        if (!onVoicePlay) return;
        const el = containerRef.current;
        if (!el) return;
        const handler = (event: MouseEvent) => {
            const button = (event.target as HTMLElement).closest<HTMLElement>("[data-story-voice-play]");
            if (!button) return;
            const segment = button.closest<HTMLElement>("[data-story-voice-segment]");
            const id = button.dataset.storyVoicePlay;
            const encodedText = segment?.dataset.storyVoiceText;
            if (!id || !encodedText) return;
            event.preventDefault();
            event.stopPropagation();
            onVoicePlay({
                id,
                text: decodeURIComponent(encodedText),
                speaker: segment?.dataset.storyVoiceSpeaker
                    ? decodeURIComponent(segment.dataset.storyVoiceSpeaker)
                    : undefined,
            });
        };
        el.addEventListener("click", handler, true);
        return () => el.removeEventListener("click", handler, true);
    }, [containerRef, onVoicePlay]);
}

interface HtmlPageProps {
    html: string;
    onOptionSelect?: (text: string) => void;
    htmlPageMode: "auto" | "contained";
    serifIframeFallback?: boolean;
}

function HtmlPageSegment({ html, onOptionSelect, htmlPageMode, serifIframeFallback }: HtmlPageProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(0);
    const contained = htmlPageMode === "contained";
    const recentHeightsRef = useRef<{ h: number; t: number }[]>([]);
    const feedbackLockRef = useRef<number | null>(null);

    const srcDoc = useMemo(() => {
        const bridge = `<style>html,body{overflow:hidden!important;height:auto!important;min-height:0!important}</style><script>(function(){function measure(){var b=document.body;if(!b)return 0;if(window.innerWidth<50)return 0;var br=b.getBoundingClientRect();var h=Math.max(br.height,b.scrollHeight||0);for(var i=0;i<b.children.length;i++){var c=b.children[i];var r=c.getBoundingClientRect();if(r.width||r.height)h=Math.max(h,r.bottom-br.top,c.scrollHeight||0)}return Math.ceil(h)}var animCount=0,animUntil=0;function isAnim(){return animCount>0&&Date.now()<animUntil}function animStart(){animCount++;animUntil=Date.now()+2000;schedule()}function animStop(){if(animCount>0)animCount--;schedule()}function send(){var h=measure();if(!h)return;window.parent.postMessage({type:"_rhr",h:h,anim:isAnim()},"*")}function schedule(){requestAnimationFrame(function(){send();requestAnimationFrame(send)})}window.addEventListener("load",schedule);window.addEventListener("resize",schedule);document.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("[data-action]");if(t){var a=t.getAttribute("data-action");if(a){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:"_rhr_opt",text:a},"*")}}window.parent.postMessage({type:"_rhr_act"},"*");schedule()},true);document.addEventListener("toggle",function(){window.parent.postMessage({type:"_rhr_act"},"*");schedule()},true);document.addEventListener("transitionrun",animStart,true);document.addEventListener("transitionend",animStop,true);document.addEventListener("transitioncancel",animStop,true);document.addEventListener("animationstart",animStart,true);document.addEventListener("animationend",animStop,true);document.addEventListener("animationcancel",animStop,true);if(window.MutationObserver)new MutationObserver(schedule).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});if(window.ResizeObserver){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}setTimeout(send,80);setTimeout(send,500);setTimeout(send,1600)})();<\/script>`;
        const fontFallback = `<style>@font-face{font-family:"Noto Serif SC";src:url("/fonts/interview/noto-serif-sc.woff2") format("woff2");font-weight:300 900;font-display:swap}body{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif}</style>`;
        let h = html;
        h = h.replace(
            /(<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/gi,
            (_m, open, content, close) => open + content
                .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                .replace(/\*(.+?)\*/g, "<em>$1</em>")
            + close
        );
        h = h.replace(/\.textContent\.trim\(\)/g, ".innerHTML.trim()");
        if (serifIframeFallback) h = fontFallback + h;
        if (h.includes("</body>")) h = h.replace("</body>", bridge + "</body>");
        else h = h + bridge;
        return h;
    }, [html, contained, serifIframeFallback]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== "object") return;
            if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
            if (e.data.type === "_rhr_act") {
                feedbackLockRef.current = null;
                recentHeightsRef.current = [];
                return;
            }
            if (e.data.type === "_rhr" && typeof e.data.h === "number") {
                const next = Math.max(e.data.h, 50);
                const lock = feedbackLockRef.current;
                if (lock !== null) {
                    if (next <= lock - 8) {
                        feedbackLockRef.current = null;
                        recentHeightsRef.current = [];
                    } else {
                        return;
                    }
                }
                if (e.data.anim === true) {
                    recentHeightsRef.current = [];
                    setHeight(next);
                    return;
                }
                const recent = recentHeightsRef.current;
                if (recent.length === 0 || recent[recent.length - 1].h !== next) {
                    recent.push({ h: next, t: Date.now() });
                    if (recent.length > 6) recent.shift();
                }
                const isRunaway = recent.length === 6
                    && recent[5].t - recent[0].t < 1200
                    && recent.every((v, i) => {
                        if (i === 0) return true;
                        const step = v.h - recent[i - 1].h;
                        return step > 0 && step < 400;
                    });
                if (isRunaway) {
                    const viewport = iframeRef.current?.closest(".story-stage")?.clientHeight
                        || iframeRef.current?.parentElement?.clientHeight
                        || (typeof window !== "undefined" ? window.innerHeight : 600);
                    const locked = Math.max(recent[0].h, Math.round(viewport * 0.68));
                    feedbackLockRef.current = locked;
                    setHeight(locked);
                    return;
                }
                setHeight(next);
            }
            if (e.data.type === "_rhr_opt" && typeof e.data.text === "string") {
                onOptionSelect?.(e.data.text);
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [onOptionSelect]);

    const frame = (
        <iframe
            ref={iframeRef}
            srcDoc={srcDoc}
            title="HTML content"
            sandbox="allow-scripts"
            style={{
                width: "100%",
                height,
                border: "none",
                display: "block",
                borderRadius: 12,
            }}
        />
    );

    if (!contained) return frame;

    return (
        <div style={{
            maxHeight: "min(68dvh, 560px)",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
            borderRadius: 12,
        }}>
            {frame}
        </div>
    );
}

export interface StoryHtmlRendererProps {
    content: string;
    messageId: string;
    onOptionSelect?: (text: string) => void;
    htmlPageMode?: "auto" | "contained";
    serifIframeFallback?: boolean;
    onVoicePlay?: (segment: StoryVoiceSegment) => void;
    playingVoiceSegmentId?: string | null;
    statusRenderHtml?: string;
    theaterRenderHtml?: string;
}

function StoryHtmlRendererInner({ content, messageId, onOptionSelect, htmlPageMode = "auto", serifIframeFallback = false, onVoicePlay, playingVoiceSegmentId, statusRenderHtml, theaterRenderHtml }: StoryHtmlRendererProps) {
    const segments = useMemo(() => splitContent(content), [content]);
    const scopeClass = `smsg-${messageId.slice(-8)}`;
    const containerRef = useRef<HTMLDivElement>(null);
    useActionDelegate(containerRef, onOptionSelect);
    useStoryVoiceDelegate(containerRef, onVoicePlay);
    const voicePrefix = (suffix: string) => onVoicePlay ? `${messageId}:${suffix}` : undefined;

    return (
        <div className="story-richtext" ref={containerRef}>
            {segments.map((seg, i) => {
                if (seg.type === "html-page") {
                    return <HtmlPageSegment key={`hp-${i}`} html={seg.content} onOptionSelect={onOptionSelect} htmlPageMode={htmlPageMode} serifIframeFallback={serifIframeFallback} />;
                }
                if (seg.type === "fold") {
                    const tailKind = seg.label.toLowerCase() === "story_status"
                        ? "status"
                        : seg.label.toLowerCase() === "story_theater"
                            ? "theater"
                            : null;
                    const tailRenderHtml = tailKind === "status" ? statusRenderHtml : tailKind === "theater" ? theaterRenderHtml : "";
                    return (
                        <StoryFoldBlock key={`fold-${i}`} label={tailKind === "status" ? "状态栏" : tailKind === "theater" ? "小剧场" : seg.label} content={seg.content} scopeClass={scopeClass}>
                            {tailKind && tailRenderHtml ? (
                                <CustomStatusFrame
                                    html={tailRenderHtml}
                                    raw={seg.content}
                                    kind={tailKind}
                                    title={tailKind === "status" ? "剧情状态栏" : "剧情小剧场"}
                                />
                            ) : splitContent(seg.content).map((innerSeg, innerIndex) => {
                                if (innerSeg.type === "html-page") {
                                    return <HtmlPageSegment key={`fold-hp-${i}-${innerIndex}`} html={innerSeg.content} onOptionSelect={onOptionSelect} htmlPageMode={htmlPageMode} serifIframeFallback={serifIframeFallback} />;
                                }
                                if (innerSeg.type === "fold") {
                                    return (
                                        <StoryFoldBlock key={`fold-inner-${i}-${innerIndex}`} label={innerSeg.label} content={innerSeg.content} scopeClass={scopeClass}>
                                            <MarkdownSegment content={innerSeg.content} scopeClass={scopeClass} voiceIdPrefix={voicePrefix(`fold:${i}:${innerIndex}`)} playingVoiceSegmentId={playingVoiceSegmentId} />
                                        </StoryFoldBlock>
                                    );
                                }
                                return <MarkdownSegment key={`fold-md-${i}-${innerIndex}`} content={innerSeg.content} scopeClass={scopeClass} voiceIdPrefix={voicePrefix(`fold:${i}:${innerIndex}`)} playingVoiceSegmentId={playingVoiceSegmentId} />;
                            })}
                        </StoryFoldBlock>
                    );
                }
                return <MarkdownSegment key={`md-${i}`} content={seg.content} scopeClass={scopeClass} voiceIdPrefix={voicePrefix(`md:${i}`)} playingVoiceSegmentId={playingVoiceSegmentId} />;
            })}
        </div>
    );
}

export const StoryHtmlRenderer = memo(StoryHtmlRendererInner);
