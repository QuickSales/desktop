import type { ConfigData } from "./app";

import {
    app as App,
    BrowserWindow,
    shell,
    ipcMain,
    nativeImage,
    Tray,
    Menu,
} from "electron";
import windowStateKeeper from "electron-window-state";
import { RelaunchOptions } from "electron/main";
import { URL } from "url";
import path from "path";

import { firstRun, getConfig, store, onStart, getBuildURL } from "./lib/config";
import { connectRPC, dropRPC } from "./lib/discordRPC";
import { autoLaunch } from "./lib/autoLaunch";
import { autoUpdate } from "./lib/updater";

const WindowIcon = nativeImage.createFromPath(
    path.join(__dirname, "../build/icons/icon.png"),
);
WindowIcon.setTemplateImage(true);

onStart();
autoUpdate();

type AppInterface = typeof App & {
    shouldRelaunch: boolean;
    shouldQuit: boolean;
};

let mainWindow: BrowserWindow;
let app = App as AppInterface;

/**
 * Create the main window.
 */
function createWindow() {
    const initialConfig = getConfig();
    const mainWindowState = windowStateKeeper({
        defaultWidth: 1280,
        defaultHeight: 720,
    });

    mainWindow = new BrowserWindow({
        autoHideMenuBar: true,
        title: "Revolt",
        icon: WindowIcon,

        frame: initialConfig.frame,

        webPreferences: {
            preload: path.resolve(App.getAppPath(), "bundle", "app.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },

        x: mainWindowState.x,
        y: mainWindowState.y,
        width: mainWindowState.width,
        height: mainWindowState.height,

        backgroundColor: "#191919",

        minWidth: 300,
        minHeight: 300,
    });

    if (process.platform === "win32") {
        App.setAppUserModelId(mainWindow.title);
    }

    mainWindowState.manage(mainWindow);
    mainWindow.loadURL(getBuildURL());

    /**
     * Window events
     */
    mainWindow.on("show", () => buildMenu());
    mainWindow.on("hide", () => buildMenu());

    mainWindow.on("close", (event) => {
        if (
            !app.shouldQuit &&
            !app.shouldRelaunch &&
            store.get("config").minimiseToTray
        ) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.webContents.on("before-input-event", (event, input) => {
        if (input.control && input.key === "=") {
            event.preventDefault();
            mainWindow.webContents.setZoomLevel(
                mainWindow.webContents.getZoomLevel() + 1,
            );
        }
    });

    mainWindow.webContents.on("did-finish-load", () =>
        mainWindow.webContents.send("config", getConfig()),
    );

    /**
     * Inter-process communication
     */
    ipcMain.on("getAutoStart", () =>
        autoLaunch
            .isEnabled()
            .then((v) => mainWindow.webContents.send("autoStart", v)),
    );

    ipcMain.on("setAutoStart", async (_, value: boolean) => {
        if (value) {
            await autoLaunch.enable();
            mainWindow.webContents.send("autoStart", true);
        } else {
            await autoLaunch.disable();
            mainWindow.webContents.send("autoStart", false);
        }
    });

    ipcMain.on("set", (_, arg: Partial<ConfigData>) => {
        if (typeof arg.discordRPC !== "undefined") {
            if (arg.discordRPC) {
                connectRPC();
            } else {
                dropRPC();
            }
        }

        store.set("config", {
            ...store.get("config"),
            ...arg,
        });
    });

    ipcMain.on("reload", () => mainWindow.loadURL(getBuildURL()));
    ipcMain.on("relaunch", () => {
        app.shouldRelaunch = true;
        mainWindow.close();
    });

    ipcMain.on("min", () => mainWindow.minimize());
    ipcMain.on("max", () =>
        mainWindow.isMaximized()
            ? mainWindow.unmaximize()
            : mainWindow.maximize(),
    );

    ipcMain.on("close", () => mainWindow.close());

    /**
     * System tray
     */
    const tray = new Tray(WindowIcon);

    function buildMenu() {
        tray.setContextMenu(
            Menu.buildFromTemplate([
                { label: "Revolt", type: "normal", enabled: false },
                { label: "---", type: "separator" },
                {
                    label: mainWindow.isVisible()
                        ? "Hide Revolt"
                        : "Show Revolt",
                    type: "normal",
                    click: function () {
                        if (mainWindow.isVisible()) {
                            mainWindow.hide();
                        } else {
                            mainWindow.show();
                        }
                    },
                },
                {
                    label: "Quit Revolt",
                    type: "normal",
                    click: function () {
                        app.shouldQuit = true;
                        app.quit();
                    },
                },
            ]),
        );
    }

    buildMenu();
    tray.setTitle("Revolt");
    tray.setToolTip("Revolt");
    tray.on("click", function (e) {
        if (mainWindow.isVisible()) {
            if (mainWindow.isFocused()) {
                mainWindow.hide();
            } else {
                mainWindow.focus();
            }
        } else {
            mainWindow.show();
        }
    });
}

/**
 * Only launch the application once.
 */
const acquiredLock = App.requestSingleInstanceLock();

if (!acquiredLock) {
    App.quit();
} else {
    App.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    App.whenReady().then(async () => {
        await firstRun();
        createWindow();

        App.on("activate", function () {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

/**
 * Close out application unless if instructed to relaunch.
 */
App.on("window-all-closed", function () {
    if (app.shouldRelaunch) {
        const options: RelaunchOptions = {
            args: process.argv.slice(1).concat(["--relaunch"]),
            execPath: process.execPath,
        };

        if (App.isPackaged && process.env.APPIMAGE) {
            options.execPath = process.env.APPIMAGE;
            options.args!.unshift("--appimage-extract-and-run");
        }

        App.relaunch(options);
        App.quit();

        return;
    }

    if (process.platform !== "darwin") App.quit();
});

/**
 * Add navigation handlers.
 */
App.on("web-contents-created", (_, contents) => {
    contents.on("will-navigate", (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);

        if (parsedUrl.origin !== getBuildURL()) {
            event.preventDefault();
        }
    });

    contents.setWindowOpenHandler(({ url }) => {
        if (
            url.startsWith("http:") ||
            url.startsWith("https:") ||
            url.startsWith("mailto:")
        ) {
            setImmediate(() => {
                shell.openExternal(url);
            });
        }

        return { action: "deny" };
    });
});
