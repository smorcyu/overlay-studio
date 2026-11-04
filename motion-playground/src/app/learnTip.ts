// 「学一下」是这套工具里唯一一个用户发现不了的能力 —— 不主动说,它就等于不存在。
// 每次导出都会落一份 review-log(初选 vs 终选),但用户不说那三个字就没人去读。
// 第 1 次和第 3 次导出各提醒一次:第 1 次让他知道有这回事,第 3 次他已经攒够改动了。
const LEARN_TIP_KEY = "overlayStudioLearnTipCount";

export function maybeShowLearnTip() {
  let n = 1;
  try {
    n = Number(localStorage.getItem(LEARN_TIP_KEY) || 0) + 1;
    localStorage.setItem(LEARN_TIP_KEY, String(n));
  } catch {
    return; // 隐私模式等禁用 localStorage:不提醒总比每次都弹强
  }
  if (n !== 1 && n !== 3) return;
  setTimeout(() => {
    alert(
      "💡 刚才这份「AI 排的 vs 你改完的」已经存下来了。\n\n" +
        "对 AI 助手说一句「学一下」,它会对比两版、把你改了两次以上的地方问你确认,\n" +
        "写进 skill 目录的《我的偏好.md》和《经验规则.md》。下一期就按你的排法生成。\n\n" +
        "跑几期之后,那份偏好表里的取值就全是你自己的了 —— \n" +
        "出厂的《我的偏好.default.md》是中性的,风格得你自己长出来。",
    );
  }, 400); // 让下载/导出的动作先走完,别打断
}
