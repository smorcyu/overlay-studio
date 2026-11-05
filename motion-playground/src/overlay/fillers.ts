/**
 * 语气词判断:剪切建议(suggestCuts.ts)找「整句都是语气词」的字幕条,
 * 自动识别字幕(scripts/whisper.mjs,经 vite.config.ts)拼字幕条时让「嗯,」「那个,」单独成一条。
 * 两边必须同一套,所以单独放这里;不 import 任何东西,开发服务器的配置也能直接引用
 */

/** 整句只由这些词组成才算语气词句(去掉标点和空白后比对) */
const FILLERS = [
  "嗯", "啊", "呃", "额", "哦", "噢", "唔", "呀", "哎", "诶", "欸", "嘛",
  "那个", "这个", "就是", "然后", "就是说", "对吧", "是吧",
  "um", "uh", "er", "ah", "hmm", "like", "so", "yeah", "ok", "okay",
];
const FILLER_SET = new Set(FILLERS);

/** 整句是不是只有语气词:中文按最长匹配切,英文按空格切 */
export function isFillerLine(text: string): boolean {
  const words = text.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => {
    if (FILLER_SET.has(w)) return true;
    // 连写的中文语气词(「嗯嗯啊」「那个那个」):从头贪心吃,吃得完就算
    let i = 0;
    outer: while (i < w.length) {
      for (let len = Math.min(3, w.length - i); len >= 1; len--) {
        if (FILLER_SET.has(w.slice(i, i + len))) {
          i += len;
          continue outer;
        }
      }
      return false;
    }
    return true;
  });
}
