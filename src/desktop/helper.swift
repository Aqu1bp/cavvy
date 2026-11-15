// Cavvy Desktop Control: reads and acts in the Mac apps the person approved, for src/desktop/session.ts, which builds
// it with swiftc on first use (src/desktop/helper.ts). It reads apps through the accessibility API, takes pictures of
// approved apps' windows with ScreenCaptureKit, and sends clicks and keys as CGEvents.
//
// The grants macOS asks for (Accessibility, Screen Recording) are this helper's own: it starts by disclaiming its
// parent's responsibility for it, so they're never Cavvy's (whose shell commands would then have them too) or the
// terminal's that `cavvy` runs in.
//
// What it may touch is checked here, right before each event goes out, against the pids Cavvy sends with it: a click
// lands only where the accessibility hit-test finds an approved app inside one of its windows, and a key goes only
// while an approved app has focus. A listen-only event tap tells the person's input from the helper's own (each event
// it posts carries OURS); an action stops as soon as they move the mouse, click, scroll or type.
//
// It never acts on what's never offered (src/desktop/apps.ts, whose list src/desktop/helper.ts compiles in), whatever
// it's sent: terminals, password managers, Cavvy and the processes it runs in.
//
// Commands arrive on stdin, one JSON object per line with an "id"; each is answered on stdout with one JSON line,
// {"id", ...} or {"id", "error", "code"?}, and every answer carries "human" (how many times the person has used the
// mouse or keyboard since the helper started) and "used" (how many of those were clicks, keys or scrolls into the apps
// the command names). {"op":"cancel","token"} (no id, no answer) stops the actions sent with that token, under way
// or still to come.

import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import ScreenCaptureKit

// MARK: - Responsibility

typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

/// Runs this program again in place (same pid, same pipes), responsible for itself, unless it already is.
func disclaim() {
    let h = dlopen(nil, RTLD_NOW)
    guard let r = dlsym(h, "responsibility_get_pid_responsible_for_pid"), let d = dlsym(h, "responsibility_spawnattrs_setdisclaim") else { return }
    if unsafeBitCast(r, to: ResponsibleFn.self)(getpid()) == getpid() { return }
    if getenv("CAVVY_DESKTOP_DISCLAIMED") != nil { return }
    setenv("CAVVY_DESKTOP_DISCLAIMED", "1", 1)
    var attr: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attr)
    _ = unsafeBitCast(d, to: DisclaimFn.self)(&attr, 1)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
    let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    var pid: pid_t = 0
    _ = posix_spawn(&pid, path, nil, &attr, &argv, environ)
    // Back here only if that failed: go on as we are.
}

disclaim()

// MARK: - Who may drive it

/// Cavvy hands a secret made for this start on file descriptor 3, a pipe only it holds (never argv or the
/// environment, which `ps` shows), and sends it back as the first line on stdin. Run any other way (no such pipe, a
/// wrong or missing secret), the helper takes no command. This stops other programs from simply running it; something
/// already running as the person could still imitate Cavvy.
func admitted() -> Bool {
    guard fcntl(3, F_GETFD) != -1 else { return false }
    var buf = [UInt8](repeating: 0, count: 256)
    var got = 0
    while got < buf.count {
        let n = buf.withUnsafeMutableBytes { read(3, $0.baseAddress! + got, $0.count - got) }
        if n <= 0 { break }
        got += n
    }
    close(3)
    let secret = Array(String(decoding: buf[0..<got], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).utf8)
    guard secret.count >= 32, let line = readLine(strippingNewline: true), let data = line.data(using: .utf8),
          let hello = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], hello["op"] as? String == "hello",
          let given = (hello["secret"] as? String).map({ Array($0.utf8) }), given.count == secret.count else { return false }
    // Compared in constant time.
    var diff: UInt8 = 0
    for i in 0..<secret.count { diff |= secret[i] ^ given[i] }
    return diff == 0
}

if !admitted() {
    FileHandle.standardError.write(Data("Cavvy Desktop Control takes commands only from the Cavvy that started it.\n".utf8))
    exit(2)
}

// MARK: - Output

let outLock = NSLock()

func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    outLock.lock()
    defer { outLock.unlock() }
    FileHandle.standardOutput.write(data + Data([0x0A]))
}

struct Refusal: Error {
    let message: String
    let code: String
    init(_ message: String, _ code: String = "error") {
        self.message = message
        self.code = code
    }
}

// MARK: - The person's input

/// Marks the events this helper posts, so the tap can tell them from the person's.
let OURS: Int64 = 0x4361_7679
let humanLock = NSLock()
/// Every input of the person's: what stops an action under way.
var humanCount = 0
/// Their clicks, keys and scrolls, by the app they went to: what makes what the agent last read of an app suspect.
/// Moving the mouse doesn't count, and nor does anything aimed at another app (Cavvy, wherever it runs).
var usedBy: [pid_t: Int] = [:]
/// Actions Cavvy stopped, by the token their commands carry (a session's turn).
var cancelled = Set<String>()
/// Cavvy has gone: whatever is under way stops.
var closing = false

func humans() -> Int {
    humanLock.lock()
    defer { humanLock.unlock() }
    return humanCount
}

/// The person's clicks, keys and scrolls into these apps since the helper started.
func used(_ pids: Set<pid_t>) -> Int {
    // A sandboxed app's Open and Save panels are another process's: typing there is using the app.
    let all = pids.isEmpty ? pids : pids.union(NSWorkspace.shared.runningApplications.filter { PANEL_SERVICES.contains($0.bundleIdentifier ?? "") }.map(\.processIdentifier))
    humanLock.lock()
    defer { humanLock.unlock() }
    return all.reduce(0) { $0 + (usedBy[$1] ?? 0) }
}

/// Cavvy, and the terminal it may run in: never offered.
let OWN: Set<pid_t> = Set(ancestors().map { pid_t($0) })

var tap: CFMachPort?

/// Watches the session's input, listening only. Needs Accessibility: until it's granted, `watching` is false.
func watch() -> Bool {
    if tap != nil { return true }
    let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .keyDown, .scrollWheel]
    var mask: CGEventMask = 0
    for t in types { mask |= CGEventMask(1) << CGEventMask(t.rawValue) }
    // Where events have been given the process they go to.
    let made = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
        } else if event.getIntegerValueField(.eventSourceUserData) != OURS {
            let target = pid_t(truncatingIfNeeded: event.getIntegerValueField(.eventTargetUnixProcessID))
            humanLock.lock()
            humanCount += 1
            if type != .mouseMoved { usedBy[target, default: 0] += 1 }
            humanLock.unlock()
        }
        return Unmanaged.passUnretained(event)
    }, userInfo: nil)
    guard let t = made else { return false }
    tap = t
    // The tap lives on the main run loop; asked for from the ops queue, it's added there.
    let source = CFMachPortCreateRunLoopSource(nil, t, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CFRunLoopWakeUp(CFRunLoopGetMain())
    CGEvent.tapEnable(tap: t, enable: true)
    return true
}

/// Stops an action when Cavvy has stopped its token (before it started, too) or the person has used the Mac since it
/// started.
struct Guard {
    let token: String?
    let human: Int
    init(_ token: String?) {
        self.token = token
        human = humans()
    }
    func check() throws {
        humanLock.lock()
        let stop = closing || (token.map { cancelled.contains($0) } ?? false)
        let now = humanCount
        humanLock.unlock()
        if stop { throw Refusal("Stopped.", "cancelled") }
        if now != human { throw Refusal("Stopped: the user used the Mac.", "human") }
    }
}

// MARK: - Grants

func trusted(prompt: Bool) -> Bool {
    if !prompt { return AXIsProcessTrusted() }
    return AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
}

/// Acting takes watching too: an action nobody can take over doesn't go.
func needAccessibility(acting: Bool = false) throws {
    if !AXIsProcessTrusted() { throw Refusal("Accessibility isn't on.", "accessibility") }
    if !watch() && acting { throw Refusal("Not done: Cavvy Desktop Control can't watch for the user's mouse and keyboard, so it won't act.", "watch") }
}

// MARK: - Never offered

let NEVER_PATTERNS: [NSRegularExpression] = NEVER_NAME_PATTERNS.compactMap { try? NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }

func neverOffered(name: String, bundleId: String?) -> Bool {
    let id = (bundleId ?? "").lowercased()
    if id.isEmpty || id.hasPrefix("dev.cavvy") || NEVER_IDS.contains(id) { return true }
    let range = NSRange(name.startIndex..., in: name)
    return NEVER_PATTERNS.contains { $0.firstMatch(in: name, range: range) != nil }
}

/// Not an app, or one never offered, or one Cavvy runs in.
func neverOffered(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), !OWN.contains(pid) else { return true }
    return neverOffered(name: app.localizedName ?? "", bundleId: app.bundleIdentifier)
}

// MARK: - Accessibility

func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func text(_ v: CFTypeRef?) -> String? {
    guard let v else { return nil }
    if CFGetTypeID(v) == CFStringGetTypeID() { return (v as! String) }
    if CFGetTypeID(v) == CFNumberGetTypeID() || CFGetTypeID(v) == CFBooleanGetTypeID() { return (v as! NSNumber).stringValue }
    if CFGetTypeID(v) == CFAttributedStringGetTypeID() { return (v as! NSAttributedString).string }
    return nil
}

func point(_ v: CFTypeRef?) -> CGPoint? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ v: CFTypeRef?) -> CGSize? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func elements(_ v: CFTypeRef?) -> [AXUIElement] {
    guard let v, CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
    return (v as! [AnyObject]).compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
}

func flag(_ v: CFTypeRef?) -> Bool {
    guard let v, CFGetTypeID(v) == CFBooleanGetTypeID() else { return false }
    return (v as! Bool)
}

let NAMES = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXIdentifierAttribute, kAXPlaceholderValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXSelectedAttribute, kAXFocusedAttribute, kAXChildrenAttribute, kAXMinimizedAttribute] as [String]

/// Text longer than this is cut (a document's whole text is a text area's value).
let VALUE_MAX = 4000
/// At most this many elements are read from one app.
let NODES_MAX = 3000

/// An app's windows and menu bar as a tree (src/desktop/outline.ts reads it). Frames are in global points, from the
/// top left of the main display.
func describe(_ pid: pid_t) -> [String: Any] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 2)
    var count = 0
    func node(_ e: AXUIElement, _ depth: Int, menus: Bool) -> [String: Any]? {
        if count >= NODES_MAX || depth > 50 { return nil }
        count += 1
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(e, NAMES as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success, let v = values as? [AnyObject] else { return nil }
        func at(_ i: Int) -> CFTypeRef? {
            guard i < v.count else { return nil }
            let x = v[i] as CFTypeRef
            // A missing attribute comes back as an AXValue holding an error.
            if CFGetTypeID(x) == AXValueGetTypeID() && AXValueGetType(x as! AXValue) == .axError { return nil }
            return x
        }
        var n: [String: Any] = [:]
        let role = text(at(0)) ?? ""
        n["role"] = role
        if let s = text(at(1)) { n["subrole"] = s }
        if let s = text(at(2)), !s.isEmpty { n["title"] = s }
        if let s = text(at(3)), !s.isEmpty { n["label"] = s }
        if let s = text(at(4)), !s.isEmpty { n["value"] = s.count > VALUE_MAX ? String(s.prefix(VALUE_MAX)) + "…" : s }
        if let s = text(at(5)), !s.isEmpty { n["identifier"] = s }
        if let s = text(at(6)), !s.isEmpty { n["placeholder"] = s }
        if let p = point(at(7)), let s = size(at(8)) { n["frame"] = [p.x, p.y, s.width, s.height].map { Double($0) } }
        if let enabled = at(9), CFGetTypeID(enabled) == CFBooleanGetTypeID(), !(enabled as! Bool) { n["disabled"] = true }
        if flag(at(10)) { n["selected"] = true }
        if flag(at(11)) { n["focused"] = true }
        if flag(at(13)) { n["minimized"] = true }
        var kids = elements(at(12))
        // A closed menu's items are in the tree too: only an open one's are shown.
        if role == "AXMenuBarItem" && !flag(at(10)) { kids = [] }
        if role == "AXMenuBar" && !menus { kids = [] }
        if role == "AXScrollBar" || role == "AXValueIndicator" || role == "AXGrowArea" { kids = [] }
        let children = kids.compactMap { node($0, depth + 1, menus: menus) }
        if !children.isEmpty { n["children"] = children }
        return n
    }
    var root: [String: Any] = ["role": "AXApplication"]
    if let name = NSRunningApplication(processIdentifier: pid)?.localizedName { root["title"] = name }
    var kids: [[String: Any]] = []
    if let bar = attribute(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID(), let n = node(bar as! AXUIElement, 1, menus: true) { kids.append(n) }
    for w in elements(attribute(app, kAXWindowsAttribute)) where !cavvyPage(text(attribute(w, kAXTitleAttribute))) { if let n = node(w, 1, menus: false) { kids.append(n) } }
    root["children"] = kids
    root["truncated"] = count >= NODES_MAX
    return root
}

/// The app with keyboard focus, as accessibility has it (keys go there), else as the workspace has it.
func focusedPid() -> pid_t? {
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 1)
    if let v = attribute(sys, kAXFocusedApplicationAttribute), CFGetTypeID(v) == AXUIElementGetTypeID() {
        var pid: pid_t = 0
        if AXUIElementGetPid(v as! AXUIElement, &pid) == .success { return pid }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

/// On-screen windows of these apps (none of the menu bar's or the Dock's), front to back.
func windows(_ pids: Set<pid_t>) -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { w in
        guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid), let b = w[kCGWindowBounds as String] as? [String: Any] else { return nil }
        let layer = w[kCGWindowLayer as String] as? Int ?? 0
        let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
        guard layer >= 0, layer < 1000, alpha > 0.05 else { return nil }
        let frame = [b["X"], b["Y"], b["Width"], b["Height"]].map { ($0 as? Double) ?? 0 }
        guard frame[2] > 1, frame[3] > 1 else { return nil }
        return ["pid": Int(pid), "frame": frame, "layer": layer]
    }
}

/// Cavvy's own page in a browser (`cavvy gui`): its title is "Cavvy", or ends " · Cavvy". It's where the person
/// watches and stops the agent: never read, clicked or typed into, whichever browser shows it.
func cavvyPage(_ title: String?) -> Bool {
    // "(2) Cavvy": sessions waiting for the person.
    guard let t = title?.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^\(\d+\)\s*"#, with: "", options: .regularExpression) else { return false }
    return t == "Cavvy" || t.hasSuffix(" · Cavvy") || t.hasPrefix("Cavvy - ") || t.contains(" · Cavvy - ")
}

/// The window an element is in, by its title.
func windowTitle(of e: AXUIElement) -> String? {
    guard let w = attribute(e, kAXWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
    return text(attribute(w as! AXUIElement, kAXTitleAttribute))
}

/// The open and save panels of a sandboxed app (TextEdit's) are another process's windows, inside that app's tree.
let PANEL_SERVICES: Set<String> = ["com.apple.appkit.xpc.openAndSavePanelService"]

/// Whether a click at a point would reach an approved app: what the accessibility hit-test finds there is an approved
/// app's, inside one of its windows (or one of its own menus), and isn't the Apple menu.
func clickable(_ x: Double, _ y: Double, _ pids: Set<pid_t>) throws {
    let p = CGPoint(x: x, y: y)
    guard NSScreen.screens.contains(where: { globalFrame($0).contains(p) }) else { throw Refusal("\(Int(x)),\(Int(y)) is off the screen.", "outside") }
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 1)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &hit) == .success, let e = hit else { throw Refusal("Not done: what's at \(Int(x)),\(Int(y)) can't be read.", "outside") }
    var pid: pid_t = 0
    AXUIElementGetPid(e, &pid)
    guard pids.contains(pid) else { throw Refusal("Not done: \(Int(x)),\(Int(y)) isn't on an app you may use.", "outside") }
    if cavvyPage(windowTitle(of: e)) { throw Refusal("Not done: that's Cavvy's own page.", "outside") }
    // The Apple menu (shut down, log out, System Settings) is in every app's menu bar.
    var el: AXUIElement? = e
    var inMenu = false
    for _ in 0..<12 {
        guard let cur = el else { break }
        let role = text(attribute(cur, kAXRoleAttribute)) ?? ""
        if role == "AXMenuBarItem" || role == "AXMenu" || role == "AXMenuItem" { inMenu = true }
        if role == "AXMenuBarItem", let bar = attribute(cur, kAXParentAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() {
            if let first = elements(attribute(bar as! AXUIElement, kAXChildrenAttribute)).first, CFEqual(first, cur) { throw Refusal("Not done: the Apple menu isn't an app's.", "outside") }
        }
        guard let parent = attribute(cur, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
        el = (parent as! AXUIElement)
    }
    if inMenu { return }
    var owners = pids
    for app in NSWorkspace.shared.runningApplications where PANEL_SERVICES.contains(app.bundleIdentifier ?? "") { owners.insert(app.processIdentifier) }
    let inside = windows(owners).contains { w in
        let f = w["frame"] as! [Double]
        return CGRect(x: f[0], y: f[1], width: f[2], height: f[3]).contains(p)
    }
    if !inside { throw Refusal("Not done: \(Int(x)),\(Int(y)) isn't on a window of an app you may use.", "outside") }
}

/// The focused app's menu bar items, the Apple menu first.
func menuBarItems(_ app: AXUIElement) -> [AXUIElement] {
    guard let bar = attribute(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { return [] }
    return elements(attribute(bar as! AXUIElement, kAXChildrenAttribute))
}

/// Whether keys may go now: an app you may use has focus, the Apple menu isn't open (keys would choose in it), and
/// the focused window isn't Cavvy's own page. With `menus`, also whether one of the app's menus is open (read only
/// then: it's an accessibility call for each menu).
@discardableResult
func typeable(_ pids: Set<pid_t>, menus: Bool = false) throws -> Bool {
    guard let pid = focusedPid(), pids.contains(pid) else { throw Refusal("Not done: an app you may use isn't in front, so keys would go elsewhere.", "front") }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    let items = menuBarItems(app)
    if let apple = items.first, flag(attribute(apple, kAXSelectedAttribute)) { throw Refusal("Not done: the Apple menu is open, and it isn't an app's.", "outside") }
    if let w = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID(), cavvyPage(text(attribute(w as! AXUIElement, kAXTitleAttribute))) { throw Refusal("Not done: that's Cavvy's own page.", "outside") }
    return menus && items.contains { flag(attribute($0, kAXSelectedAttribute)) }
}

/// A screen's frame in global points from the top left of the main display, as CGEvents and accessibility have them.
func globalFrame(_ s: NSScreen) -> CGRect {
    let main = NSScreen.screens.first?.frame.height ?? s.frame.height
    return CGRect(x: s.frame.minX, y: main - s.frame.maxY, width: s.frame.width, height: s.frame.height)
}

// MARK: - Input

let source = CGEventSource(stateID: .privateState)

func post(_ e: CGEvent?) {
    guard let e else { return }
    e.setIntegerValueField(.eventSourceUserData, value: OURS)
    e.post(tap: .cghidEventTap)
}

func pause(_ ms: Int, _ g: Guard) throws {
    var left = ms
    while left > 0 {
        let step = min(left, 10)
        usleep(useconds_t(step * 1000))
        left -= step
        try g.check()
    }
}

func mouseTypes(_ button: String) -> (CGEventType, CGEventType, CGEventType, CGMouseButton) {
    switch button {
    case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
    case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
    }
}

func click(_ x: Double, _ y: Double, button: String, count: Int, holdMs: Int, pids: Set<pid_t>, _ g: Guard) throws {
    try g.check()
    try clickable(x, y, pids)
    let p = CGPoint(x: x, y: y)
    let (down, up, _, b) = mouseTypes(button)
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: b))
    try pause(40, g)
    for i in 1...max(1, count) {
        // Right before it's sent: what's there now.
        try clickable(x, y, pids)
        try g.check()
        let d = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: p, mouseButton: b)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(d)
        // Down, it comes up: the click is done, so it isn't stopped halfway.
        usleep(useconds_t(max(0, min(holdMs, 1000)) * 1000))
        let u = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: p, mouseButton: b)
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(u)
        if i < count { usleep(40_000) }
    }
}

func drag(from: CGPoint, to: CGPoint, durationMs: Int, pids: Set<pid_t>, _ g: Guard) throws {
    try g.check()
    try clickable(Double(from.x), Double(from.y), pids)
    try clickable(Double(to.x), Double(to.y), pids)
    let (down, up, dragged, b) = mouseTypes("left")
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: b))
    try pause(40, g)
    try clickable(Double(from.x), Double(from.y), pids)
    post(CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: from, mouseButton: b))
    var dropped = false
    // Stopped or refused: back where it started, so nothing is dropped anywhere else.
    defer {
        if !dropped {
            post(CGEvent(mouseEventSource: source, mouseType: dragged, mouseCursorPosition: from, mouseButton: b))
            post(CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: from, mouseButton: b))
        }
    }
    let steps = max(4, durationMs / 16)
    for i in 1..<steps {
        let t = Double(i) / Double(steps)
        post(CGEvent(mouseEventSource: source, mouseType: dragged, mouseCursorPosition: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), mouseButton: b))
        try pause(max(1, durationMs / steps), g)
    }
    // Right before the drop: what's there now.
    try clickable(Double(to.x), Double(to.y), pids)
    try g.check()
    post(CGEvent(mouseEventSource: source, mouseType: dragged, mouseCursorPosition: to, mouseButton: b))
    post(CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: to, mouseButton: b))
    dropped = true
}

func scroll(_ x: Double, _ y: Double, dx: Int, dy: Int, pids: Set<pid_t>, _ g: Guard) throws {
    try g.check()
    try clickable(x, y, pids)
    let p = CGPoint(x: x, y: y)
    // A wheel turns what's under the pointer.
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    try pause(40, g)
    var left = (dx, dy)
    while left.0 != 0 || left.1 != 0 {
        try clickable(x, y, pids)
        let sx = max(-3, min(3, left.0))
        let sy = max(-3, min(3, left.1))
        post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(sy), wheel2: Int32(sx), wheel3: 0))
        left = (left.0 - sx, left.1 - sy)
        try pause(30, g)
    }
}

let NAMED_KEYS: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "escape": 53,
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

/// The key that types each character on the current keyboard layout (and whether it takes Shift): so Meta+Z is the
/// key that types "z" here, wherever a layout puts it. Read on the main thread, as the input source APIs want.
func layoutKeys() -> [String: (CGKeyCode, Bool)] {
    var map: [String: (CGKeyCode, Bool)] = [:]
    guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(), let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return map }
    let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
        for shift in [false, true] {
            for code in 0..<128 {
                var dead: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let mods: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xFF) : 0
                let r = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), mods, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, 4, &length, &chars)
                if r == noErr, length > 0 {
                    let s = String(utf16CodeUnits: chars, count: length)
                    if map[s] == nil { map[s] = (CGKeyCode(code), shift) }
                }
            }
        }
    }
    return map
}

/// What each key types with Command held, on the current layout: a non-Latin layout's Command keys are Latin ones,
/// which is how shortcuts are matched there.
func commandChars() -> [CGKeyCode: String] {
    var map: [CGKeyCode: String] = [:]
    guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(), let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return map }
    let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
        for code in 0..<128 {
            var dead: UInt32 = 0
            var length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let r = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), UInt32((cmdKey >> 8) & 0xFF), UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, 4, &length, &chars)
            if r == noErr, length > 0 { map[CGKeyCode(code)] = String(utf16CodeUnits: chars, count: length).lowercased() }
        }
    }
    return map
}

var keysOfLayout: [String: (CGKeyCode, Bool)] = [:]
var commandOfKey: [CGKeyCode: String] = [:]
func refreshLayout() {
    let read = { keysOfLayout = layoutKeys(); commandOfKey = commandChars() }
    if Thread.isMainThread { read() } else { DispatchQueue.main.sync(execute: read) }
}

func flags(_ modifiers: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in modifiers {
        switch m {
        case "cmd": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt": f.insert(.maskAlternate)
        case "ctrl": f.insert(.maskControl)
        default: break
        }
    }
    return f
}

/// The key that types this character on the current layout, without Shift.
func plainKey(_ ch: String) -> CGKeyCode? {
    guard let (c, shift) = keysOfLayout[ch], !shift else { return nil }
    return c
}

/// The keys that make a character in a shortcut: where it is on this layout without Shift, where Command makes it
/// (a non-Latin layout's), and where it is on a US keyboard (`us`), which some shortcuts are matched by.
func shortcutKeys(_ ch: String, us: CGKeyCode) -> Set<CGKeyCode> {
    var keys: Set<CGKeyCode> = [us]
    if let c = plainKey(ch) { keys.insert(c) }
    for (c, s) in commandOfKey where s == ch { keys.insert(c) }
    return keys
}

/// Shortcuts no app's own, by the key and modifiers that go out: logging out, locking the screen, force quit,
/// pictures of the whole screen, and moving keyboard focus out of the app (Control-F2 to F8: the menu bar, whence keys
/// could reach the Apple menu, the Dock, the status menus).
func systemShortcut(_ code: CGKeyCode, _ f: CGEventFlags) -> Bool {
    let cmd = f.contains(.maskCommand)
    if cmd && (f.contains(.maskShift) || f.contains(.maskControl)) && shortcutKeys("q", us: 12).contains(code) { return true }
    if cmd && f.contains(.maskAlternate) && code == 53 { return true }
    let shots: [(String, CGKeyCode)] = [("3", 20), ("4", 21), ("5", 23), ("6", 22)]
    if cmd && f.contains(.maskShift) && shots.contains(where: { shortcutKeys($0.0, us: $0.1).contains(code) }) { return true }
    if f.contains(.maskControl) && [120, 99, 118, 96, 97, 98, 100].contains(code) { return true }
    return false
}

/// One of the Apple menu's own shortcuts, by key and modifiers, in the app that has focus.
func appleMenuShortcut(_ code: CGKeyCode, _ f: CGEventFlags, _ pid: pid_t) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    guard let apple = menuBarItems(app).first, let menu = elements(attribute(apple, kAXChildrenAttribute)).first else { return false }
    for item in elements(attribute(menu, kAXChildrenAttribute)) {
        guard let ch = text(attribute(item, kAXMenuItemCmdCharAttribute))?.lowercased(), keysOfLayout[ch]?.0 == code || commandOfKey[code] == ch else { continue }
        // kAXMenuItemModifier: Shift 1, Option 2, Control 4, no Command 8.
        let m = Int(text(attribute(item, kAXMenuItemCmdModifiersAttribute)) ?? "0") ?? 0
        if f.contains(.maskCommand) == (m & 8 == 0) && f.contains(.maskShift) == (m & 1 != 0) && f.contains(.maskAlternate) == (m & 2 != 0) && f.contains(.maskControl) == (m & 4 != 0) { return true }
    }
    return false
}

func press(_ key: String, modifiers: [String], pids: Set<pid_t>, _ g: Guard) throws {
    var code: CGKeyCode
    var extra: CGEventFlags = []
    if let named = NAMED_KEYS[key.lowercased()] {
        code = named
        if key.lowercased().hasPrefix("arrow") { extra = [.maskNumericPad, .maskSecondaryFn] }
    } else {
        refreshLayout()
        guard let (c, shift) = keysOfLayout[key] else { throw Refusal("There's no key for \"\(key)\" on this keyboard layout.") }
        code = c
        // A character typed with Shift ("!", "?") takes it.
        if shift { extra.insert(.maskShift) }
    }
    let f = flags(modifiers).union(extra)
    if systemShortcut(code, f) || (focusedPid().map { appleMenuShortcut(code, f, $0) } ?? false) { throw Refusal("Not done: that shortcut is the system's, not the app's.", "system") }
    // Checked before the key goes: once it's down, it's pressed.
    try g.check()
    // Left and right move between open menus, round to the Apple menu: a menu is clicked instead.
    if try typeable(pids, menus: code == 123 || code == 124), code == 123 || code == 124 { throw Refusal("Not done: with a menu open, moving between menus could reach the Apple menu. Click the menu instead.", "outside") }
    let d = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    d?.flags = f
    post(d)
    usleep(20_000)
    let u = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    u?.flags = f
    post(u)
}

/// Types text as characters (whatever the layout), a key at a time, each only while an approved app has focus.
/// Returns how many characters went.
func typeText(_ s: String, gapMs: Int, pids: Set<pid_t>, _ g: Guard) throws -> Int {
    var sent = 0
    // What was typed before a stop is said with it (code "human:12").
    func stop(_ r: Refusal) -> Refusal { sent > 0 ? Refusal(r.message, r.code + ":\(sent)") : r }
    for ch in s {
        do {
            try g.check()
            try typeable(pids)
        } catch let r as Refusal {
            throw stop(r)
        }
        if ch == "\n" || ch == "\r\n" || ch == "\t" {
            let code: CGKeyCode = ch == "\t" ? 48 : 36
            post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true))
            post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false))
        } else {
            let units = Array(String(ch).utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.flags = []
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                post(e)
            }
        }
        sent += 1
        do {
            try pause(gapMs, g)
        } catch let r as Refusal {
            throw stop(r)
        }
    }
    return sent
}

// MARK: - Apps

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    var o: [String: Any] = ["pid": Int(app.processIdentifier), "name": app.localizedName ?? "", "hidden": app.isHidden]
    if let id = app.bundleIdentifier { o["bundleId"] = id }
    if let url = app.bundleURL { o["path"] = url.path }
    return o
}

func running() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
}

/// The processes that started this one, up to launchd: Cavvy, and the terminal it may run in.
func ancestors() -> [Int] {
    var out: [Int] = []
    var pid = getppid()
    while pid > 1 && out.count < 30 {
        out.append(Int(pid))
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { break }
        pid = info.kp_eproc.e_ppid
    }
    return out
}

let APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications", "/System/Library/CoreServices/Applications"]

/// Whether macOS knows the app with this bundle id to be the one at `url`: a copy elsewhere (a folder in a repository)
/// claiming another app's bundle id isn't it, and is never found.
func canonical(_ url: URL?, _ id: String?) -> Bool {
    guard let url, let id, let known = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return false }
    return known.resolvingSymlinksInPath().standardizedFileURL.path == url.resolvingSymlinksInPath().standardizedFileURL.path
}

/// An app by its name or bundle id: a running one first, then one installed in the usual folders. Only an app macOS
/// knows by its bundle id, so the name the person is asked about is the app's that's given.
func find(_ name: String) -> [String: Any]? {
    let want = name.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\.app/?$"#, with: "", options: [.regularExpression, .caseInsensitive]).lowercased()
    for app in running() where (app.localizedName?.lowercased() == want || app.bundleIdentifier?.lowercased() == want) && canonical(app.bundleURL, app.bundleIdentifier) {
        var o = appInfo(app)
        o["running"] = true
        return o
    }
    var url: URL?
    if want.contains("."), let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: want) { url = u }
    if url == nil {
        outer: for dir in APP_DIRS {
            guard let items = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
            for item in items where item.lowercased().hasSuffix(".app") {
                let path = dir + "/" + item
                let shown = FileManager.default.displayName(atPath: path).replacingOccurrences(of: #"\.app$"#, with: "", options: .regularExpression).lowercased()
                if String(item.dropLast(4)).lowercased() == want || shown == want {
                    url = URL(fileURLWithPath: path)
                    break outer
                }
            }
        }
    }
    guard let u = url, let id = Bundle(url: u)?.bundleIdentifier, canonical(u, id) else { return nil }
    let shown = FileManager.default.displayName(atPath: u.path).replacingOccurrences(of: #"\.app$"#, with: "", options: .regularExpression)
    return ["name": shown.isEmpty ? u.deletingPathExtension().lastPathComponent : shown, "bundleId": id, "path": u.path, "running": false]
}

/// Brings an app to the front, starting it if it isn't running. Returns its pid once it has focus (or after 5 seconds).
func open(_ bundleId: String) throws -> [String: Any] {
    let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
    let named = installed.map { FileManager.default.displayName(atPath: $0.path) } ?? ""
    if neverOffered(name: named, bundleId: bundleId) { throw Refusal("Not done: that app is never offered.", "never") }
    var app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
    if let a = app, neverOffered(a.processIdentifier) { throw Refusal("Not done: that app is never offered.", "never") }
    if let a = app {
        if a.isHidden { a.unhide() }
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(a.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        a.activate()
    } else {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { throw Refusal("That app isn't on this Mac any more.") }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        NSWorkspace.shared.openApplication(at: url, configuration: config) { a, e in
            app = a
            failure = e
            done.signal()
        }
        if done.wait(timeout: .now() + 20) == .timedOut { throw Refusal("The app didn't start in time.") }
        if let e = failure { throw Refusal("The app couldn't start: \(e.localizedDescription)") }
    }
    guard let a = app else { throw Refusal("The app couldn't start.") }
    let end = Date().addingTimeInterval(5)
    var front = false
    while Date() < end {
        if focusedPid() == a.processIdentifier { front = true; break }
        usleep(100_000)
    }
    var o = appInfo(a)
    o["front"] = front
    return o
}

// MARK: - Screenshots

/// A picture of the approved apps' windows on the display that has most of them, cut to them, at one pixel a point.
/// Nothing else on the screen is in it: other windows are left out, not covered.
func screenshot(_ pids: Set<pid_t>) throws -> [String: Any] {
    if !CGPreflightScreenCaptureAccess() { throw Refusal("Screen Recording isn't on.", "screen") }
    let done = DispatchSemaphore(value: 0)
    var result: Result<[String: Any], Error> = .failure(Refusal("No picture."))
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let wins = content.windows.filter { w in
                guard let owner = w.owningApplication else { return false }
                return pids.contains(owner.processID) && !cavvyPage(w.title) && w.isOnScreen && w.windowLayer >= 0 && w.windowLayer < 1000 && w.frame.width > 1 && w.frame.height > 1
            }
            guard !wins.isEmpty else { throw Refusal("No window of an app you may use is on the screen.", "nowindow") }
            func area(_ d: SCDisplay) -> CGFloat { wins.reduce(0) { a, w in let r = w.frame.intersection(d.frame); return a + (r.isNull ? 0 : r.width * r.height) } }
            guard let display = content.displays.max(by: { area($0) < area($1) }) else { throw Refusal("No display.") }
            let on = wins.filter { $0.frame.intersects(display.frame) }
            let union = on.reduce(CGRect.null) { $0.union($1.frame) }.intersection(display.frame)
            let filter = SCContentFilter(display: display, including: on)
            let config = SCStreamConfiguration()
            config.sourceRect = union.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            config.width = Int(union.width.rounded())
            config.height = Int(union.height.rounded())
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let rep = NSBitmapImageRep(cgImage: image)
            guard let png = rep.representation(using: .png, properties: [:]) else { throw Refusal("The picture couldn't be made.") }
            result = .success(["png": png.base64EncodedString(), "x": Double(union.minX), "y": Double(union.minY), "width": image.width, "height": image.height])
        } catch {
            result = .failure(error)
        }
        done.signal()
    }
    if done.wait(timeout: .now() + 15) == .timedOut { throw Refusal("The picture took too long.") }
    switch result {
    case .success(let o): return o
    case .failure(let e):
        if let r = e as? Refusal { throw r }
        throw Refusal("The picture couldn't be taken: \(e.localizedDescription)")
    }
}

// MARK: - Commands

/// The apps a command may reach, without any that's never offered, whatever it was sent.
func pidsOf(_ cmd: [String: Any]) -> Set<pid_t> {
    Set((cmd["pids"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.int32Value }.filter { !neverOffered($0) })
}

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func handle(_ cmd: [String: Any]) throws -> [String: Any] {
    let op = cmd["op"] as? String ?? ""
    let pids = pidsOf(cmd)
    // Made as the command is taken up: a cancel that came first stops it.
    let g = Guard(cmd["token"] as? String)
    switch op {
    case "status":
        let ax = trusted(prompt: cmd["ask"] as? String == "accessibility")
        if cmd["ask"] as? String == "screen" && !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        return ["accessibility": ax, "screen": CGPreflightScreenCaptureAccess(), "watching": ax && watch(), "pid": Int(getpid()), "path": Bundle.main.executablePath ?? ""]
    case "apps":
        let front = focusedPid()
        return ["apps": running().map { a -> [String: Any] in var o = appInfo(a); o["front"] = a.processIdentifier == front; return o }, "ancestors": ancestors()]
    case "find":
        guard let found = find(cmd["name"] as? String ?? "") else { return ["found": false, "ancestors": ancestors()] }
        return ["found": true, "app": found, "ancestors": ancestors()]
    case "open":
        try needAccessibility()
        return try open(cmd["bundleId"] as? String ?? "")
    case "look":
        try needAccessibility()
        let front = focusedPid()
        var o: [String: Any] = ["front": Int(front ?? 0), "windows": windows(pids)]
        if let pid = num(cmd["pid"]) {
            guard pids.contains(pid_t(pid)) else { throw Refusal("Not done: that app isn't one this command may read.", "outside") }
            o["tree"] = describe(pid_t(pid))
        }
        return o
    case "front":
        return ["front": Int(focusedPid() ?? 0)]
    case "click":
        try needAccessibility(acting: true)
        try click(num(cmd["x"]) ?? 0, num(cmd["y"]) ?? 0, button: cmd["button"] as? String ?? "left", count: Int(num(cmd["count"]) ?? 1), holdMs: Int(num(cmd["holdMs"]) ?? 50), pids: pids, g)
        return [:]
    case "drag":
        try needAccessibility(acting: true)
        try drag(from: CGPoint(x: num(cmd["x"]) ?? 0, y: num(cmd["y"]) ?? 0), to: CGPoint(x: num(cmd["toX"]) ?? 0, y: num(cmd["toY"]) ?? 0), durationMs: Int(num(cmd["durationMs"]) ?? 300), pids: pids, g)
        return [:]
    case "scroll":
        try needAccessibility(acting: true)
        try scroll(num(cmd["x"]) ?? 0, num(cmd["y"]) ?? 0, dx: Int(num(cmd["dx"]) ?? 0), dy: Int(num(cmd["dy"]) ?? 0), pids: pids, g)
        return [:]
    case "press":
        try needAccessibility(acting: true)
        try press(cmd["key"] as? String ?? "", modifiers: cmd["modifiers"] as? [String] ?? [], pids: pids, g)
        return [:]
    case "type":
        try needAccessibility(acting: true)
        return ["sent": try typeText(cmd["text"] as? String ?? "", gapMs: Int(num(cmd["gapMs"]) ?? 8), pids: pids, g)]
    case "screenshot":
        return try screenshot(pids)
    default:
        throw Refusal("Unknown command \(op)")
    }
}

let ops = DispatchQueue(label: "cavvy.desktop.ops")

refreshLayout()
let ready = AXIsProcessTrusted()
send(["event": "ready", "accessibility": ready, "screen": CGPreflightScreenCaptureAccess(), "watching": ready && watch(), "pid": Int(getpid())])
// Said first: commands are read only once it's out.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8), let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        if cmd["op"] as? String == "cancel" {
            if let token = cmd["token"] as? String {
                humanLock.lock()
                if cancelled.count > 1000 { cancelled.removeAll() }
                cancelled.insert(token)
                humanLock.unlock()
            }
            continue
        }
        let id = cmd["id"] ?? NSNull()
        ops.async {
            var reply: [String: Any]
            do {
                reply = try handle(cmd)
            } catch let r as Refusal {
                reply = ["error": r.message, "code": r.code]
            } catch {
                reply = ["error": "\(error)"]
            }
            reply["id"] = id
            reply["human"] = humans()
            reply["used"] = used(pidsOf(cmd))
            send(reply)
        }
    }
    // Cavvy has gone: what's under way stops (a held button comes up) before the helper does.
    humanLock.lock()
    closing = true
    humanLock.unlock()
    ops.sync {}
    exit(0)
}

CFRunLoopRun()
