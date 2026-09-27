import { useId } from "react";

interface VocabInputProps {
  value: string;
  onChange: (v: string) => void;
  /** 词表提示词（datalist）：只提示不校验，输入永远自由。 */
  words: string[];
  placeholder: string;
}

/** 类型/解法输入框挂词表提示（工单 #10）：原生 datalist，构思类型圈面板
 *  将来复用同一组件。 */
export default function VocabInput({ value, onChange, words, placeholder }: VocabInputProps) {
  const id = useId();
  return (
    <>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={id}
      />
      <datalist id={id}>
        {words.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
    </>
  );
}
