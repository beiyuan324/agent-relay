import { createRef, useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MentionComposer } from "../src/MentionComposer";
import type { ComposerDraft } from "../src/mentions";

vi.mock("../src/api", () => ({ call: vi.fn(async () => ({ data: [] })), folder: (path: string) => path, message: String }));
afterEach(cleanup);
function setup(mobile: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: mobile })));
  const onSend = vi.fn();
  function Composer() {
    const [draft, onChange] = useState<ComposerDraft>({ text: "中文消息", mentions: [] });
    return <MentionComposer device="peer" threadId="thread" cwd="/fixture" deviceName="验收电脑" enabled draft={draft} onChange={onChange} inputRef={createRef<HTMLTextAreaElement>()} onSend={onSend} placeholder="发送消息" />;
  }
  const view = render(<Composer />);
  return { input: view.getByRole("combobox"), onSend };
}
it("lets a phone keyboard insert a newline and reserves Ctrl+Enter for sending", () => {
  const { input, onSend } = setup(true);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  fireEvent(input, enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(onSend).toHaveBeenCalledTimes(1);
});
it("preserves desktop Enter and Shift+Enter behavior", () => {
  const { input, onSend } = setup(false);
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).toHaveBeenCalledTimes(1);
});
it("does not send while a Chinese input method is composing", () => {
  const { input, onSend } = setup(true);
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true, keyCode: 229 });
  expect(onSend).not.toHaveBeenCalled();
});
