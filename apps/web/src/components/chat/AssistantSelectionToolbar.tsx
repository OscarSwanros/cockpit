import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  SELECTION_MULTI_CLICK_INTERVAL_MS,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";

type CitableSelection = {
  citation: AssistantCitation;
  position: SelectionActionPoint;
  sourceAnchor: AssistantCitationSourceAnchor;
};

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [selection, setSelection] = useState<CitableSelection | null>(null);
  const tripleClickAction = useClientSettings((settings) => settings.tripleClickAction);
  const citesOnTripleClick = useEffectEvent(() => tripleClickAction === "cite");
  const citeSelection = useEffectEvent(({ citation, sourceAnchor }: CitableSelection) => {
    if (citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) return false;
    if (!onCite(citation, sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    return true;
  });
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const resolve = (pointer: SelectionActionPoint | null): CitableSelection | null => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) return null;
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) return null;
      // A selection can cross blocks with different clipping ancestors.
      const common = captured.range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible = false;
      for (; node && !visible; node = walker.nextNode()) {
        if (!captured.range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === captured.range.startContainer) {
          fragment.setStart(node, captured.range.startOffset);
        }
        if (node === captured.range.endContainer) {
          fragment.setEnd(node, captured.range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) return null;
      const rects = captured.range.getClientRects();
      const pointerOnText =
        pointer !== null &&
        Array.from(rects).some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      return {
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer: pointerOnText ? pointer : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      };
    };
    // Clicks that continue a burst after a triple-click cite would otherwise close the new
    // comment box and reselect the paragraph, so they are absorbed until the burst ends.
    let absorb: { point: SelectionActionPoint; until: number } | null = null;
    const absorbBurstClick = (event: MouseEvent) => {
      if (!absorb) return;
      const continuesBurst =
        event.button === 0 &&
        event.timeStamp <= absorb.until &&
        Math.abs(event.clientX - absorb.point.x) <= 8 &&
        Math.abs(event.clientY - absorb.point.y) <= 8;
      if (!continuesBurst) {
        if (event.type === "pointerdown") absorb = null;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "mouseup")
        absorb.until = event.timeStamp + SELECTION_MULTI_CLICK_INTERVAL_MS;
    };
    const burstEvents = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"];
    const update = (pointer: SelectionActionPoint | null, clicks: number) => {
      const target = resolve(pointer);
      if (target && clicks >= 3 && citesOnTripleClick() && citeSelection(target)) {
        actionsRef.current?.cancel();
        setSelection(null);
        if (pointer) {
          absorb = { point: pointer, until: performance.now() + SELECTION_MULTI_CLICK_INTERVAL_MS };
        }
        return;
      }
      setSelection(target);
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      if (toolbar.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };
    const citeFromContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const pointer = { x: event.clientX, y: event.clientY };
      const target = resolve(pointer);
      if (!target) return;
      const onSelectedText = Array.from(target.sourceAnchor.range.getClientRects()).some(
        (line) =>
          pointer.x >= line.left &&
          pointer.x <= line.right &&
          pointer.y >= line.top &&
          pointer.y <= line.bottom,
      );
      const api = readLocalApi();
      if (!onSelectedText || !api) return;
      event.preventDefault();
      const tooLong = target.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
      void api.contextMenu
        .show(
          [
            {
              id: "cite",
              label: tooLong ? "Cite (selection too long)" : "Cite",
              icon: "message-square-plus",
              disabled: tooLong,
            },
            { id: "copy", label: "Copy", icon: "copy" },
          ],
          pointer,
        )
        .then((action) => {
          if (action === "copy") {
            document.execCommand("copy");
          } else if (action === "cite") {
            citeSelection(target);
          }
        });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    viewport.addEventListener("contextmenu", citeFromContextMenu);
    for (const type of burstEvents) window.addEventListener(type, absorbBurstClick, true);
    return () => {
      for (const type of burstEvents) window.removeEventListener(type, absorbBurstClick, true);
      viewport.removeEventListener("contextmenu", citeFromContextMenu);
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}
