import Cocoa
import Darwin
import Foundation
import TradeOrderSystemCore
import WebKit

final class DragRegionView: NSView {
    private var dragRects: [NSRect] = []
    private var exclusionRects: [NSRect] = []

    override var mouseDownCanMoveWindow: Bool { true }

    func update(dragRects: [NSRect], exclusionRects: [NSRect]) {
        self.dragRects = dragRects
        self.exclusionRects = exclusionRects
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard dragRects.contains(where: { $0.contains(point) }),
              !exclusionRects.contains(where: { $0.contains(point) }) else { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        // 连按两下：按「系统设置 › 桌面与程序坞 › 连按窗口标题栏以…」缩放或最小化，和普通标题栏一样。
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window?.miniaturize(nil)
            case "None": break
            default: window?.zoom(nil)
            }
            return
        }
        window?.performDrag(with: event)
    }
}

private let serverPortDefaultsKey = "LocalServerPort"

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, @unchecked Sendable {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var dragRegionView: DragRegionView?
    private var auxiliaryWindows: [NSWindow] = []

    private let startupQueue = DispatchQueue(label: "com.local.tradeordersystem.server-startup", qos: .userInitiated)
    private let processLock = NSLock()
    nonisolated(unsafe) private var serverProcess: Process?
    nonisolated(unsafe) private var serverOutput = ""
    nonisolated(unsafe) private var stopping = false
    /// Recent automatic restarts of the local server; more than 3 in 5 minutes stops retrying.
    nonisolated(unsafe) private var serverRestarts: [Date] = []

    private var localIdentity: LocalServiceIdentity?
    private var originPolicy: LocalOriginPolicy?
    private var appHasLoaded = false

    private var allowTermination = false
    private var terminationInProgress = false
    private var terminationReplyPending = false
    private var flushAttemptID: UUID?
    private var dialogProbeID: UUID?
    private var checkedForUpdatesAtLaunch = false
    /// The web content process crashed and the page was reloaded; say so once it is back.
    private var reloadedAfterCrash = false
    /// Exit code of server.js when another running copy holds the same data folder.
    nonisolated private static let serverLockedExitCode: Int32 = 75
    /// Automatic update checks tick this often; AppUpdater itself skips a tick within 6 hours of a good check.
    private static let updateCheckTick: TimeInterval = 30 * 60

    /// 界面缩放（像浏览器 ⌘-/⌘+）：原型是 1440×920 窗口缩到浏览器里看的，所以默认 85% 让软件和原型一样紧凑。
    private static let uiZoomKey = "uiZoom"
    private static let uiZoomDefault = 0.85
    private static let uiZoomRange = 0.7...1.2
    private var uiZoom: Double {
        let stored = UserDefaults.standard.object(forKey: Self.uiZoomKey) as? Double ?? Self.uiZoomDefault
        return Self.clampZoom(stored)
    }

    private static func clampZoom(_ value: Double) -> Double {
        guard value.isFinite else { return uiZoomDefault }
        let stepped = (value * 20).rounded() / 20
        return min(max(stepped, uiZoomRange.lowerBound), uiZoomRange.upperBound)
    }

    private lazy var updater = AppUpdater(
        prepareToQuit: { [unowned self] completion in self.prepareForUpdateRelaunch(completion) },
        quit: { [unowned self] in
            self.allowTermination = true
            // ⌘Q pressed while the update was saving: answer that request instead of starting another.
            if self.terminationReplyPending {
                self.terminationReplyPending = false
                NSApp.reply(toApplicationShouldTerminate: true)
            } else {
                NSApp.terminate(nil)
            }
        },
        report: { [unowned self] status in self.showUpdateStatus(status) },
        confirmInstall: { [unowned self] version, notes in await self.confirmUpdate(version: version, notes: notes) },
        unsavedFormsBlocker: { [unowned self] in await self.unsavedFormsBlocker() }
    )

    /// Hands updater progress to the page, which draws it on the 更新 button.
    private func showUpdateStatus(_ status: UpdateStatus) {
        guard appHasLoaded, let webView,
              let data = try? JSONSerialization.data(withJSONObject: status.payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.otsAppUpdateStatus && window.otsAppUpdateStatus(\(json))", completionHandler: nil)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 单实例：已经有一份在运行（比如在 DMG 里又打开了一份），把那一份叫到前面，自己退出。
        // 两份同时开会各起一个服务、写同一个数据库，保存永远冲突，还会轮流改写端口。
        if let identifier = Bundle.main.bundleIdentifier {
            let me = ProcessInfo.processInfo.processIdentifier
            if let other = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
                .first(where: { $0.processIdentifier != me && !$0.isTerminated }) {
                other.activate(options: [])
                allowTermination = true
                NSApp.terminate(nil)
                return
            }
        }
        createMainMenu()
        createWindow()
        updater.cleanupInterruptedDownload()
        startLocalServer()
        scheduleAutomaticUpdateCheck()
    }

    /// Long-running sessions still hear about new versions (the app often stays open for a week).
    private func scheduleAutomaticUpdateCheck() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.updateCheckTick) { [weak self] in
            guard let self else { return }
            if self.appHasLoaded { self.updater.checkForUpdates(userInitiated: false) }
            self.scheduleAutomaticUpdateCheck()
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard appHasLoaded, checkedForUpdatesAtLaunch else { return }
        updater.checkForUpdates(userInitiated: false)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowTermination { return .terminateNow }
        if terminationInProgress {
            // A quit or an update is already saving: remember this request and answer it when that
            // finishes (it used to stay unanswered, leaving the app stuck "quitting").
            terminationReplyPending = true
            if updatePreparing { showPageToast("正在准备更新，请稍候…") }
            return .terminateLater
        }
        beginTermination(replyToApplication: true)
        return .terminateLater
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowTermination { return true }
        guard sender === window else { return true }
        if updatePreparing {
            showPageToast("正在准备更新，请稍候…")
        } else if !terminationInProgress {
            beginTermination(replyToApplication: false)
        }
        return false
    }

    func windowDidEnterFullScreen(_ notification: Notification) { setFullScreenClass(true) }
    func windowDidExitFullScreen(_ notification: Notification) { setFullScreenClass(false) }

    /// 全屏时没有红黄绿按钮，侧栏顶部不用再让出标题栏高度。
    private func setFullScreenClass(_ on: Bool) {
        webView?.evaluateJavaScript("document.documentElement.classList.toggle('mac-fullscreen', \(on))", completionHandler: nil)
    }

    private func showPageToast(_ text: String) {
        guard appHasLoaded, let webView,
              let data = try? JSONSerialization.data(withJSONObject: [text]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.uiToast && window.uiToast(\(json)[0])", completionHandler: nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        flushAttemptID = nil
        processLock.lock()
        stopping = true
        let process = serverProcess
        processLock.unlock()
        if let process {
            terminate(process, timeout: 2.0)
        }
    }

    private func createWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.userContentController.add(self, name: "windowDragRegions")
        config.userContentController.add(self, name: "appUpdate")
        config.userContentController.add(self, name: "appBooted")
        config.userContentController.add(self, name: "uiZoom")
        config.userContentController.add(self, name: "appTheme")
        installUserScripts(config.userContentController)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.pageZoom = CGFloat(uiZoom)
        self.webView = webView

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "外贸订单跟进系统"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .clear
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 1100, height: 720)
        window.center()
        window.delegate = self

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1440, height: 920))
        container.autoresizingMask = [.width, .height]
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)

        let dragRegionView = DragRegionView(frame: container.bounds)
        dragRegionView.autoresizingMask = [.width, .height]
        container.addSubview(dragRegionView)
        self.dragRegionView = dragRegionView

        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    /// Zoom first (document start), then the drag-region bridge. Re-run whenever the zoom changes:
    /// the zoom script text is fixed when added, so a reload used to get the zoom from launch time.
    private func installUserScripts(_ controller: WKUserContentController) {
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: "window.__otsUiZoom = \(uiZoom);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.addUserScript(WKUserScript(
            source: Self.dragBridgeSource,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
    }

    private static let dragBridgeSource = """
    (() => {
      if (window.__tradeOrderWindowDragRegionsInstalled) return;
      window.__tradeOrderWindowDragRegionsInstalled = true;
      const handler = window.webkit?.messageHandlers?.windowDragRegions;
      if (!handler) return;
      const toRect = element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      };
      let scheduled = false;
      const report = () => {
        scheduled = false;
        const region = document.querySelector('.topbar-left-drag-region');
        if (!region) return;
        const topbar = region.closest('.topbar');
        // 弹窗、抽屉、通知面板打开时不留拖动区，免得盖住它们顶部的按钮。
        if (document.querySelector('.modal-backdrop.open, .notif-panel:not([hidden])')) {
          handler.postMessage({ region: toRect(region), regions: [], exclusions: [] });
          return;
        }
        // 整条顶栏（含上下留白）和侧栏顶部的标志区都能拖动窗口；按钮、输入框、搜索框除外。
        const regionRect = topbar ? toRect(topbar) : toRect(region);
        const regions = [regionRect];
        const brand = document.querySelector('.sidebar .logo');
        if (brand) {
          const brandRect = brand.getBoundingClientRect();
          regions.push(toRect(brand));
          // 侧栏顶上给红黄绿让出的那一条（Logo 上面）也能拖，和普通标题栏一样。
          const sidebar = brand.closest('.sidebar');
          const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
          if (sidebarRect && brandRect.top - sidebarRect.top > 1) {
            regions.push({ x: sidebarRect.left, y: sidebarRect.top, width: sidebarRect.width, height: brandRect.top - sidebarRect.top });
          }
        }
        const exclusions = [...(topbar || region).querySelectorAll('input, button, select, textarea, a, [contenteditable="true"], .search, .global-search-panel, .top-actions')]
          .map(toRect);
        // 打开的下拉、右键菜单伸进顶栏时，那一块是点菜单，不是拖窗口。
        document.querySelectorAll('.app-select-popover:not([hidden]), [role="menu"]:not([hidden]), [role="listbox"]:not([hidden])')
          .forEach(element => exclusions.push(toRect(element)));
        handler.postMessage({ region: regionRect, regions, exclusions });
      };
      const scheduleReport = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(report);
      };
      const start = () => {
        const region = document.querySelector('.topbar-left-drag-region');
        if (!region) return;
        new ResizeObserver(scheduleReport).observe(region);
        new MutationObserver(scheduleReport).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
        window.addEventListener('resize', scheduleReport, { passive: true });
        scheduleReport();
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    })();
    """

    /// Only the main window's top frame, on the local app origin, may drive the native side
    /// (an attachment window shares the configuration and its handlers).
    private func isFromAppPage(_ message: WKScriptMessage) -> Bool {
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              let url = webView.url else { return false }
        return originPolicy?.contains(url) == true
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard isFromAppPage(message) else { return }
        if message.name == "appTheme" {
            // 原生弹窗、菜单、附件窗口跟页面用同一套深浅色；跟随系统时交还给系统。
            switch (message.body as? [String: Any])?["theme"] as? String {
            case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
            case "light": NSApp.appearance = NSAppearance(named: .aqua)
            default: NSApp.appearance = nil
            }
            return
        }
        if message.name == "uiZoom" {
            guard let url = webView?.url, originPolicy?.contains(url) == true else { return }
            let body = message.body as? [String: Any]
            if let zoom = (body?["zoom"] as? NSNumber)?.doubleValue ?? (message.body as? NSNumber)?.doubleValue {
                setUiZoom(zoom)
            }
            return
        }
        if message.name == "appUpdate" {
            guard let url = webView?.url, originPolicy?.contains(url) == true else { return }
            updater.checkForUpdates(userInitiated: true)
            return
        }
        if message.name == "appBooted" {
            // 页面主脚本跑完并且读库后画出了界面：更新后的第一次，据此告诉安装脚本「新版本能用」。
            guard let url = webView?.url, originPolicy?.contains(url) == true else { return }
            updater.pageDidBoot()
            return
        }
        guard message.name == "windowDragRegions",
              let url = webView?.url,
              originPolicy?.contains(url) == true,
              let body = message.body as? [String: Any],
              let region = body["region"] as? [String: Any],
              let dragRegionView else { return }
        let regions = body["regions"] as? [[String: Any]] ?? [region]
        let dragRects = nativeRects(from: regions, in: dragRegionView)
        let exclusions = nativeRects(from: body["exclusions"] as? [[String: Any]] ?? [], in: dragRegionView)
        dragRegionView.update(dragRects: dragRects, exclusionRects: exclusions)
    }

    private func nativeRects(from values: [[String: Any]], in view: NSView) -> [NSRect] {
        // 页面坐标是 CSS 像素，缩放后要乘上 pageZoom 才是窗口里的点。
        let zoom = webView?.pageZoom ?? 1
        return values.compactMap { value in
            guard let cssX = finiteNumber(value["x"]),
                  let cssY = finiteNumber(value["y"]),
                  let cssWidth = finiteNumber(value["width"]),
                  let cssHeight = finiteNumber(value["height"]),
                  cssWidth > 0, cssHeight > 0 else { return nil }
            let x = cssX * zoom, y = cssY * zoom, width = cssWidth * zoom, height = cssHeight * zoom
            let rect = NSRect(x: x, y: view.bounds.height - y - height, width: width, height: height)
                .intersection(view.bounds)
            return rect.isNull || rect.isEmpty ? nil : rect
        }
    }

    private func finiteNumber(_ value: Any?) -> CGFloat? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.doubleValue
        guard result.isFinite else { return nil }
        return CGFloat(result)
    }

    private func createMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "关于外贸订单跟进系统", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        let settingsItem = NSMenuItem(title: "设置…", action: #selector(openSettingsFromMenu(_:)), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        let updateItem = NSMenuItem(title: "检查更新…", action: #selector(checkForUpdatesFromMenu(_:)), keyEquivalent: "")
        updateItem.target = self
        appMenu.addItem(updateItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "隐藏外贸订单跟进系统", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.option, .command]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(title: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "退出外贸订单跟进系统", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(NSMenuItem(title: "撤销", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        let zoomIn = NSMenuItem(title: "放大", action: #selector(zoomInFromMenu(_:)), keyEquivalent: "=")
        let zoomInPlus = NSMenuItem(title: "放大", action: #selector(zoomInFromMenu(_:)), keyEquivalent: "+")
        // 隐藏项照样响应快捷键：⌘= 和 ⌘+ 都能放大。
        zoomInPlus.isHidden = true
        let zoomOut = NSMenuItem(title: "缩小", action: #selector(zoomOutFromMenu(_:)), keyEquivalent: "-")
        let zoomDefault = NSMenuItem(title: "默认大小（85%）", action: #selector(zoomDefaultFromMenu(_:)), keyEquivalent: "0")
        let zoomActual = NSMenuItem(title: "实际大小（100%）", action: #selector(zoomActualFromMenu(_:)), keyEquivalent: "")
        for item in [zoomIn, zoomInPlus, zoomOut, zoomDefault, zoomActual] {
            item.target = self
            viewMenu.addItem(item)
        }
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // 「窗口」菜单：⌘M、⌘W、⌃⌘F 靠菜单项才生效（附件窗口以前只能用鼠标关）。关闭主窗口 = 退出软件。
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(NSMenuItem(title: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        let fullScreenItem = NSMenuItem(title: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreenItem.keyEquivalentModifierMask = [.control, .command]
        windowMenu.addItem(fullScreenItem)
        windowMenu.addItem(NSMenuItem(title: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(NSMenuItem(title: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func openSettingsFromMenu(_ sender: Any?) {
        window?.makeKeyAndOrderFront(nil)
        guard appHasLoaded else { return }
        webView?.evaluateJavaScript("window.setPage && window.setPage('settings')", completionHandler: nil)
    }

    @objc private func zoomInFromMenu(_ sender: Any?) { setUiZoom(uiZoom + 0.05) }
    @objc private func zoomOutFromMenu(_ sender: Any?) { setUiZoom(uiZoom - 0.05) }
    @objc private func zoomDefaultFromMenu(_ sender: Any?) { setUiZoom(Self.uiZoomDefault) }
    @objc private func zoomActualFromMenu(_ sender: Any?) { setUiZoom(1) }

    /// 改缩放：记住、应用到网页，并告诉页面（设置页的「界面大小」、侧栏顶部留白跟着变）。
    private func setUiZoom(_ value: Double) {
        let zoom = Self.clampZoom(value)
        UserDefaults.standard.set(zoom, forKey: Self.uiZoomKey)
        guard let webView else { return }
        installUserScripts(webView.configuration.userContentController)
        webView.pageZoom = CGFloat(zoom)
        webView.evaluateJavaScript("window.__otsUiZoom = \(zoom); window.otsUiZoomChanged && window.otsUiZoomChanged(\(zoom));")
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.absoluteString == "about:blank" || originPolicy?.contains(url) == true {
            decisionHandler(.allow)
            return
        }

        decisionHandler(.cancel)
        let userInitiated = navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil
        if userInitiated, originPolicy?.mayOpenExternally(url) == true {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = navigationAction.request.url else { return nil }
        guard originPolicy?.contains(url) == true else {
            // window.open 打开的外部网址（物流官网等）交给默认浏览器；以前直接返回 nil，点了没反应。
            if originPolicy?.mayOpenExternally(url) == true { NSWorkspace.shared.open(url) }
            return nil
        }

        let popup = WKWebView(frame: NSRect(x: 0, y: 0, width: 960, height: 720), configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        let popupWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        popupWindow.title = "订单附件"
        popupWindow.contentView = popup
        popupWindow.center()
        popupWindow.makeKeyAndOrderFront(nil)
        auxiliaryWindows.append(popupWindow)
        return popup
    }

    /// `<input type="file">`（导入 JSON、导入数据文件）需要 App 自己弹选择框；不实现时 WebKit 当作用户点了取消，按钮没反应。
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.prompt = "选择"
        guard let window = webView.window else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
            return
        }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// WebKit's page process died (memory pressure, a WebKit bug): reload instead of a blank window.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView, let identity = localIdentity else { return }
        appHasLoaded = false
        reloadedAfterCrash = true
        loadApp(identity: identity)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView,
              let url = webView.url,
              originPolicy?.contains(url) == true else { return }
        appHasLoaded = true
        setFullScreenClass(window?.styleMask.contains(.fullScreen) == true)
        if reloadedAfterCrash {
            reloadedAfterCrash = false
            showPageToast("页面意外关闭，已重新载入")
        }
        updater.pageDidLoad()
        if !checkedForUpdatesAtLaunch {
            checkedForUpdatesAtLaunch = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                self?.updater.checkForUpdates(userInitiated: false)
            }
        }
    }

    @objc private func checkForUpdatesFromMenu(_ sender: Any?) {
        updater.checkForUpdates(userInitiated: true)
    }

    private var updatePreparing = false

    /// Same save flush as quitting, but a failed save cancels the update instead of asking.
    /// After the save, the database is backed up ("安装更新前"), so a new version that damages
    /// data on its first start still leaves a fresh copy. A failed backup cancels the update.
    private func prepareForUpdateRelaunch(_ completion: @escaping @MainActor (String?) -> Void) {
        guard !terminationInProgress else {
            completion("正在退出软件，已取消本次更新。")
            return
        }
        terminationInProgress = true
        updatePreparing = true
        flushPendingSave { [weak self] result in
            guard let self else { return }
            guard case .success = result else {
                self.finishUpdatePreparation(blocker: "数据还没确认保存，已取消本次更新。", completion: completion)
                return
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                let blocker = await self.backupBeforeUpdate()
                self.finishUpdatePreparation(blocker: blocker, completion: completion)
            }
        }
    }

    private func finishUpdatePreparation(blocker: String?, completion: @escaping @MainActor (String?) -> Void) {
        terminationInProgress = false
        updatePreparing = false
        completion(blocker)
        // The update did not quit the app (cancelled, or the installer failed to start): a ⌘Q pressed
        // meanwhile is answered "no" so AppKit is not left waiting.
        if !allowTermination && terminationReplyPending {
            terminationReplyPending = false
            NSApp.reply(toApplicationShouldTerminate: false)
        }
    }

    @MainActor
    private func backupBeforeUpdate() async -> String? {
        guard appHasLoaded, let webView else { return nil }
        do {
            let value = try await webView.callAsyncJavaScript(
                "if (typeof window.otsBackupBeforeUpdate !== 'function') return true; return await window.otsBackupBeforeUpdate();",
                arguments: [:],
                in: nil,
                contentWorld: .page
            )
            if (value as? Bool) == true { return nil }
            let reason = (value as? String) ?? "未知原因"
            return "更新前的数据备份没有完成（\(reason)），已取消本次更新。"
        } catch {
            return "更新前的数据备份没有完成（\(error.localizedDescription)），已取消本次更新。"
        }
    }

    /// Asked before every install (button, menu or notification): what changes, and that the app restarts.
    @MainActor
    private func confirmUpdate(version: String, notes: String) async -> Bool {
        let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        var message = "当前是 V\(current)。安装时会先保存并备份数据，然后关闭软件、换上新版本并重新打开，大约需要一分钟。"
        // Plain loop with explicit types: the chained map/filter version was too slow for the type checker.
        var lines: [String] = []
        for rawLine in notes.split(separator: "\n") {
            var line: String = String(rawLine).trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("**Full Changelog**") { continue }
            if line.hasPrefix("## ") { line = String(line.dropFirst(3)) }
            if line.count > 120 { line = String(line.prefix(120)) + "…" }
            lines.append(line)
        }
        if !lines.isEmpty {
            message += "\n\n这个版本的改动：\n" + lines.prefix(5).joined(separator: "\n")
        }
        return await presentDialog(AppDialog(
            title: "发现新版本 V\(version)",
            message: message,
            sub: "软件更新",
            confirmText: "现在安装并重启",
            cancelText: "以后再说"
        ))
    }

    /// Unsaved forms stop an update before anything is downloaded.
    @MainActor
    private func unsavedFormsBlocker() async -> String? {
        guard appHasLoaded, let webView else { return nil }
        let value = try? await webView.callAsyncJavaScript(
            "return typeof window.otsUnsavedForms === 'function' ? window.otsUnsavedForms() : [];",
            arguments: [:],
            in: nil,
            contentWorld: .page
        )
        guard let forms = value as? [String], !forms.isEmpty else { return nil }
        return "\(forms.joined(separator: "、")) 里还有没保存的修改，已取消本次更新。请先保存或关闭，再点「更新」。"
    }

    private func startLocalServer() {
        guard let resources = Bundle.main.resourceURL else {
            showError("未找到应用资源目录。")
            return
        }
        let server = resources.appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: server.path) else {
            showError("未找到本地数据服务文件。")
            return
        }
        guard let node = findNode() else {
            showError("未找到内置 Node.js，无法启动本地数据服务。")
            return
        }

        startupQueue.async { [weak self] in
            self?.launchServerWithRetries(node: node, server: server, resources: resources)
        }
    }

    nonisolated private func launchServerWithRetries(node: String, server: URL, resources: URL) {
        var lastFailure = "服务未响应"
        // 先试上次成功的端口：端口不变，网页的 localStorage（主题、配色、通知已读）才能跨启动保留。
        let preferredPort = UserDefaults.standard.object(forKey: serverPortDefaultsKey) as? Int
        for attempt in 0..<6 {
            if shouldStopServer() { return }
            let identity = attempt == 0 ? LocalServiceIdentity.random(preferredPort: preferredPort) : LocalServiceIdentity.random()
            let process = configuredServerProcess(node: node, server: server, resources: resources, identity: identity)
            do {
                try process.run()
                setServerProcess(process)
            } catch {
                lastFailure = error.localizedDescription
                continue
            }

            let probe = waitForHealthyServer(identity: identity, process: process, timeout: 12)
            if probe.healthy {
                watchServer(process, node: node, server: server, resources: resources, identity: identity)
                UserDefaults.standard.set(identity.port, forKey: serverPortDefaultsKey)
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.shouldStopServer() else { return }
                    self.localIdentity = identity
                    self.originPolicy = LocalOriginPolicy(port: identity.port)
                    self.loadApp(identity: identity)
                }
                return
            }
            lastFailure = probe.message
            terminate(process, timeout: 0.75)
            clearServerProcess(if: process)
            // Another copy of the app holds the data folder: a new port will not help.
            if !process.isRunning, process.terminationStatus == Self.serverLockedExitCode {
                lastFailure = "另一个外贸订单跟进系统正在使用这份数据。请先退出另一个窗口，再点「重试」。"
                break
            }
        }

        let diagnostic = recentServerOutput()
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.shouldStopServer() else { return }
            let detail = diagnostic.isEmpty ? lastFailure : "\(lastFailure)\n\n\(diagnostic)"
            self.showError("本地数据服务启动失败：\(detail)")
        }
    }

    nonisolated private func configuredServerProcess(node: String,
                                         server: URL,
                                         resources: URL,
                                         identity: LocalServiceIdentity) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [server.path]
        let parentEnvironment = ProcessInfo.processInfo.environment
        var environment: [String: String] = [:]
        for key in ["HOME", "TMPDIR", "LANG", "LC_CTYPE", "TRADE_APP_DATA_DIR"] {
            if let value = parentEnvironment[key] { environment[key] = value }
        }
        environment["TRADE_APP_NO_OPEN"] = "1"
        // The server exits by itself when this app is gone (force quit, crash), instead of
        // staying behind on the port and the database.
        environment["TRADE_APP_EXIT_WITH_PARENT"] = "1"
        environment["TRADE_APP_PORT"] = String(identity.port)
        environment["TRADE_API_TOKEN"] = identity.apiToken
        environment["TRADE_INSTANCE_NONCE"] = identity.instanceNonce
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        process.currentDirectoryURL = resources

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        captureOutput(from: outputPipe.fileHandleForReading)
        captureOutput(from: errorPipe.fileHandleForReading)
        return process
    }

    /// The local server died while the app is running: start it again on the same port with the same
    /// token, so the page keeps working and its pending save retries. If that port fails, start over
    /// (new port, page reloads). More than 3 restarts in 5 minutes: stop and say so.
    nonisolated private func watchServer(_ process: Process, node: String, server: URL, resources: URL,
                                         identity: LocalServiceIdentity) {
        process.terminationHandler = { [weak self] ended in
            let pid = ended.processIdentifier
            let status = ended.terminationStatus
            self?.startupQueue.async { [weak self] in
                self?.restartServerIfNeeded(endedPID: pid, status: status, node: node, server: server,
                                            resources: resources, identity: identity)
            }
        }
    }

    nonisolated private func restartServerIfNeeded(endedPID: Int32, status: Int32, node: String, server: URL,
                                                   resources: URL, identity: LocalServiceIdentity) {
        processLock.lock()
        let isCurrent = serverProcess?.processIdentifier == endedPID
        let stopped = stopping
        let now = Date()
        serverRestarts = serverRestarts.filter { now.timeIntervalSince($0) < 300 }
        let allowed = serverRestarts.count < 3
        if isCurrent && !stopped && allowed { serverRestarts.append(now) }
        processLock.unlock()
        guard isCurrent, !stopped else { return }
        guard allowed else {
            let diagnostic = recentServerOutput()
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.shouldStopServer() else { return }
                let detail = diagnostic.isEmpty ? "" : "\n\n\(diagnostic)"
                self.showError("本地数据服务反复意外退出（状态 \(status)），已停止自动重启。\(detail)")
            }
            return
        }
        let process = configuredServerProcess(node: node, server: server, resources: resources, identity: identity)
        do {
            try process.run()
            setServerProcess(process)
            if waitForHealthyServer(identity: identity, process: process, timeout: 12).healthy {
                watchServer(process, node: node, server: server, resources: resources, identity: identity)
                return
            }
            terminate(process, timeout: 0.75)
            clearServerProcess(if: process)
        } catch {}
        launchServerWithRetries(node: node, server: server, resources: resources)
    }

    nonisolated private func captureOutput(from handle: FileHandle) {
        handle.readabilityHandler = { [weak self] readable in
            let data = readable.availableData
            if data.isEmpty {
                readable.readabilityHandler = nil
                return
            }
            guard let text = String(data: data, encoding: .utf8) else { return }
            self?.processLock.lock()
            self?.serverOutput.append(text)
            if let count = self?.serverOutput.count, count > 8_000 {
                self?.serverOutput.removeFirst(count - 8_000)
            }
            self?.processLock.unlock()
        }
    }

    nonisolated private func waitForHealthyServer(identity: LocalServiceIdentity,
                                      process: Process,
                                      timeout: TimeInterval) -> (healthy: Bool, message: String) {
        let deadline = Date().addingTimeInterval(timeout)
        var lastMessage = "等待健康检查超时"
        while Date() < deadline, process.isRunning, !shouldStopServer() {
            let result = healthProbe(identity: identity)
            if result.healthy { return result }
            lastMessage = result.message
            Thread.sleep(forTimeInterval: 0.1)
        }
        if !process.isRunning {
            lastMessage = "服务进程提前退出（状态 \(process.terminationStatus)）"
        }
        return (false, lastMessage)
    }

    nonisolated private func healthProbe(identity: LocalServiceIdentity) -> (healthy: Bool, message: String) {
        guard let url = URL(string: "http://127.0.0.1:\(identity.port)/api/health") else {
            return (false, "健康检查 URL 无效")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 0.75)
        request.setValue("Bearer \(identity.apiToken)", forHTTPHeaderField: "Authorization")

        let semaphore = DispatchSemaphore(value: 0)
        let result = HealthProbeBox()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 0.75
        config.timeoutIntervalForResource = 1
        let session = URLSession(configuration: config)
        session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            // 数据库出错时服务端回 500，但正文里带着 storageError：照样读出来，让用户看到真正的原因。
            guard error == nil,
                  response is HTTPURLResponse,
                  let data,
                  let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                result.set(healthy: false, message: error?.localizedDescription ?? "健康检查未返回有效 JSON")
                return
            }
            guard body["instanceNonce"] as? String == identity.instanceNonce else {
                result.set(healthy: false, message: "端口响应者身份不匹配")
                return
            }
            guard body["ok"] as? Bool == true else {
                let message = body["storageError"] as? String
                    ?? (body["integrity"] as? [String: Any])?["message"] as? String
                    ?? "数据库健康检查失败"
                result.set(healthy: false, message: message)
                return
            }
            result.set(healthy: true, message: "")
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1.1)
        session.invalidateAndCancel()
        return result.value()
    }

    private func loadApp(identity: LocalServiceIdentity) {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = identity.port
        components.path = "/trade-order-system.html"
        components.queryItems = [URLQueryItem(name: "token", value: identity.apiToken)]
        components.fragment = "dashboard"
        guard let url = components.url else {
            showError("本地应用地址生成失败。")
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("Bearer \(identity.apiToken)", forHTTPHeaderField: "Authorization")
        webView?.load(request)
    }

    private func beginTermination(replyToApplication: Bool) {
        terminationInProgress = true
        terminationReplyPending = replyToApplication
        flushPendingSave { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.completeTermination(shouldTerminate: true)
            case .failure(let error):
                self.presentUnsavedExitWarning(error: error)
            }
        }
    }

    private func flushPendingSave(completion: @escaping (Result<Void, Error>) -> Void) {
        guard appHasLoaded, let webView else {
            completion(.success(()))
            return
        }

        let attemptID = UUID()
        flushAttemptID = attemptID
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard self?.flushAttemptID == attemptID else { return }
            self?.flushAttemptID = nil
            completion(.failure(TerminationError.saveTimedOut))
        }

        let script = """
        const flush = window.otsFlushBeforeQuit || window.flushPendingSave;
        if (typeof flush !== 'function') {
          throw new Error('页面未提供关闭前保存接口');
        }
        const saved = await flush();
        return saved !== false;
        """
        Task { @MainActor [weak self] in
            do {
                let value = try await webView.callAsyncJavaScript(
                    script,
                    arguments: [:],
                    in: nil,
                    contentWorld: .page
                )
                guard self?.flushAttemptID == attemptID else { return }
                self?.flushAttemptID = nil
                if (value as? Bool) == true {
                    completion(.success(()))
                } else {
                    completion(.failure(TerminationError.saveRejected))
                }
            } catch {
                guard self?.flushAttemptID == attemptID else { return }
                self?.flushAttemptID = nil
                completion(.failure(error))
            }
        }
    }

    private func presentUnsavedExitWarning(error: Error) {
        let request = AppDialog(
            title: "订单数据尚未确认保存",
            message: "\(error.localizedDescription)\n\n建议返回软件，确认“数据库已保存”后再退出。",
            sub: "退出软件",
            confirmText: "仍然退出",
            cancelText: "返回软件",
            danger: true
        )
        // A save that timed out may mean the page is stuck: ask the page first (2 s). If it answers,
        // the prompt is the page's own dialog like every other one; only a frozen page gets NSAlert.
        if (error as? TerminationError) == .saveTimedOut {
            probePageDialog(timeout: 2) { [weak self] responsive in
                guard let self else { return }
                if responsive {
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.completeTermination(shouldTerminate: await self.presentDialog(request))
                    }
                } else {
                    self.completeTermination(shouldTerminate: request.runNativeAlert())
                }
            }
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.completeTermination(shouldTerminate: await self.presentDialog(request))
        }
    }

    /// Whether the page still runs script and offers its dialog, answered within `timeout`.
    private func probePageDialog(timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
        guard appHasLoaded, let webView else {
            completion(false)
            return
        }
        let probeID = UUID()
        dialogProbeID = probeID
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard self?.dialogProbeID == probeID else { return }
            self?.dialogProbeID = nil
            completion(false)
        }
        Task { @MainActor [weak self] in
            let value = try? await webView.callAsyncJavaScript(
                "return typeof window.nativeDialog === 'function';",
                arguments: [:],
                in: nil,
                contentWorld: .page
            )
            guard self?.dialogProbeID == probeID else { return }
            self?.dialogProbeID = nil
            completion((value as? Bool) == true)
        }
    }

    /// Draws the prompt with the page's own confirm dialog; NSAlert only when the page can't.
    @MainActor
    private func presentDialog(_ request: AppDialog) async -> Bool {
        if appHasLoaded, let webView {
            window?.makeKeyAndOrderFront(nil)
            do {
                let value = try await webView.callAsyncJavaScript(
                    "if (typeof window.nativeDialog !== 'function') throw new Error('no dialog'); return await window.nativeDialog(options);",
                    arguments: ["options": request.options],
                    in: nil,
                    contentWorld: .page
                )
                return (value as? Bool) ?? false
            } catch {}
        }
        return request.runNativeAlert()
    }

    private func completeTermination(shouldTerminate: Bool) {
        terminationInProgress = false
        let replyPending = terminationReplyPending
        terminationReplyPending = false
        if shouldTerminate {
            allowTermination = true
            if replyPending {
                NSApp.reply(toApplicationShouldTerminate: true)
            } else {
                NSApp.terminate(nil)
            }
        } else if replyPending {
            NSApp.reply(toApplicationShouldTerminate: false)
        }
    }

    private func findNode() -> String? {
        let bundledNode = Bundle.main.resourceURL?.appendingPathComponent("node-runtime").path
        return [bundledNode].compactMap { $0 }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    nonisolated private func setServerProcess(_ process: Process) {
        processLock.lock()
        serverProcess = process
        processLock.unlock()
    }

    nonisolated private func clearServerProcess(if process: Process) {
        processLock.lock()
        if serverProcess === process {
            serverProcess = nil
        }
        processLock.unlock()
    }

    nonisolated private func shouldStopServer() -> Bool {
        processLock.lock()
        defer { processLock.unlock() }
        return stopping
    }

    nonisolated private func recentServerOutput() -> String {
        processLock.lock()
        defer { processLock.unlock() }
        return serverOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated private func terminate(_ process: Process, timeout: TimeInterval) {
        guard process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            Darwin.kill(process.processIdentifier, SIGKILL)
        }
    }

    /// Startup failure: 重试 starts the local server again; 退出 quits (it used to leave an empty window).
    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "外贸订单跟进系统无法启动"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "重试")
        alert.addButton(withTitle: "退出")
        if alert.runModal() == .alertFirstButtonReturn {
            startLocalServer()
        } else {
            allowTermination = true
            NSApp.terminate(nil)
        }
    }
}

private final class HealthProbeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var result: (healthy: Bool, message: String) = (false, "健康检查超时")

    func set(healthy: Bool, message: String) {
        lock.lock()
        result = (healthy, message)
        lock.unlock()
    }

    func value() -> (healthy: Bool, message: String) {
        lock.lock()
        defer { lock.unlock() }
        return result
    }
}

/// One prompt: the page's confirm dialog draws it; NSAlert is only the fallback.
struct AppDialog: Sendable {
    var title: String
    var message: String
    var sub = "软件更新"
    var confirmText = "好"
    var cancelText = ""
    var danger = false

    var options: [String: Any] {
        ["title": title, "message": message, "sub": sub,
         "confirmText": confirmText, "cancelText": cancelText, "danger": danger]
    }

    @MainActor
    func runNativeAlert() -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = danger ? .critical : .informational
        // A dangerous choice (仍然退出) is never the default: 返回软件 comes first and takes Return,
        // like the page's dialog, whose focus starts on the cancel button.
        if danger && !cancelText.isEmpty {
            alert.addButton(withTitle: cancelText)
            let confirm = alert.addButton(withTitle: confirmText)
            confirm.hasDestructiveAction = true
            return alert.runModal() == .alertSecondButtonReturn
        }
        alert.addButton(withTitle: confirmText)
        if !cancelText.isEmpty { alert.addButton(withTitle: cancelText) }
        return alert.runModal() == .alertFirstButtonReturn
    }
}

private enum TerminationError: LocalizedError {
    case saveTimedOut
    case saveRejected

    var errorDescription: String? {
        switch self {
        case .saveTimedOut:
            return "等待数据库保存超过 10 秒。"
        case .saveRejected:
            return "页面报告本次保存没有完成。"
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
