import { saveChipInteractive, saveStatusLabel, type SaveStatus } from "./editorHeaderState";

interface SaveStateChipProps {
  status: SaveStatus;
  /** 点击＝立即保存（未保存/失败重试/重新裁决冲突）；干净与保存中不响应。 */
  onSave?: () => void;
  title?: string;
}

/** 编辑器头部的保存状态（工单 #66 / T04）：常驻四件之一，替代长期置灰的
 *  保存按钮——自动保存成功、保存中、失败、冲突、未保存五态可辨认。 */
export default function SaveStateChip({ status, onSave, title }: SaveStateChipProps) {
  const interactive = saveChipInteractive(status) && onSave !== undefined;
  const className = `save-chip save-chip-${status}${interactive ? " clickable" : ""}`;
  const label = saveStatusLabel(status);
  if (!interactive) {
    return (
      <span className={className} title={title}>
        {label}
      </span>
    );
  }
  return (
    <button type="button" className={className} title={title ?? label} onClick={onSave}>
      {label}
    </button>
  );
}
