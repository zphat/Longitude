// Hand tool (H): drag to pan. Space or the middle button pans from any tool.

export function createHandTool(core) {
  return {
    id: "hand",
    label: "Hand",
    icon: "hand",
    key: "H",
    cursor: "grab",
    pointerDown(e) {
      core.startPan(e);
    },
    pointerMove() {},
    pointerUp() {},
    keyDown() {
      return false;
    },
  };
}
