/**
 * 秒 → 「分:秒.一位小数」(编辑台各处的时间读数、导出的音效清单/合成说明共用)。
 * 先四舍五入到 0.1 秒再拆分钟:直接拿 (t % 60).toFixed(1) 的话 59.96 秒会显示成 0:60.0。
 * 放在 scripts/ 下是因为导出脚本直接用 node 跑(不经过打包),编辑台的 TS 也能引用它。
 */
export function fmtTime(t) {
  const r = Math.round(Math.max(0, t) * 10) / 10;
  return `${Math.floor(r / 60)}:${(r % 60).toFixed(1).padStart(4, "0")}`;
}
