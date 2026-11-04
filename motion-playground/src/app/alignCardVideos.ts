/**
 * 拖播放头之后,把**卡内录屏**也拉回正确位置。
 *
 * 卡内 <video> 是 autoPlay 自己走的,只在挂载时起播 —— 顺着播不会错,
 * 但一旦拖动播放头(卡片重新挂载 / 或本来就在播),它还停在"从挂载算起"的位置,
 * 时间轴显示 45s、画面其实是录屏的头几秒。导出端是按时间轴逐帧对位的,
 * 于是**编辑台里看到的和导出的对不上**(实际碰到过)。
 * 拖完拉一把,两边就一致了。
 */
export function alignCardVideos(t: number) {
  document.querySelectorAll<HTMLVideoElement>("video[data-fx-video]").forEach((v) => {
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const ts = Number(v.dataset.tStart) || 0;
    const clip = Number(v.dataset.fxClip) || 0;
    const rate = Number(v.dataset.fxRate) || 1;
    let want = clip + Math.max(0, t - ts) * rate;
    // 短素材循环:超出的部分按"素材可播长度"取模,和导出端同一套算法
    if (v.hasAttribute("data-fx-loop") && want > d) {
      const span = Math.max(d - clip, 0.1);
      want = clip + ((want - clip) % span);
    }
    const to = Math.min(Math.max(want, 0), d - 0.05);
    if (Math.abs(v.currentTime - to) > 0.2) v.currentTime = to;
  });
}

/**
 * 跳到 t 之后对齐卡内录屏:下一帧对一次,260ms 后再补一次 ——
 * 刚跳过去时卡片可能才挂上、录屏的时长还没加载出来(alignCardVideos 会跳过它)。
 * 补的那次按「当时」的播放头对(读 curTRef):正在播放的话 260ms 里时间已经往前走了,
 * 还按 t 对会把录屏往回拽。拖播放头、←/→、播放时跳过剪切段都走这里。
 */
export function alignCardVideosSoon(t: number, curTRef: { current: number }) {
  requestAnimationFrame(() => alignCardVideos(t));
  setTimeout(() => alignCardVideos(curTRef.current), 260);
}
