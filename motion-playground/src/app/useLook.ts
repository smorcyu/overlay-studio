import { useEffect, useState } from "react";
import { FORMS, PALETTES, LEGACY_SKIN_MAP } from "../components/TopBar";

// ---- 外壳外观:两根正交的轴,都挂在 <html> 上 ----
//   风格 data-form    = 形状骨架(App.css「风格骨架」一节)
//   配色 data-palette = 颜色取值表(index.css)
// 只换编辑台外壳,画布/卡片/导出画面完全不受影响。
const FORM_KEY = "overlayStudioForm";
const PALETTE_KEY = "overlayStudioPalette";
const LEGACY_SKIN_KEY = "overlayStudioSkin"; // 单轴时代的旧键,读到就迁移

// 老用户开机时把旧皮肤 id 拆成两轴;拆完删除旧键,只会跑这一次
function restoreLook() {
  try {
    const legacy = localStorage.getItem(LEGACY_SKIN_KEY);
    if (legacy !== null) {
      const hit = LEGACY_SKIN_MAP[legacy] ?? { form: "", palette: "" };
      localStorage.setItem(FORM_KEY, hit.form);
      localStorage.setItem(PALETTE_KEY, hit.palette);
      localStorage.removeItem(LEGACY_SKIN_KEY);
      return hit;
    }
    const form = localStorage.getItem(FORM_KEY) ?? "";
    const palette = localStorage.getItem(PALETTE_KEY) ?? "";
    // 存档里是已下架的取值就回落默认
    return {
      form: FORMS.some((f) => f.id === form) ? form : "",
      palette: PALETTES.some((c) => c.id === palette) ? palette : "",
    };
  } catch {
    return { form: "", palette: "" };
  }
}

/** 编辑台外壳的风格 + 配色:开机恢复、改了就挂到 <html> 上并存起来 */
export function useLook() {
  const [look] = useState(restoreLook);
  const [form, setForm] = useState<string>(look.form);
  const [palette, setPalette] = useState<string>(look.palette);
  // 换风格 = 连它的「原配」配色一起换上。
  // 曾经在这里加过「你手动挑过配色就不换」的判断,结果是:只要挑过一次配色,
  // 自动匹配就再也不触发,功能等于不存在。换风格本来就是「整套换掉」的动作,
  // 想要别的配色,换完再点一下配色下拉就行。
  const pickForm = (id: string) => {
    setForm(id);
    setPalette(FORMS.find((f) => f.id === id)?.mate ?? "");
  };

  useEffect(() => {
    const el = document.documentElement;
    if (form) el.dataset.form = form;
    else delete el.dataset.form;
    if (palette) el.dataset.palette = palette;
    else delete el.dataset.palette;
    try {
      localStorage.setItem(FORM_KEY, form);
      localStorage.setItem(PALETTE_KEY, palette);
    } catch {
      // 隐私模式:外观只在本次会话生效
    }
  }, [form, palette]);

  return { form, palette, pickForm, setPalette };
}
