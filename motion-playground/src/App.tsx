import { useEffect, useMemo, useRef, useState } from "react";
import { EFFECTS } from "./effects/registry";
import { Sidebar } from "./components/Sidebar";
import { Canvas } from "./components/Canvas";
import { ParamsPanel } from "./components/ParamsPanel";
import { TimelineBar } from "./components/TimelineBar";
import { TopBar, type StudioTab } from "./components/TopBar";
import { normalizeAudio, parseOverlay, type AudioSettings, type OverlayCard, type OverlayDoc } from "./overlay/types";
import { parseSrt, type SrtLine } from "./overlay/srt";
import { useWaveform } from "./components/useWaveform";
import { usePreviewAudio } from "./components/usePreviewAudio";
import { MIN_CUT, keptDuration, normalizeCuts, skipCut, type Cut } from "./overlay/cuts";
import { CutSuggestions } from "./components/CutSuggestions";
import { lintOverlay, mergeLintConfig, type LintConfig, type LintIssue } from "./overlay/lint";
import { uploadErrText } from "./uploadErr";
import { LintPanel } from "./components/LintPanel";
import { ExportProgress } from "./components/ExportProgress";
import { ExportResultPanel } from "./components/ExportResultPanel";
import { useTranscribe } from "./app/useTranscribe";
import { useExport } from "./app/useExport";
import { useCutSuggestions } from "./app/useCutSuggestions";
import { useShortcuts } from "./app/useShortcuts";
import { alignCardVideosSoon } from "./app/alignCardVideos";
import { overlayStats } from "./app/overlayStats";
import { AUTOSAVE_KEY, WELCOME_KEY, autosavePayload, parseAutosave, type Dismissed } from "./app/autosave";
import { maybeShowLearnTip } from "./app/learnTip";
import { useHistory } from "./app/useHistory";
import { useLook } from "./app/useLook";
import { useOnline } from "./app/useOnline";
import lintDefaults from "../lint-rules.default.json";

// 个人阈值(lint-rules.local.json,gitignore):存在就叠加覆盖公共默认
const lintLocalModules = import.meta.glob("../lint-rules.local.json", { eager: true }) as Record<
  string,
  { default: Partial<LintConfig> }
>;
const LINT_CFG = mergeLintConfig(
  lintDefaults as Partial<LintConfig>,
  Object.values(lintLocalModules)[0]?.default,
);
import "./effects/hud/hud.css";
import "./App.css";

/** 新卡默认多长:整段演示类的卡要 15 秒才够看完一轮,其余 5 秒。
    右栏那颗「加到 x:xx,时长 n 秒」按钮和真正的插入逻辑共用这一个数,
    避免文案说 5 秒、插进去却是别的。 */
function addSecFor(kind: string) {
  return kind === "focus-card" ? 15 : 5;
}

/** 共用的空剪切列表(引用不变,依赖它的 memo 不会白算) */
const NO_CUTS: never[] = [];

export default function App() {
  // 明牌双模式:编辑台(视频+时间轴,像剪映)/ 效果库(挑卡调样式)
  const [tab, setTab] = useState<StudioTab>("edit");
  const [selectedId, setSelectedId] = useState(EFFECTS[0].id);
  // 每个动效各自保存一份参数,切换不丢
  const [paramsById, setParamsById] = useState<Record<string, any>>(() =>
    Object.fromEntries(EFFECTS.map((e) => [e.id, { ...e.defaults }])),
  );
  const [playToken, setPlayToken] = useState(0);
  const [showGuides, setShowGuides] = useState(true);
  const [showPerson, setShowPerson] = useState(true);
  // 导入的本地视频(object URL):编辑台=停在首帧等播放;效果库=静音循环当背景
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // 视频落盘期间锁住导入按钮。以前这里没有任何状态:传一条几百 MB 的口播要几十秒,
  // 界面全程毫无反应(画面里的视频还先被清掉了),换谁都会再点一次 —— 而同一个素材
  // 传第二遍正好是把后台搞死的那个操作。别的三个上传入口早就有这个锁,只有它漏了。
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoDur, setVideoDur] = useState(0);
  // 编辑台的视频声音(效果库永远静音)
  const [muted, setMuted] = useState(false);
  // 视频画面缩放:视频自带黑边/比例不满时,放大充满画布(1 = 原始)
  const [videoScale, setVideoScale] = useState(1);
  // 动画速度倍率:加速/放慢所有卡片动画(导出同步生效)
  const [animSpeed, setAnimSpeed] = useState(1);
  // 特效整体缩放(1 = 100%)
  const [fxScale, setFxScale] = useState(1);

  // ---- 编辑台:时间轴 ----
  const [overlay, setOverlay] = useState<OverlayDoc | null>(null);
  const [curT, setCurT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selCardId, setSelCardId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ---- 学习闭环:记住本次导入的「AI 初选」,导出时连同终选一起落盘 ----
  const originRef = useRef<OverlayDoc | null>(null);

  // ---- 检查器:导入 JSON 时自动跑,只提醒不阻断;忽略标记写进卡片随 JSON 持久化 ----
  const [lintIssues, setLintIssues] = useState<LintIssue[]>([]);
  const [lintCollapsed, setLintCollapsed] = useState(false);

  // ---- 字幕稿(SRT):点句跳转 / 标记覆盖情况 ----
  const [srt, setSrt] = useState<SrtLine[] | null>(null);
  // 剪切建议里点过「忽略」的段。跟着口播视频走(换了视频就不算数),随自动存档一起保存,
  // 刷新后不再重复提示。放在这里是因为下面的自动存档要读它
  const [dismissed, setDismissed] = useState<Dismissed>({ video: null, cuts: [] });
  // 口播波形:画在时间轴上,对着声音落卡
  const wave = useWaveform(videoUrl);

  // ---- 外壳外观(风格 + 配色) ----
  const { form, palette, pickForm, setPalette } = useLook();

  // 首次挂载:恢复上次的编排 + 字幕稿 + 视频
  // 首次打开引导:什么都没有的新用户,先把 60 秒示例端到面前。
  // 空画布 + 一排陌生按钮是最劝退的第一屏;示例一载入,时间轴/画布/参数面板一眼就懂。
  // 只在「没有任何存档」时提一次(WELCOME_KEY 记一次性标记,和「学一下」提示同一套做法)。
  const loadDemoRef = useRef<() => void>(() => {});
  useEffect(() => {
    // 标记要等真正弹过再写:StrictMode 下 effect 会挂载两次,先写标记的话,
    // 第一次写完、第二次看到标记退出,而第一次的定时器又被 cleanup 清掉 —— 谁都弹不出来
    const t = setTimeout(() => {
      try {
        if (localStorage.getItem(AUTOSAVE_KEY) || localStorage.getItem(WELCOME_KEY)) return;
        localStorage.setItem(WELCOME_KEY, "1");
      } catch {
        return; // 隐私模式:不打扰
      }
      if (
        window.confirm(
          "👋 第一次来?\n\n先载入一套 60 秒的示例编排吧 —— 按空格播放,点画布上的卡片改参数,\n时间轴、拖拽、导出都能直接上手试。\n\n(顶栏「🎬 示例」随时能再载入;取消则从空白开始)",
        )
      )
        loadDemoRef.current();
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const online = useOnline();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const { state: saved, dropped } = parseAutosave(raw);
      if (saved.overlay) {
        if (dropped.length) console.warn("恢复上次编排时跳过了认不出的卡:", dropped.join(", "));
        setOverlay(saved.overlay);
        originRef.current = saved.origin;
        if (saved.srt) setSrt(saved.srt);
        if (saved.dismissed) setDismissed(saved.dismissed);
        setSelCardId(saved.firstCardId);
      }
      // 先探一下视频还在不在(用户可能清过 public/_media),不在就当没存过,别留个坏的 <video>。
      const savedVideo = saved.videoUrl;
      if (savedVideo) {
        fetch(savedVideo, { method: "HEAD" })
          .then((r) => r.ok && setVideoUrl(savedVideo))
          .catch(() => {});
      }
    } catch {
      /* 坏数据直接忽略,不打扰 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 落盘过的预览视频自动当全局「口播视频」:运镜卡导出时要烤的,和预览里那条
  // 本来就是同一条。放在 effect 里而不是导入回调里,是因为「先导视频后导编排」
  // 和「先导编排后导视频」两种顺序都要覆盖到。已经手填过的不动。
  // 用户点过「清除」就不再往回填。以前的判断只看 `!overlay.cam`,清除把 cam 置空 →
  // 条件重新成立 → 立刻又填回去,那个「清除」按钮等于一个摆设。
  // 记的是「用户主动清过」这件事本身,不是「哪条视频挂过」:后者在刷新(存档里 cam 已带值,
  // 记号没机会写)和换编排(视频没变、记号还在,新编排永远挂不上)两种情况下都会失效。
  // 换视频 / 导入新编排 / 载入示例时把记号清掉:那是一次新的开始,该挂还得挂。
  const camClearedRef = useRef(false);
  useEffect(() => {
    if (!overlay || overlay.cam || !videoUrl?.startsWith("/_media/")) return;
    if (camClearedRef.current) return;
    setOverlay((o) => (o && !o.cam ? { ...o, cam: videoUrl } : o));
  }, [overlay, videoUrl]);

  // 任何改动后 800ms 自动落盘;删空卡片则清掉存档
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        if (!overlay) return;
        if (overlay.cards.length === 0) {
          localStorage.removeItem(AUTOSAVE_KEY);
          return;
        }
        localStorage.setItem(
          AUTOSAVE_KEY,
          JSON.stringify(
            autosavePayload({ overlay, origin: originRef.current, srt, videoUrl, dismissed, now: new Date() }),
          ),
        );
      } catch {
        /* 存储异常不打扰编辑 */
      }
    }, 800);
    return () => clearTimeout(id);
    // videoUrl 也要在依赖里:少了它,「清除视频」之后不会重新落盘,存档里留着旧地址,
    // 刷新一次视频又回来了 —— 用户看到的就是「清了个寂寞」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, srt, videoUrl, dismissed]);

  // ---- 撤销/重做(⌘Z / ⇧⌘Z) ----
  const { pushHistory, undo, redo } = useHistory(overlay, srt, setOverlay, setSrt);

  // 编辑台总时长 = max(视频时长, 最后一张卡结束)
  const duration = useMemo(() => {
    const cardsEnd = overlay ? Math.max(...overlay.cards.map((c) => c.end), 0) : 0;
    return Math.max(cardsEnd, videoDur);
  }, [overlay, videoDur]);

  // 剪切段 + 入/出点标记。播放时钟和快捷键在 effect 里,读 ref 拿最新值
  // 没有剪切段时给同一个空数组:每次 overlay 变都 new 一个 [] 的话,依赖它的 memo 次次重算
  const cuts = useMemo(() => overlay?.cuts ?? NO_CUTS, [overlay]);
  const cutsRef = useRef(cuts);
  cutsRef.current = cuts;
  const [cutMark, setCutMark] = useState<{ in?: number; out?: number }>({});
  const cutMarkRef = useRef(cutMark);
  cutMarkRef.current = cutMark;
  const cutRef = useRef<() => void>(() => {});

  // 编排体检:密度(张/分钟)+ 同屏峰值,顶栏一眼看节奏够不够紧
  const stats = useMemo(() => overlayStats(overlay), [overlay]);

  // 时钟(仅编辑台):有视频跟视频走(rAF 读 currentTime),没视频自走
  useEffect(() => {
    if (tab !== "edit" || !playing) return;
    const v = videoRef.current;
    let raf = 0;
    let last = performance.now();
    // 播放被浏览器拒绝时(极少见)老实退回暂停,不让 UI 假装在播
    if (v) v.play().catch(() => setPlaying(false));
    const tick = (now: number) => {
      if (v) {
        // 播到剪切段里:直接跳到段尾,听到的就是剪完的样子
        const skip = skipCut(v.currentTime, cutsRef.current);
        // 往段尾后面多跳 1ms:有的浏览器 seek 完 currentTime 会比目标略小一点,
        // 正好落回剪切段里,下一帧又跳一次,来回卡在段尾
        if (skip !== v.currentTime) {
          v.currentTime = skip + 0.001;
          // 跳过剪切段和拖播放头一样:卡里的录屏也要拉到新位置,不然预览和导出对不上
          alignCardVideosSoon(skip, curTRef);
        }
        setCurT(skip);
        if (v.ended || skip >= duration) {
          setPlaying(false);
          return;
        }
      } else {
        const dt = (now - last) / 1000;
        last = now;
        // 在 setCurT 外面算好下一帧的时间(和 ←/→ 快捷键一样先同步进 curTRef):
        // React 不保证状态更新函数当场执行,在里面记「到头了 / 跳过了剪切段」,
        // 外面紧接着读可能还没被赋值
        const raw = curTRef.current + dt;
        const nt = Math.min(skipCut(raw, cutsRef.current), duration);
        curTRef.current = nt;
        setCurT(nt);
        if (nt !== raw && nt < duration) alignCardVideosSoon(nt, curTRef);
        if (nt >= duration) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (v) v.pause();
    };
  }, [tab, playing, duration]);

  const seek = (t: number) => {
    // 先同步进 curTRef:没有口播视频时播放时钟从它往前走,不同步的话
    // 拖动播放头的位置会被下一帧的「旧时间 + dt」盖掉
    curTRef.current = t;
    setCurT(t);
    const v = videoRef.current;
    if (v) v.currentTime = t;
    alignCardVideosSoon(t, curTRef);
  };

  // 从效果库切回编辑台:把视频画面对回时间轴当前位置(效果库里它自己在循环)
  useEffect(() => {
    if (tab === "edit" && videoRef.current) {
      videoRef.current.currentTime = curTRef.current;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // 最新播放状态存 ref,给全局快捷键读(避免每帧重挂监听)
  const curTRef = useRef(0);
  curTRef.current = curT;

  // 预览里的成片音频:人声响度统一 + 背景音乐(跳过剪切段、说话时压低,近似成片)
  usePreviewAudio({
    active: tab === "edit" && playing,
    videoRef,
    videoUrl,
    curTRef,
    cuts,
    footageDur: videoDur,
    audio: overlay?.audio,
    muted,
    wave,
  });

  const selCardIdRef = useRef<string | null>(null);
  selCardIdRef.current = selCardId;
  const deleteRef = useRef<(id: string) => void>(() => {});
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const durRef = useRef(0);
  durRef.current = duration;

  // 全局快捷键(空格 / ←→ / ⌘Z / Delete / I O X / Esc,见 useShortcuts)
  useShortcuts({
    tabRef,
    selCardIdRef,
    curTRef,
    durRef,
    videoRef,
    deleteRef,
    cutRef,
    undo,
    redo,
    setPlaying,
    setPlayToken,
    setCurT,
    setCutMark,
  });

  const handleImportJson = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    const { doc, error, dropped } = parseOverlay(text);
    if (error || !doc) {
      alert(`❌ JSON 导入失败:${error}`);
      return;
    }
    // 和「载入示例」一样先问一句。这个入口以前不问:拖错一个 JSON 进窗口,当前编排立刻被换掉,
    // 800ms 后自动存档也跟着被盖 —— ⌘Z 能救,刷新一次就救不回了。
    if (overlay?.cards.length && !confirm("导入这份编排会替换当前编排(可撤销),继续吗?")) return;
    pushHistory(true);
    camClearedRef.current = false; // 新编排:口播视频该挂还得挂
    setOverlay(doc);
    originRef.current = structuredClone(doc); // AI 初选快照,学习闭环用
    setSelCardId(doc.cards[0]?.id ?? null);
    setTab("edit");
    seek(0);
    setPlaying(false);
    // 自动体检:只提醒不阻断导入。
    // 认不出的卡已经被跳过了,在这儿补一条 error —— 跳过必须看得见,
    // 否则用户只会觉得「导进来好像少了点东西」却说不上少了什么。
    setLintIssues([
      ...(dropped ?? []).map((d) => ({
        level: "error" as const,
        rule: "unknown-kind",
        message: `跳过了 ${d.n} 张「${d.kind}」——  认不出这种卡,其余卡已正常导入。注意:再导出 JSON 时这几张不会带回去,原文件留好`,
      })),
      ...lintOverlay(doc, LINT_CFG, { duration: durRef.current || undefined }),
    ]);
    setLintCollapsed(false);
  };

  /** 检查面板「忽略」:有卡的问题把规则写进那张卡(用户主动决定,随 JSON 保存);
   *  没卡的问题(如 quiet-gap)只从本次列表移除 */
  const handleLintIgnore = (issue: LintIssue) => {
    if (!issue.cardId || !overlay) {
      setLintIssues((arr) => arr.filter((x) => x !== issue));
      return;
    }
    const next: OverlayDoc = {
      ...overlay,
      cards: overlay.cards.map((c) => {
        if (c.id !== issue.cardId || c.lintOff === true) return c;
        const off = Array.from(
          new Set([...(Array.isArray(c.lintOff) ? c.lintOff : []), issue.rule]),
        );
        return { ...c, lintOff: off };
      }),
    };
    pushHistory(true);
    setOverlay(next);
    setLintIssues(lintOverlay(next, LINT_CFG, { duration: durRef.current || undefined }));
  };

  /** 检查面板「定位」:有卡选中那张卡并跳到进场时刻;只有时间点(空白段)就直接跳时间 */
  const handleLintLocate = (issue: LintIssue) => {
    const c = issue.cardId ? overlay?.cards.find((x) => x.id === issue.cardId) : undefined;
    if (!c && issue.at == null) return;
    setTab("edit");
    if (c) {
      setSelCardId(c.id);
      seek(c.start + 0.01);
    } else {
      seek(issue.at! + 0.01);
    }
  };

  /** 载入内置演示编排(public/demo/):示例 SRT + 示例 JSON,不需要自己的视频 */
  const handleLoadDemo = async () => {
    if (overlay?.cards.length && !confirm("载入示例会替换当前编排(可撤销),继续吗?")) return;
    try {
      const [jsonText, srtText] = await Promise.all([
        fetch("/demo/demo-overlay.json").then((r) => r.text()),
        fetch("/demo/demo.srt").then((r) => r.text()),
      ]);
      const { doc, error, dropped } = parseOverlay(jsonText);
      if (error || !doc) {
        alert(`❌ 示例载入失败:${error}`);
        return;
      }
      // 内置示例理论上不该有认不出的卡。
      // 留这行 warn 当信号,别让示例悄悄少几张卡还没人发现。
      if (dropped?.length)
        console.warn("[示例] 跳过了认不出的卡:", dropped.map((d) => `${d.kind}×${d.n}`).join(", "));
      const lines = parseSrt(srtText);
      pushHistory(true);
      camClearedRef.current = false;
      setSrt(lines.length ? lines : null);
      setOverlay(doc);
      originRef.current = structuredClone(doc);
      setSelCardId(doc.cards[0]?.id ?? null);
      setTab("edit");
      seek(0);
      setPlaying(false);
      setLintIssues(lintOverlay(doc, LINT_CFG, { duration: durRef.current || undefined }));
      setLintCollapsed(false);
    } catch (e) {
      alert(`❌ 示例载入失败:${e}`);
    }
  };

  /** 字幕稿进来(导入 SRT 文件 / 🎙 自动识别):换上字幕稿,没有字幕层卡的话自动加一张 */
  const applySrtText = (text: string, from: "file" | "whisper") => {
    const lines = parseSrt(text);
    if (!lines.length) {
      alert(from === "file" ? "❌ SRT 解析失败:没读到任何字幕条。" : "⚠️ 没识别出任何一句话(这段视频可能没有人声)。");
      return;
    }
    // 换字幕稿算一步撤销(连同下面自动加的字幕卡一起):快照里是换之前的字幕稿和编排
    pushHistory(true);
    setSrt(lines);
    // 已有编排且还没有字幕层卡:自动生成一张常驻双语字幕卡(中文先就位,
    // 英文和 *关键词* 由生成器或你在右栏字幕表里补)
    if (overlay && !overlay.cards.some((c) => c.kind === "caption-track")) {
      const def = EFFECTS.find((e) => e.id === "caption-track");
      const end = Math.ceil(Math.max(...lines.map((l) => l.end)));
      const linesText = lines
        .map(
          (l) =>
            `${l.start.toFixed(2)}|${l.end.toFixed(2)}|${l.text
              .replace(/\|/g, "/")
              .replace(/\s+/g, " ")
              .trim()}`,
        )
        .join("\n");
      setOverlay({
        ...overlay,
        cards: [
          ...overlay.cards,
          {
            id: `caption-track-${overlay.cards.length + 1}`,
            kind: "caption-track",
            start: 0,
            end,
            params: { ...(def?.defaults ?? {}), lines: linesText },
          },
        ],
      });
    }
    setTab("edit");
  };
  const handleImportSrt = async (file: File | null) => {
    if (!file) return;
    applySrtText(await file.text(), "file");
  };
  // 🎙 自动识别:识别的是口播视频的声音。预览里那条落过盘(/_media/)就用它,不然用编排里设的口播视频
  const transcribeSrc = videoUrl?.startsWith("/_media/") ? videoUrl : (overlay?.cam ?? null);
  const [videoGen, setVideoGen] = useState(0); // 每导入一次视频 +1(handleVideo)
  const transcriber = useTranscribe(transcribeSrc, videoGen, (text) => applySrtText(text, "whisper"));

  const handleExportJson = () => {
    if (!overlay) return;
    const blob = new Blob([JSON.stringify(overlay, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "overlay.json";
    a.click();
    URL.revokeObjectURL(a.href);
    // 学习闭环:AI 初选 + 用户终选 一起落盘(失败不打扰导出)
    fetch("/api/review-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        savedAt: new Date().toISOString(),
        origin: originRef.current,
        final: overlay,
      }),
    }).catch(() => {});
    maybeShowLearnTip();
  };

  const handleClearOverlay = () => {
    // 「清空」清的是这一条编排:卡片 + 字幕稿 + 自动存档。以前只清卡片,字幕稿原样留着,
    // 下一条片子的卡就长在上一条的字幕上 —— 这也是「清除不干净」的一份。
    // 导入的视频不在此列,它有自己的「清除」按钮,不该被这里顺手带走。
    if (!confirm("清空这条编排?\n\n卡片和字幕稿都会清掉(导入的视频不受影响)。\n可以用 ⌘Z 撤销。"))
      return;
    pushHistory(true);
    localStorage.removeItem(AUTOSAVE_KEY);
    setOverlay(null);
    setSrt(null);
    setPlaying(false);
    setSelCardId(null);
    seek(0);
  };

  loadDemoRef.current = handleLoadDemo;

  // 当前时间点应显示的卡片(编辑台)
  // 提前 0.05s 挂载:进场动画要等 2 帧才触发,提前量让"可见的出现"正卡在 start 上
  const activeCards = useMemo(
    () =>
      overlay
        ? overlay.cards.filter((c) => curT >= c.start - 0.05 && curT < c.end)
        : [],
    [overlay, curT],
  );

  const selCard = overlay?.cards.find((c) => c.id === selCardId) ?? null;
  // 「第几层」只在和它同时出现的卡里数 —— 全局第几张对观众没意义,同屏谁压谁才有
  const layerInfo = (() => {
    if (!overlay || !selCard) return undefined;
    const co = overlay.cards.filter(
      (c) => c.start < selCard.end && c.end > selCard.start,
    );
    return { index: co.findIndex((c) => c.id === selCard.id) + 1, total: co.length };
  })();

  // 编辑选中卡片的参数(编辑台)
  // 改选中卡的参数:必须用函数式 setOverlay。
  // 以前是 setOverlay({...overlay, …}),连着调 N 次会 N 次都从同一份旧
  // overlay 出发 —— 只有最后一个 key 生效。
  const patchCardParams = (patch: Record<string, unknown>) => {
    if (!selCardId) return;
    pushHistory();
    setOverlay((o) =>
      o
        ? {
            ...o,
            cards: o.cards.map((c) =>
              c.id === selCardId ? { ...c, params: { ...c.params, ...patch } } : c,
            ),
          }
        : o,
    );
  };
  const handleCardParamChange = (key: string, value: unknown) => {
    patchCardParams({ [key]: value });
  };

  // 更换选中卡片的特效类型(时间/落位保留,参数回到新卡默认值)
  const handleCardKindChange = (kind: string) => {
    if (!overlay || !selCardId) return;
    if (!EFFECTS.some((e) => e.id === kind)) return;
    pushHistory(true);
    setOverlay({
      ...overlay,
      cards: overlay.cards.map((c) =>
        c.id === selCardId
          ? {
              ...c,
              kind,
              params: { ...(EFFECTS.find((e) => e.id === kind)?.defaults ?? {}) },
            }
          : c,
      ),
    });
  };

  // 全局底色:一键统一所有卡片的亮/暗(覆盖每张卡的单独设置,可 ⌘Z 撤销)
  const handleGlobalTheme = (theme: "dark" | "light") => {
    if (!overlay) return;
    pushHistory(true);
    setOverlay({
      ...overlay,
      theme,
      cards: overlay.cards.map((c) => ({ ...c, params: { ...c.params, theme } })),
    });
  };

  // 删除卡片(时间轴选中后 Delete / 右栏按钮)
  const handleDeleteCard = (id: string) => {
    pushHistory(true);
    setOverlay((o) =>
      o ? { ...o, cards: o.cards.filter((c) => c.id !== id) } : o,
    );
    setSelCardId((cur) => (cur === id ? null : cur));
  };
  deleteRef.current = handleDeleteCard; // 给全局快捷键(Delete)用

  // 剪切:I 标入点、O 标出点、X 把入点到出点这段剪掉(非破坏性,见 overlay/cuts.ts)
  const handleCutMarked = () => {
    const { in: a, out: b } = cutMarkRef.current;
    if (a === undefined || b === undefined || !overlay) return;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start < MIN_CUT) return;
    pushHistory(true);
    setOverlay((o) => (o ? { ...o, cuts: normalizeCuts([...(o.cuts ?? []), { start, end }]) } : o));
    setCutMark({});
  };
  const handleRemoveCut = (index: number) => {
    pushHistory(true);
    setOverlay((o) => {
      if (!o?.cuts) return o;
      const cuts = o.cuts.filter((_, i) => i !== index);
      return { ...o, cuts: cuts.length ? cuts : undefined };
    });
  };
  cutRef.current = handleCutMarked;
  // 「用不到的剪切」的界线 = 成片实际剪的那条口播视频的长度。只有能确定这个长度时才算:
  // 预览里加载的视频就是导出用的那条(doc.cam 没设,或者正好是它),而且时长已经读出来。
  // 预览视频清掉了、还在加载、或者和 doc.cam 不是同一条时,导出照样会按 doc.cam 剪 ——
  // 这时说「用不到」就是错的,不显示
  const footageEnd =
    videoDur > 0 && videoUrl && (!overlay?.cam || overlay.cam === videoUrl) ? videoDur : null;
  const handleRemoveOutsideCuts = () => {
    if (footageEnd === null) return;
    pushHistory(true);
    setOverlay((o) => {
      if (!o?.cuts) return o;
      const kept = o.cuts.filter((c) => c.start < footageEnd);
      return { ...o, cuts: kept.length ? kept : undefined };
    });
  };

  // 剪切建议:停顿(波形)+ 语气词句 / 重说(字幕稿)。只建议,采纳了(addCuts)才变成剪切段
  const { suggestOpen, setSuggestOpen, minPause, setMinPause, dismissCut, suggestions, suggestMissing } =
    useCutSuggestions({ wave, srt, cuts, videoUrl, dismissed, setDismissed });
  const addCuts = (add: Cut[]) => {
    if (!add.length) return;
    pushHistory(true);
    setOverlay((o) => (o ? { ...o, cuts: normalizeCuts([...(o.cuts ?? []), ...add]) } : o));
  };
  // 成片音频(响度统一 / 背景音乐):存进编排的 audio 字段,只影响成片 MP4。
  // 开关算一步撤销;音量滑杆拖动时 pushHistory() 不强制,和拖卡片一样合并成一步
  const handleAudio = (patch: Partial<AudioSettings>, force = true) => {
    pushHistory(force);
    setOverlay((o) => (o ? { ...o, audio: normalizeAudio({ ...o.audio, ...patch }) } : o));
  };
  const [bgmBusy, setBgmBusy] = useState(false);
  const handleBgmFile = async (file: File | null) => {
    if (!file || !overlay) return;
    setBgmBusy(true);
    try {
      // 和口播视频同一个落盘接口:存进 public/_media/,导出脚本按路径读
      const r = await fetch("/api/media", {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(file.name) },
        body: file,
      });
      const d = await r.json().catch(() => null);
      if (d?.ok && d.url) handleAudio({ bgm: d.url });
      else alert(`❌ 背景音乐保存失败:${d?.error ?? `HTTP ${r.status}`}`);
    } catch (e) {
      alert(`❌ 背景音乐保存失败:${uploadErrText(e)}`);
    } finally {
      setBgmBusy(false);
    }
  };

  // 时间轴色块拖拽:直接写回某张卡的起止时间
  const handleCardTimes = (id: string, start: number, end: number) => {
    pushHistory();
    setOverlay((o) =>
      o
        ? {
            ...o,
            cards: o.cards.map((c) => (c.id === id ? { ...c, start, end } : c)),
          }
        : o,
    );
  };

  /**
   * 叠放:把选中卡片在 cards 数组里挪位置。
   * 画布是按数组顺序画的,**排在后面的压在上面**。
   * 只在"和它时间上有重叠"的卡之间挪 —— 跟不同时出现的卡换先后没有任何视觉意义,
   * 白白把数组搅乱。挪不动(上面/下面没有重叠的卡了)就原样返回。
   */
  const handleCardLayer = (dir: "up" | "down" | "top" | "bottom") => {
    if (!overlay || !selCardId) return;
    const cards = overlay.cards.slice();
    const i = cards.findIndex((c) => c.id === selCardId);
    if (i < 0) return;
    const me = cards[i];
    const hit = (c: OverlayCard) => c.id !== me.id && c.start < me.end && c.end > me.start;
    let j = -1;
    if (dir === "up") for (let k = i + 1; k < cards.length; k++) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "top") for (let k = cards.length - 1; k > i; k--) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "down") for (let k = i - 1; k >= 0; k--) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "bottom") for (let k = 0; k < i; k++) { if (hit(cards[k])) { j = k; break; } }
    if (j < 0) return;
    pushHistory();
    cards.splice(i, 1);
    // 往上挪:插到目标后面(删除自己后目标退了一格,插在 j 正好就是它后面)
    // 往下挪:插到目标前面(目标索引比自己小,删除不影响它,插在 j 就是它前面)
    cards.splice(j, 0, me);
    setOverlay({ ...overlay, cards });
  };

  // 编辑选中卡片的出现/消失时间(秒)
  const handleCardTimeChange = (key: "start" | "end", value: number) => {
    if (!overlay || !selCardId || !Number.isFinite(value)) return;
    pushHistory();
    setOverlay({
      ...overlay,
      cards: overlay.cards.map((c) => {
        if (c.id !== selCardId) return c;
        const next = { ...c, [key]: value };
        return next.end > next.start ? next : c;
      }),
    });
  };

  // 画布直接拖拽/滚轮:给卡片参数打补丁(不触发重放)
  const handleNudge = (cardId: string | null, patch: Record<string, number>) => {
    if (cardId) {
      pushHistory();
      setOverlay((o) =>
        o
          ? {
              ...o,
              cards: o.cards.map((c) =>
                c.id === cardId ? { ...c, params: { ...c.params, ...patch } } : c,
              ),
            }
          : o,
      );
    } else {
      setParamsById((prev) => ({
        ...prev,
        [selectedId]: { ...prev[selectedId], ...patch },
      }));
    }
  };

  // 效果库 → 时间轴:把当前效果(带调好的参数)插到当前时刻
  const handleAddToTimeline = () => {
    const start = Math.round(curTRef.current * 10) / 10;
    const baseCards = overlay?.cards ?? [];
    let n = baseCards.length + 1;
    while (baseCards.some((c) => c.id === `card-${n}`)) n++;
    const card = {
      id: `card-${n}`,
      kind: selectedId,
      start,
      // 整段演示类的卡默认给足 15 秒,其他卡 5 秒
      end: start + addSecFor(selectedId),
      params: { ...paramsById[selectedId] },
    };
    pushHistory(true);
    setOverlay((o) =>
      o
        ? { ...o, cards: [...o.cards, card].sort((a, b) => a.start - b.start) }
        : { version: 1 as const, theme: paramsById[selectedId]?.theme, cards: [card] },
    );
    setSelCardId(card.id);
    // 以前这里 setTab("edit") 把人甩回编辑台:点一下整个界面就变了,是最容易
    // 让人失去方向的一种反馈,想连着加三张卡也得来回切。时间轴两个模式都常驻,
    // 新卡在轨道上直接看得见,不用换页确认。
  };

  const {
    exporting,
    exportingMode,
    exportProg,
    handleExport,
    result: exportResult,
    clearResult: clearExportResult,
  } = useExport({
    overlay,
    originRef,
    fxScale,
    animSpeed,
  });

  const handleVideo = async (file: File | null) => {
    if (videoBusy) return;
    camClearedRef.current = false; // 换了视频,之前那次「清除」不作数
    // 识别字幕途中换视频:同名文件落盘后地址一模一样,光比地址认不出换过,靠这个计数
    setVideoGen((g) => g + 1);
    // 记住换之前的主视频:下面落盘成功后,如果全局「口播视频」(overlay.cam)就是它,要跟着换。
    // 以前不换 —— 自动挂载只在 cam 为空时生效,换视频后 cam 还指着上一条:预览里运镜卡
    // 圆窗放的是新视频(预览用 videoUrl),导出烤进去的却是旧的(导出用 doc.cam),而且没有任何提示。
    // 只在「cam 等于旧主视频」时换:用户在侧栏手动选过别的口播视频,那是他的选择,不动。
    const prevUrl = videoUrl;
    setVideoUrl((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
    // 换视频也要先把时长清零:新视频的元数据读出来之前,别拿旧视频的时长去算
    //「剪后」长度和「剪切在视频之后」的提示(旧的更短时会把对新视频有效的剪切当成用不到的)
    setVideoDur(0);
    if (!file) {
      setPlaying(false);
      return;
    }
    setPlaying(false);
    setVideoBusy(true);
    // 先落盘换一个真实路径:刷新后能自动恢复,无头 Chrome 导出时也读得到。
    // 线上试玩版没有这个后端,退回 blob 地址 —— 那种情况下刷新仍需重新导入。
    try {
      const r = await fetch("/api/media", {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(file.name) },
        body: file,
      });
      // 非 2xx 也要把响应体读出来:后台写盘失败时会认真回一句原因(500 + JSON),
      // 以前 `r.ok ? … : null` 直接把它扔了,页面一声不吭退回 blob,用户以为导入成功了
      const d = await r.json().catch(() => null);
      if (d?.ok && d.url) {
        setVideoUrl(d.url);
        setOverlay((o) => (o && o.cam && o.cam === prevUrl ? { ...o, cam: d.url } : o));
        return;
      }
      alert(
        `❌ 视频落盘失败:${d?.error ?? `HTTP ${r.status}`}\n\n` +
          "先用临时地址预览;这种情况下刷新要重新导入,导出时也带不上口播。",
      );
    } catch (e) {
      // 本地服务没在跑的时候会走到这儿。以前这里一声不吭地退回 blob,用户不知道后台已经
      // 掉线,只会觉得「刷新一次素材就没了」。和其他三个上传入口一样弹一句人话;
      // 顶部横幅交给心跳去判(它要连续两次探不到才报,这里一次失败就翻旗会闪一下又消失)。
      alert(`❌ 视频落盘失败:${uploadErrText(e)}`);
    } finally {
      setVideoBusy(false);
    }
    setVideoUrl(URL.createObjectURL(file));
  };

  // 效果库当前效果。selectedId 一直来自 EFFECTS,理论上找得到,
  // 但别再用 ! 假装 —— 真找不到就退回第一张,不要往下传 undefined。
  const effect = useMemo(
    () => EFFECTS.find((e) => e.id === selectedId) ?? EFFECTS[0],
    [selectedId],
  );
  const params = paramsById[selectedId];

  const handleParamChange = (key: string, value: unknown) => {
    setParamsById((prev) => ({
      ...prev,
      [selectedId]: { ...prev[selectedId], [key]: value },
    }));
    setPlayToken((t) => t + 1); // 改参数即重放,便于观察
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setPlayToken((t) => t + 1);
  };

  // 参数面板:编辑台改选中的卡,效果库改当前效果
  const inEdit = tab === "edit";
  const panelEffect =
    // 这里以前的 ! 是「整页白屏」的根因:编排里只要有一张不认识的卡,
    // 查出来就是 undefined。现在照实传下去,由 ParamsPanel 说清楚是哪张。
    inEdit && selCard ? EFFECTS.find((e) => e.id === selCard.kind) : effect;
  const panelParams = inEdit && selCard ? selCard.params : params;
  const panelOnChange = inEdit && selCard ? handleCardParamChange : handleParamChange;

  return (
    <div
      className="app"
      /* 拖文件进窗口即导入:视频 → 垫底预览,JSON → 时间轴 */
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (!f) {
          alert("❌ 没有读到文件——请从「访达」把文件本体拖进来(从应用里直接拖可能拖不出文件)。");
          return;
        }
        if (f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(f.name)) {
          handleVideo(f);
        } else if (f.type === "application/json" || /\.json$/i.test(f.name)) {
          handleImportJson(f);
        } else if (/\.srt$/i.test(f.name)) {
          handleImportSrt(f);
        } else {
          alert(`❌ 不认识的文件类型:${f.name}(支持视频 mp4/mov/webm、overlay JSON 和 SRT 字幕)`);
        }
      }}
    >
      {!online && (
        <div className="offline-bar">
          ⚠️ 本地服务已停止 —— 这个页面还开着,但导入、上传、导出都不会成功。
          回到启动时那个终端窗口,重新运行 <code>npm run dev</code>(或再双击一次启动器),然后刷新本页。
        </div>
      )}
      <TopBar
        tab={tab}
        onTab={setTab}
        curT={curT}
        duration={duration}
        playing={playing}
        shown={activeCards.length}
        total={overlay?.cards.length ?? 0}
        stats={stats}
        selCardId={inEdit ? selCardId : null}
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        onPlayPause={() => durRef.current > 0 && setPlaying((p) => !p)}
        onReset={() => {
          setPlaying(false);
          seek(0);
        }}
        onImportJson={handleImportJson}
        onLoadDemo={handleLoadDemo}
        effectName={effect.name}
        onReplay={() => setPlayToken((t) => t + 1)}
        exportingMode={exportingMode}
        hasVideo={videoUrl !== null}
        videoBusy={videoBusy}
        onVideo={handleVideo}
        onExport={handleExport}
        canFinal={!!overlay?.cam}
        form={form}
        onForm={pickForm}
        palette={palette}
        onPalette={setPalette}
        hasDoc={!!overlay}
        font={overlay?.font ?? ""}
        onFont={(f) => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, font: f || undefined } : o));
        }}
        glow={!!overlay?.glow}
        onToggleGlow={() => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, glow: !o.glow } : o));
        }}
        breath={!!overlay?.breath}
        onToggleBreath={() => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, breath: o.breath ? undefined : true } : o));
        }}
        audio={overlay?.audio}
        onAudio={handleAudio}
        onBgmFile={handleBgmFile}
        bgmBusy={bgmBusy}
        inkColor={overlay?.inkColor ?? ""}
        onInkColor={(c) => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, inkColor: c || undefined } : o));
        }}
        onUnifyAccent={(accent) => {
          // 批量改写:把每张卡的 accent 参数直接改掉(不是盖一层),
          // 改完各卡参数面板显示的就是新值,之后还能单张调回去。force 压一步撤销。
          pushHistory(true);
          setOverlay((o) =>
            o
              ? {
                  ...o,
                  cards: o.cards.map((c) =>
                    "accent" in (c.params ?? {})
                      ? { ...c, params: { ...c.params, accent } }
                      : c,
                  ),
                }
              : o,
          );
        }}
        showGuides={showGuides}
        onToggleGuides={() => setShowGuides((v) => !v)}
        showPerson={showPerson}
        onTogglePerson={() => setShowPerson((v) => !v)}
      />
      <div className="app-body">
      <Sidebar
        tab={tab}
        effects={EFFECTS}
        selectedId={selectedId}
        onSelect={handleSelect}
        onReplay={() => setPlayToken((t) => t + 1)}
        hasVideo={videoUrl !== null}
        fxScale={fxScale}
        videoScale={videoScale}
        onVideoScale={setVideoScale}
        animSpeed={animSpeed}
        onAnimSpeed={setAnimSpeed}
        overlay={overlay}
        selCardId={selCardId}
        onGlobalTheme={handleGlobalTheme}
        cam={overlay?.cam ?? ""}
        onSetCam={(src) => {
          camClearedRef.current = !src; // 清空 = 用户主动清过,自动挂载别再填回来
          setOverlay((o) => (o ? { ...o, cam: src || undefined } : o));
        }}
        srt={srt}
        curT={curT}
        onSeek={seek}
        onImportSrt={handleImportSrt}
        onSelectCard={(id) => {
          setSelCardId(id);
          const c = overlay?.cards.find((x) => x.id === id);
          if (c) seek(c.start + 0.01);
        }}
        onImportJson={handleImportJson}
        onExportJson={handleExportJson}
        onClearOverlay={handleClearOverlay}
        videoBusy={videoBusy}
        onVideo={handleVideo}
        onFxScale={setFxScale}
        onExport={handleExport}
        exportingMode={exportingMode}
        transcriber={transcriber}
      />

      <main className="stage-col">
        <Canvas
          effect={effect}
          params={params}
          playToken={playToken}
          showGuides={showGuides}
          showPerson={showPerson}
          videoUrl={videoUrl}
          fxScale={fxScale}
          overlayCards={inEdit ? activeCards : null}
          now={curT}
          overlayTheme={overlay?.theme}
          glow={overlay?.glow ?? false}
          breath={overlay?.breath ?? false}
          font={overlay?.font}
          inkColor={overlay?.inkColor}
          videoMuted={muted}
          videoScale={videoScale}
          animSpeed={animSpeed}
          videoElRef={(el) => (videoRef.current = el)}
          onVideoMeta={setVideoDur}
          onNudge={handleNudge}
          onPickCard={setSelCardId}
        />
        {/* 时间线两个模式都常驻:效果库里它标记 ➕ 的插入位置 */}
        <TimelineBar
          duration={duration}
          t={curT}
          cards={overlay?.cards ?? []}
          selectedId={selCardId}
          shown={activeCards.length}
          onSeek={seek}
          onSelect={setSelCardId}
          onTimes={handleCardTimes}
          subs={srt}
          wave={wave}
          cuts={cuts}
          cutMark={cutMark}
          // 成片 MP4 的长度跟口播视频走(卡片可能比视频长);没有视频时才按时间轴总长算
          keptDur={cuts.length ? keptDuration(videoDur > 0 ? videoDur : duration, cuts) : undefined}
          footageEnd={footageEnd}
          onRemoveOutsideCuts={handleRemoveOutsideCuts}
          onRemoveCut={handleRemoveCut}
          suggestions={suggestions}
          onToggleSuggest={overlay ? () => setSuggestOpen((v) => !v) : undefined}
          popover={
            suggestOpen && overlay ? (
              <CutSuggestions
                items={suggestions}
                minPause={minPause}
                onMinPause={setMinPause}
                onAccept={(s) => addCuts([s])}
                onDismiss={dismissCut}
                onAcceptAll={() => addCuts(suggestions)}
                onPreview={(s) => seek(Math.max(0, s.start - 1))}
                onClose={() => setSuggestOpen(false)}
                missing={suggestMissing}
              />
            ) : null
          }
        />
      </main>

      <ParamsPanel
        effect={panelEffect}
        params={panelParams}
        onChange={panelOnChange}
        card={inEdit ? selCard : null}
        editMode={inEdit}
        onLayer={handleCardLayer}
        layer={layerInfo}
        onTimeChange={handleCardTimeChange}
        onKindChange={handleCardKindChange}
        onDelete={handleDeleteCard}
        onAddToTimeline={handleAddToTimeline}
        globalBreath={overlay?.breath === true}
        addAt={curT}
        addSec={addSecFor(selectedId)}
      />
      </div>

      {/* 导出进度浮窗(右下角):渲染帧数 + 预计剩余 + 合成阶段 */}
      {exporting && <ExportProgress prog={exportProg} />}
      {/* 导出结果面板:成品路径(复制 / 在文件夹中显示)+ 提醒 */}
      {exportResult && <ExportResultPanel view={exportResult} onClose={clearExportResult} />}

      {/* 检查器浮窗(左下角):导入 JSON 自动体检的结果,只提醒不阻断 */}
      {lintIssues.length > 0 && (
        <LintPanel
          issues={lintIssues}
          collapsed={lintCollapsed}
          onToggle={() => setLintCollapsed((v) => !v)}
          onClose={() => setLintIssues([])}
          onLocate={handleLintLocate}
          onIgnore={handleLintIgnore}
        />
      )}
    </div>
  );
}
