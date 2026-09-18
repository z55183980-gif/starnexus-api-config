import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 按厂商给模型分组，组名用灰色标题。
 *
 * 只按名字归类，不判断"能不能用" —— 网关有三十多个渠道做格式转换，
 * DeepSeek、Gemini 这些照样能走 Codex，靠模型名猜兼容性只会误导用户。
 */
const FAMILIES: { name: string; test: (m: string) => boolean }[] = [
  { name: "GPT", test: (m) => /^(gpt|o[1-9]|chatgpt|codex)/.test(m) },
  { name: "Claude", test: (m) => m.startsWith("claude") },
  { name: "Gemini", test: (m) => m.startsWith("gemini") },
  { name: "DeepSeek", test: (m) => m.startsWith("deepseek") },
  { name: "Qwen 通义", test: (m) => /^(qwen|qwq)/.test(m) },
  { name: "GLM 智谱", test: (m) => /^(glm|chatglm)/.test(m) },
  { name: "Kimi 月之暗面", test: (m) => /^(moonshot|kimi)/.test(m) },
  { name: "Grok", test: (m) => m.startsWith("grok") },
  { name: "豆包", test: (m) => /^(doubao|ep-)/.test(m) },
];

function groupByFamily(models: string[]): { name: string; items: string[] }[] {
  const buckets = FAMILIES.map((f) => ({ name: f.name, items: [] as string[] }));
  const others: string[] = [];

  for (const m of models) {
    const lower = m.toLowerCase();
    const i = FAMILIES.findIndex((f) => f.test(lower));
    if (i >= 0) buckets[i].items.push(m);
    else others.push(m);
  }

  const out = buckets.filter((b) => b.items.length > 0);
  if (others.length) out.push({ name: "其他", items: others });
  return out;
}

/**
 * 模型选择器：能手打，也能点开看全部。
 *
 * 原生 <datalist> 会按输入框里的文字过滤候选，填了 gpt-5.3-codex 之后
 * 就只剩 gpt-5.3-codex-spark 一条，其余全被浏览器藏掉 —— 所以自己画一个，
 * 展开时永远列出获取到的全部模型，不做任何过滤。
 */
export function ModelPicker(props: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const { value, onChange, options, placeholder, disabled } = props;
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupByFamily(options), [options]);

  // 点到别处就收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 展开时把当前选中项滚到可见处
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(".mp-item.on");
    el?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const hasOptions = options.length > 0;

  return (
    <div className="mp" ref={boxRef}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => hasOptions && setOpen(true)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
      />
      {hasOptions && (
        <button
          type="button"
          className="mp-toggle"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          aria-label={open ? "收起" : "展开全部模型"}
          aria-expanded={open}
        >
          <svg viewBox="0 0 11 7" width="11" height="7" aria-hidden="true">
            <path
              d="M1 1l4.5 4.5L10 1"
              stroke="currentColor"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {open && hasOptions && (
        <div className="mp-list" ref={listRef} role="listbox">
          {groups.map((g) => (
            <div key={g.name} className="mp-group">
              <div className="mp-group-label">{g.name}</div>
              {g.items.map((m) => (
                <div
                  key={m}
                  role="option"
                  aria-selected={m === value}
                  className={`mp-item ${m === value ? "on" : ""}`}
                  onMouseDown={(e) => {
                    // mousedown 而不是 click：避免输入框先失焦导致列表提前收起
                    e.preventDefault();
                    onChange(m);
                    setOpen(false);
                  }}
                >
                  {m}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
