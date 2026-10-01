import { Menu, Tray, nativeImage } from "electron";

export interface TrayActions {
  onShow(): void;
  onQuit(): void;
}

/**
 * The tray icon. It is what keeps the app alive after the window is closed, so
 * the daemon can finish a run; its "退出" is the only way to truly end things.
 */
export function createTray(actions: TrayActions): Tray {
  const tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("ADT 诊断客户端");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开", click: () => actions.onShow() },
      { type: "separator" },
      { label: "退出", click: () => actions.onQuit() },
    ]),
  );
  return tray;
}
