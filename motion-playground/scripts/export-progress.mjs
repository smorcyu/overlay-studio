/**
 * 开发服务器读导出脚本(export-frames.mjs)的输出、换成 /api/export-status 给界面的进度。
 * 拆成纯函数放这里,是为了能单测(vite.config.ts 里只管调用):导出脚本改了进度行的格式,
 * 这边对不上的话界面会一直停在「估算中」,测试要能抓到。
 *
 * 输出格式(导出脚本打的):
 *   rendering frames: N                  逐帧渲染开跑,N = 要渲染的帧数
 *   progress i/N eta S                   每 30 帧一行;S = 导出脚本算好的「预计还需」秒数
 *   extracting video frames / composing MOV / composing WebM / baking … / composing final MP4   阶段
 *   final-progress P/100                 成片合成进度(P 也可能是 ?,读不到原片时长时)
 */

/**
 * 按累计输出 out 更新 prog(就地改,也返回它)。每次都从全文重新找最后一条,
 * 只看已经收完整的行(到最后一个换行为止):一行可能被切在两块数据之间,
 * 半行的「eta 1」(其实是 eta 125)会让界面闪一下错的数
 */
export function applyExportOutput(prog, out) {
  const done = out.slice(0, out.lastIndexOf("\n") + 1);
  // 锚在行首行尾:成片合成的进度行是「final-progress N/100」,不锚的话会被当成渲染帧数。
  // 「预计还需」和帧数在同一行:分两行打的话轮询可能刚好落在两行之间
  const m = [...done.matchAll(/^progress (\d+)\/(\d+)(?: eta (\d+))?$/gm)].pop();
  if (m) {
    prog.frame = Number(m[1]);
    prog.total = Number(m[2]);
    if (m[3] !== undefined) prog.etaSec = Number(m[3]);
    prog.stage = "frames";
  }
  // 视频抽帧(长录屏要几分钟):单独一个阶段,别一直显示「启动渲染器」
  if (prog.stage === "prep" && done.includes("extracting video frames")) prog.stage = "extract";
  // 逐帧渲染开跑:总帧数先记下,第一次报进度(30 帧之后)之前界面就显示「渲染帧 0/N · 估算中」,
  // 不退回「启动渲染器」
  const rf = /^rendering frames: (\d+)$/m.exec(done);
  if (rf && (prog.stage === "prep" || prog.stage === "extract")) {
    prog.total = Number(rf[1]);
    prog.stage = "frames";
  }
  if (done.includes("composing MOV")) prog.stage = "mov";
  if (done.includes("composing WebM")) prog.stage = "webm";
  if (done.includes("baking")) prog.stage = "sfx";
  if (done.includes("composing final MP4")) prog.stage = "final";
  const fm = [...done.matchAll(/^final-progress (\d+)\/100$/gm)].pop();
  if (fm) prog.finalPct = Number(fm[1]);
  return prog;
}
