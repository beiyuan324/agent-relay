import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Transcript } from "../src/Transcript";
afterEach(cleanup);
it("mounts completed process content only when expanded", () => {
  Element.prototype.scrollIntoView = vi.fn();
  const thread = { id: "thread", turns: [{ id: "turn", status: "completed", items: [
    { id: "cmd", type: "commandExecution", command: "build", aggregatedOutput: "large command output" },
    { id: "reply", type: "agentMessage", phase: "final_answer", text: "已完成" },
  ] }] };
  const { container, getByText, queryByText } = render(<Transcript thread={thread} running={false} older={() => {}} hasOlder={false} loading={false} />);
  expect(queryByText("large command output")).toBeNull();
  const details = container.querySelector(".turn-process") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(getByText("large command output")).toBeTruthy();
});
