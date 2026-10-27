import { EnvironmentId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ show: vi.fn(), tripleClickAction: "select" as string }));
vi.mock(import("~/hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useClientSettings: ((select: (settings: { tripleClickAction: string }) => unknown) =>
    select({ tripleClickAction: mocks.tripleClickAction })) as never,
}));
vi.mock(import("~/localApi"), async (importOriginal) => ({
  ...(await importOriginal()),
  readLocalApi: () => ({ contextMenu: { show: mocks.show, close: vi.fn() } }) as never,
}));

import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function Thread({ onCite }: { onCite: (citation: AssistantCitation) => boolean }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setViewport} style={{ width: 600, height: 300, overflow: "auto" }}>
      <div data-assistant-citation-source="message">
        <p id="first">Rename the parser before touching the cache layer.</p>
        <p id="second">Then run the integration tests again.</p>
      </div>
      <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={onCite} />
    </div>
  );
}

async function mount({ tripleClickAction = "select" } = {}) {
  mocks.show.mockReset();
  mocks.tripleClickAction = tripleClickAction;
  const onCite = vi.fn((_citation: AssistantCitation) => true);
  const screen = await render(<Thread onCite={onCite} />);
  return { onCite, [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose]() };
}

function selectWords(id: string, start: number, end: number) {
  const text = document.getElementById(id)!.firstChild!;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return range.getBoundingClientRect();
}

function rightClick(x: number, y: number) {
  const target = document.elementFromPoint(x, y)!;
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 2,
  });
  target.dispatchEvent(event);
  return event;
}

const citeButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Cite selection in composer"]');

describe("AssistantSelectionToolbar", () => {
  it("cites the selection from the right-click menu", async () => {
    await using mounted = await mount();
    const { onCite } = mounted;
    mocks.show.mockResolvedValue("cite");
    const rect = selectWords("first", 7, 17);

    const point = { x: Math.ceil(rect.left) + 4, y: Math.round(rect.top + rect.height / 2) };
    const event = rightClick(point.x, point.y);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.show).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: "cite", label: "Cite", disabled: false }),
        expect.objectContaining({ id: "copy", label: "Copy" }),
      ],
      point,
    );
    await vi.waitFor(() => expect(onCite).toHaveBeenCalledTimes(1));
    expect(onCite.mock.calls[0]![0]).toMatchObject({ messageId: "message", text: "the parser" });
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it("keeps the selection when the menu is dismissed", async () => {
    await using mounted = await mount();
    const { onCite } = mounted;
    mocks.show.mockResolvedValue(null);
    const rect = selectWords("first", 7, 17);

    rightClick(rect.left + 4, rect.top + rect.height / 2);

    await vi.waitFor(() => expect(mocks.show).toHaveBeenCalled());
    expect(onCite).not.toHaveBeenCalled();
    expect(window.getSelection()!.toString()).toBe("the parser");
  });

  it("leaves right-clicks off the selected text to the default menu", async () => {
    await using _mounted = await mount();
    selectWords("first", 7, 17);
    const other = document.getElementById("second")!.getBoundingClientRect();

    const event = rightClick(other.left + 4, other.top + other.height / 2);

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it("cites a triple-clicked paragraph when that is the chosen action", async () => {
    await using mounted = await mount({ tripleClickAction: "cite" });
    const { onCite } = mounted;

    await userEvent.tripleClick(document.getElementById("second")!);

    await vi.waitFor(() => expect(onCite).toHaveBeenCalledTimes(1), { timeout: 250 });
    expect(onCite.mock.calls[0]![0]).toMatchObject({
      text: expect.stringContaining("Then run the integration tests again."),
    });
    expect(citeButton()).toBeNull();
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it("shows the Cite button right after a triple-click by default", async () => {
    await using mounted = await mount();
    const { onCite } = mounted;

    await userEvent.tripleClick(document.getElementById("second")!);

    await expect.poll(citeButton, { timeout: 250, interval: 10 }).not.toBeNull();
    expect(onCite).not.toHaveBeenCalled();
  });

  it("still shows the Cite button after a double-click", async () => {
    await using mounted = await mount();
    const { onCite } = mounted;

    await userEvent.dblClick(document.getElementById("second")!);

    await expect.poll(citeButton, { timeout: 1500, interval: 20 }).not.toBeNull();
    expect(onCite).not.toHaveBeenCalled();
  });
});
