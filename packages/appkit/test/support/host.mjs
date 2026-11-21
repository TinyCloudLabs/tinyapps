import React, { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * Mounts a React hook with the real React DOM client and no DOM: the probe renders nothing, so the container
 * only has to take React's listeners. State, effects and updates are React's own; `act` flushes them. `value`
 * is the hook's latest result, which is what a component would see on its next render.
 */
export async function mountHook(useHook) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const noop = () => undefined;
  const ownerDocument = { nodeType: 9, addEventListener: noop, removeEventListener: noop, defaultView: { HTMLIFrameElement: class {} } };
  const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument, addEventListener: noop, removeEventListener: noop, childNodes: [], firstChild: null };
  ownerDocument.defaultView.document = ownerDocument;
  let latest;
  const Probe = () => {
    latest = useHook();
    return null;
  };
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Probe)));
  return {
    get value() {
      return latest;
    },
    /** Runs `fn` and flushes every state update and effect it causes. */
    run: (fn) => act(async () => fn()),
    unmount: () => act(async () => root.unmount()),
  };
}
