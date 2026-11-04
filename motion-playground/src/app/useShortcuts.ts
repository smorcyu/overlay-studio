import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { StudioTab } from "../components/TopBar";
import { alignCardVideosSoon } from "./alignCardVideos";

/**
 * 全局快捷键(永远最高优先级;只在打字输入框里让位):
 * 空格 = 编辑台播放/暂停,效果库重放动画;← → = 快退/快进 0.5s,按住 Shift = 3s;
 * ⌘Z / ⇧⌘Z = 撤销/重做;Delete = 删选中的卡;I / O = 标剪切入/出点;X = 剪掉;Esc = 清标记。
 *
 * 只挂一次监听,所有会变的东西都从 ref 读(避免每帧重挂)。传进来的函数用的是首次渲染那份:
 * undo/redo 只读 useHistory 里的 ref,删卡和剪切走 deleteRef / cutRef,所以一直是对的
 */
export function useShortcuts(r: {
  tabRef: RefObject<StudioTab>;
  selCardIdRef: RefObject<string | null>;
  curTRef: { current: number };
  durRef: RefObject<number>;
  videoRef: RefObject<HTMLVideoElement | null>;
  deleteRef: RefObject<(id: string) => void>;
  cutRef: RefObject<() => void>;
  undo: () => void;
  redo: () => void;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setPlayToken: Dispatch<SetStateAction<number>>;
  setCurT: (t: number) => void;
  setCutMark: Dispatch<SetStateAction<{ in?: number; out?: number }>>;
}) {
  useEffect(() => {
    const { tabRef, selCardIdRef, curTRef, durRef, videoRef, deleteRef, cutRef } = r;
    const { undo, redo, setPlaying, setPlayToken, setCurT, setCutMark } = r;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      const typing =
        el.isContentEditable ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (tag === "INPUT" &&
          ["text", "number", "search"].includes((el as HTMLInputElement).type));
      if (typing) return;

      if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
        // ⌘Z 撤销 / ⇧⌘Z 重做(时间轴改动)
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (
        (e.code === "Backspace" || e.code === "Delete") &&
        tabRef.current === "edit" &&
        selCardIdRef.current
      ) {
        // Delete = 删除选中的卡
        e.preventDefault();
        deleteRef.current(selCardIdRef.current);
      } else if (e.code === "Space") {
        e.preventDefault();
        if (tabRef.current === "edit") {
          if (durRef.current > 0) setPlaying((p) => !p);
        } else {
          setPlayToken((t) => t + 1);
        }
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        // 两个模式都可用:效果库里用它挪 ➕ 的插入位置
        e.preventDefault();
        const step = (e.shiftKey ? 3 : 0.5) * (e.code === "ArrowLeft" ? -1 : 1);
        const nt = Math.min(Math.max(0, curTRef.current + step), durRef.current);
        curTRef.current = nt; // 立刻同步,连按不丢步
        setCurT(nt);
        if (videoRef.current) videoRef.current.currentTime = nt;
        alignCardVideosSoon(nt, curTRef); // ←/→ 步进也要拉卡内录屏
      } else if (
        (e.code === "KeyI" || e.code === "KeyO") &&
        tabRef.current === "edit" &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        // I / O = 在播放头标剪切入点 / 出点
        e.preventDefault();
        const k = e.code === "KeyI" ? "in" : "out";
        setCutMark((m) => ({ ...m, [k]: Math.round(curTRef.current * 100) / 100 }));
      } else if (e.code === "KeyX" && tabRef.current === "edit" && !e.metaKey && !e.ctrlKey) {
        // X = 剪掉入点到出点这一段
        e.preventDefault();
        cutRef.current();
      } else if (e.code === "Escape" && tabRef.current === "edit") {
        setCutMark({});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 只挂一次(见上面的说明)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
