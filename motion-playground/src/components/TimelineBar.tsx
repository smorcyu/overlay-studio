import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { OverlayCard } from "../overlay/types";
import type { SrtLine } from "../overlay/srt";
import { kindColor } from "../effects/kindColor";
import type { Waveform } from "./useWaveform";
import type { Cut } from "../overlay/cuts";

interface TimelineBarProps {
  duration: number;
  t: number;
  cards: OverlayCard[];
  selectedId: string | null;
  /** 当前时间点显示中的卡片数 */
  shown: number;
  onSeek: (t: number) => void;
  onSelect: (id: string) => void;
  /** 拖动色块 / 拖边缘后写回卡片时间 */
  onTimes: (id: string, start: number, end: number) => void;
  /** 字幕稿:画成一条字幕轨,拖卡时边缘也吸附到每句的起止 */
  subs?: SrtLine[] | null;
  /** 口播波形:画在字幕轨下面,对着声音落卡 */
  wave?: Waveform | null;
  /** 剪掉的时间段:整条轨道上画斜线,点 × 恢复 */
  cuts?: Cut[];
  /** 正在标的剪切入点 / 出点(I / O 键) */
  cutMark?: { in?: number; out?: number };
  /** 剪完之后的成片时长(有剪切时才传) */
  keptDur?: number;
  onRemoveCut?: (index: number) => void;
  /** 待审的剪切建议:轨道上画虚线框 */
  suggestions?: Cut[];
  /** 顶栏「剪切建议」按钮;不传就不显示 */
  onToggleSuggest?: () => void;
  /** 浮在时间轴上方的面板(剪切建议列表) */
  popover?: ReactNode;
}

/** 波形轨:按当前宽度(随缩放变)逐像素取该时间段内的峰值画竖条 */
function WaveLane({ wave, dur }: { wave: Waveform; dur: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !w) return;
    const dpr = window.devicePixelRatio || 1;
    const h = el.clientHeight;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 颜色跟主题走:canvas 读不到 CSS 变量,取元素自身的 color(CSS 里设成主题色)
    ctx.fillStyle = getComputedStyle(el).color;
    const { peaks, rate } = wave;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(((x / w) * dur) * rate);
      const i1 = Math.max(i0 + 1, Math.floor((((x + 1) / w) * dur) * rate));
      if (i0 >= peaks.length) break;
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bh = Math.max(1, (m / 255) * h);
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [wave, dur, w]);
  return <canvas ref={ref} className="tlb-wave" />;
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/** 边缘拖拽判定区(px):落在色块左右这个范围内 = 改起止,否则整块平移 */
const EDGE_PX = 8;
/** 卡片最短时长(秒) */
const MIN_DUR = 0.3;
/** 横向缩放范围 */
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

/** 重叠的卡片自动分行:贪心装进第一条放得下的轨道 */
function assignLanes(cards: OverlayCard[]): Map<string, number> {
  const laneEnds: number[] = [];
  const map = new Map<string, number>();
  const sorted = [...cards].sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    let lane = laneEnds.findIndex((end) => end <= c.start + 0.001);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = c.end;
    map.set(c.id, lane);
  }
  return map;
}

/**
 * 底部视频时间线:当前/总时长/显示数 + 缩放 + 多行卡片轨道 + 播放头。
 * 剪映式擦洗:轨道空白处按下 = 跳到该处,按住左右拖 = 白色竖线跟手。
 * 缩放:「− / +」按钮或 ⌘+滚轮(触控板捏合),拉宽后拖边缘改时间更好下手。
 * 色块整体拖动 = 平移时间;拖左右边缘 = 改出现/消失;点一下 = 选中并跳过去。
 */
export function TimelineBar({
  duration,
  t,
  cards,
  selectedId,
  shown,
  onSeek,
  onSelect,
  onTimes,
  subs,
  wave,
  cuts,
  cutMark,
  keptDur,
  onRemoveCut,
  suggestions,
  onToggleSuggest,
  popover,
}: TimelineBarProps) {
  const dur = Math.max(duration, 0.001);
  /** 滚动容器(视口) */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 实际内容(宽 = zoom × 视口):所有百分比定位都相对它 */
  const innerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  // 缓放后要恢复的锚点:{frac: 锚点在内容中的比例, vx: 锚点距视口左缘 px}
  const anchorRef = useRef<{ frac: number; vx: number } | null>(null);
  // 行高(拖顶边抓手调节,记住偏好):色块高 = 行高 - 5
  const [laneH, setLaneH] = useState(() => {
    const v = Number(localStorage.getItem("tlbLaneH"));
    return Number.isFinite(v) && v >= 16 && v <= 44 ? v : 22;
  });
  const [resizing, setResizing] = useState(false);

  const lanes = assignLanes(cards);
  const laneCount = Math.max(1, ...Array.from(lanes.values()).map((l) => l + 1));
  const headPct = (Math.min(Math.max(t, 0), dur) / dur) * 100;

  /** 顶边抓手:上下拖调整行高(16–44px) */
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    const y0 = e.clientY;
    const h0 = laneH;
    const calc = (y: number) =>
      Math.round(Math.min(44, Math.max(16, h0 + (y0 - y) / Math.max(laneCount, 1))));
    const onMove = (ev: PointerEvent) => setLaneH(calc(ev.clientY));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      localStorage.setItem("tlbLaneH", String(calc(ev.clientY)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 缩放并保持锚点位置不跳(anchorX = 视口内的 clientX;缺省用视口中心) */
  const zoomTo = (next: number, anchorX?: number) => {
    const sc = scrollRef.current;
    const inner = innerRef.current;
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 4) / 4));
    if (!sc || !inner || z === zoom) return;
    const rect = sc.getBoundingClientRect();
    const vx = anchorX != null ? anchorX - rect.left : rect.width / 2;
    const frac = (sc.scrollLeft + vx) / inner.getBoundingClientRect().width;
    anchorRef.current = { frac, vx };
    setZoom(z);
  };

  // 缩放渲染完成后恢复锚点的滚动位置
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const sc = scrollRef.current;
    const inner = innerRef.current;
    if (!a || !sc || !inner) return;
    anchorRef.current = null;
    sc.scrollLeft = a.frac * inner.getBoundingClientRect().width - a.vx;
  }, [zoom]);

  // ⌘/ctrl + 滚轮(触控板捏合)= 缩放。React 的 onWheel 是 passive,挡不住页面缩放,挂原生监听
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      zoomTo(zoom - Math.sign(e.deltaY) * 0.5, e.clientX);
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  /** 剪映式擦洗:按下即 seek,按住拖动连续 seek(坐标相对内容层) */
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const inner = innerRef.current;
    if (!inner) return;
    e.preventDefault();
    const seekAt = (clientX: number) => {
      const rect = inner.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(round2(ratio * dur));
    };
    seekAt(e.clientX);
    const onMove = (ev: PointerEvent) => seekAt(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startDrag = (e: React.PointerEvent, card: OverlayCard) => {
    if (e.button !== 0) return;
    const inner = innerRef.current;
    if (!inner) return;
    e.preventDefault();
    e.stopPropagation(); // 别触发轨道擦洗
    onSelect(card.id);

    const rect = inner.getBoundingClientRect();
    const pxToSec = dur / rect.width;
    const blockEl = e.currentTarget as HTMLElement;
    const b = blockEl.getBoundingClientRect();
    // 判定模式:左边缘 / 右边缘 / 整块平移(窄色块按 1/3 宽收缩边缘区,避免误判)
    const edge = Math.min(EDGE_PX, b.width / 3);
    const mode =
      e.clientX - b.left <= edge ? "start" : b.right - e.clientX <= edge ? "end" : "move";
    const s0 = card.start;
    const e0 = card.end;
    const x0 = e.clientX;
    let moved = false;

    // 磁吸对齐:其他卡的起止 + 字幕每句的起止 + 播放头 + 0 点;10px 内自动吸附(按 Alt 拖 = 关磁吸)
    const targets: number[] = [0, t];
    for (const c of cards) if (c.id !== card.id) targets.push(c.start, c.end);
    for (const s of subs ?? []) targets.push(s.start, s.end);
    const snapTol = 10 * pxToSec;
    const snap = (v: number, disabled: boolean) => {
      if (disabled) return v;
      let best = v;
      let bd = snapTol;
      for (const s of targets) {
        const dd = Math.abs(v - s);
        if (dd < bd) {
          bd = dd;
          best = s;
        }
      }
      return best;
    };

    const onMove = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) * pxToSec;
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      const noSnap = ev.altKey;
      if (mode === "move") {
        const len = e0 - s0;
        let s = Math.max(0, s0 + d);
        // 头尾都试着吸,谁离目标更近听谁的
        const sSnap = snap(s, noSnap);
        const eSnap = snap(s + len, noSnap);
        if (Math.abs(eSnap - (s + len)) < Math.abs(sSnap - s)) s = Math.max(0, eSnap - len);
        else s = sSnap;
        onTimes(card.id, round2(s), round2(s + len));
      } else if (mode === "start") {
        const s = snap(Math.max(0, s0 + d), noSnap);
        onTimes(card.id, round2(Math.min(s, e0 - MIN_DUR)), e0);
      } else {
        const en = snap(e0 + d, noSnap);
        onTimes(card.id, s0, round2(Math.max(en, s0 + MIN_DUR)));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // 没拖动 = 单击:跳到这张卡开头
      if (!moved) onSeek(card.start + 0.01);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="tlb">
      {popover}
      <div
        className={`tlb-resize ${resizing ? "is-drag" : ""}`}
        onPointerDown={startResize}
        title="上下拖 = 调整时间轴高度"
      >
        <span />
      </div>
      <div className="tlb-info">
        <span>当前 {fmt(t)}</span>
        <span>总时长 {fmt(duration)}</span>
        {keptDur !== undefined && (
          <span className="tlb-kept" title="成片 MP4 里会删掉斜线段;透明 MOV/WebM 仍是完整时长">
            剪后 {fmt(keptDur)}
          </span>
        )}
        <span>显示 {shown}</span>
        {onToggleSuggest && (
          <button
            className="tlb-suggest-btn"
            onClick={onToggleSuggest}
            title="找出长停顿、只有语气词的句子、说错重来的句子,逐条决定剪不剪"
          >
            ✂ 剪切建议{suggestions?.length ? ` ${suggestions.length}` : ""}
          </button>
        )}
        <span className="tlb-zoom">
          <button
            className="tlb-zoom-btn"
            onClick={() => zoomTo(zoom - 0.5)}
            disabled={zoom <= ZOOM_MIN}
            title="缩小时间轴(⌘+滚轮)"
          >
            −
          </button>
          <span className="tlb-zoom-val">{zoom.toFixed(2).replace(/\.?0+$/, "")}×</span>
          <button
            className="tlb-zoom-btn"
            onClick={() => zoomTo(zoom + 0.5)}
            disabled={zoom >= ZOOM_MAX}
            title="放大时间轴,方便拖拽(⌘+滚轮)"
          >
            +
          </button>
        </span>
        <span
          className="tlb-keys"
          title="空格 播放 · ← → ±0.5s · ↑ ↓ 换卡 · ⌘Z 撤销 · Delete 删卡 · I/O 标记剪切入点出点 · X 剪掉 · Esc 取消标记 · 点/拖轨道 跳转"
        >
          空格 播放 · ← → ±0.5s · ↑ ↓ 换卡 · ⌘Z 撤销 · Delete 删卡 · I/O 标记 · X 剪切 · 点/拖轨道 跳转
        </span>
      </div>

      <div className="tlb-track" ref={scrollRef}>
        <div
          className="tlb-inner"
          ref={innerRef}
          style={{ width: `${zoom * 100}%` }}
          onPointerDown={startScrub}
        >
          {/* 多行卡片轨道(重叠的卡自动上下分行;行高可拖顶边调节) */}
          <div className="tlb-lanes" style={{ height: laneCount * laneH - 4 }}>
            {cards.map((c) => (
              <div
                key={c.id}
                className={`tlb-card ${c.id === selectedId ? "is-sel" : ""} ${
                  t >= c.start && t < c.end ? "is-live" : ""
                }`}
                style={{
                  left: `${(c.start / dur) * 100}%`,
                  width: `${((Math.min(c.end, dur) - c.start) / dur) * 100}%`,
                  top: (lanes.get(c.id) ?? 0) * laneH,
                  height: laneH - 5,
                  background: kindColor(c.kind),
                }}
                title={`${c.kind} ${fmt(c.start)}–${fmt(c.end)}(拖=平移,拖边缘=改起止,Delete=删除)`}
                onPointerDown={(e) => startDrag(e, c)}
              />
            ))}
          </div>
          {/* 字幕轨:每句一块,悬停看全文;点/拖照常是擦洗跳转 */}
          {subs?.length ? (
            <div className="tlb-subs">
              {subs.map((s, i) =>
                s.start < dur ? (
                  <div
                    key={i}
                    className={`tlb-sub ${t >= s.start && t < s.end ? "is-live" : ""}`}
                    style={{
                      left: `${(s.start / dur) * 100}%`,
                      width: `${((Math.min(s.end, dur) - s.start) / dur) * 100}%`,
                    }}
                    title={`${fmt(s.start)}–${fmt(s.end)} ${s.text}`}
                  >
                    {s.text}
                  </div>
                ) : null,
              )}
            </div>
          ) : null}
          {wave ? <WaveLane wave={wave} dur={dur} /> : null}
          {/* 刻度条:已播进度 */}
          <div className="tlb-ruler">
            <div className="tlb-ruler-fill" style={{ width: `${headPct}%` }} />
          </div>
          {/* 剪切段:斜线盖住整条轨道;× 恢复(按下要拦住,别触发擦洗) */}
          {(cuts ?? []).map((c, i) =>
            c.start < dur ? (
              <div
                key={`${c.start}-${c.end}`}
                className="tlb-cut"
                style={{
                  left: `${(c.start / dur) * 100}%`,
                  width: `${((Math.min(c.end, dur) - c.start) / dur) * 100}%`,
                }}
                title={`剪掉 ${fmt(c.start)}–${fmt(c.end)}(预览跳过,成片 MP4 里删掉)`}
              >
                <button
                  className="tlb-cut-x"
                  title="恢复这一段"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemoveCut?.(i)}
                >
                  ×
                </button>
              </div>
            ) : null,
          )}
          {/* 待审的剪切建议:面板开着时画虚线框,只是提示,不挡鼠标 */}
          {(popover ? suggestions ?? [] : []).map((s) =>
            s.start < dur ? (
              <div
                key={`sg-${s.start}-${s.end}`}
                className="tlb-suggest"
                style={{
                  left: `${(s.start / dur) * 100}%`,
                  width: `${((Math.min(s.end, dur) - s.start) / dur) * 100}%`,
                }}
              />
            ) : null,
          )}
          {/* 待剪的入点 / 出点:标了一个画竖线,两个都标了画出范围,按 X 剪掉 */}
          {cutMark?.in !== undefined && cutMark.out !== undefined ? (
            <div
              className="tlb-mark-range"
              style={{
                left: `${(Math.min(cutMark.in, cutMark.out) / dur) * 100}%`,
                width: `${(Math.abs(cutMark.out - cutMark.in) / dur) * 100}%`,
              }}
              title="按 X 剪掉这一段,Esc 取消"
            />
          ) : null}
          {cutMark?.in !== undefined && (
            <div className="tlb-mark" style={{ left: `${(cutMark.in / dur) * 100}%` }} title="入点(I)" />
          )}
          {cutMark?.out !== undefined && (
            <div className="tlb-mark" style={{ left: `${(cutMark.out / dur) * 100}%` }} title="出点(O)" />
          )}
          {/* 播放头:白色竖线贯穿整条轨道,跟着时间走(拖动由轨道擦洗接管) */}
          <div className="tlb-playhead" style={{ left: `${headPct}%` }}>
            <span className="tlb-ph-head" />
          </div>
        </div>
      </div>
    </div>
  );
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}
